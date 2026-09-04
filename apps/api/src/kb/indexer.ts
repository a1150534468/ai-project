import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DEFAULT_EMBEDDING_DIMENSION } from '../memory/embedding-client.js';

/**
 * 解析异常：文本为空或仅空白
 * 由 parse 依赖返回，indexer 捕获后视为可恢复的失败（不重试）
 */
export class EmptyTextError extends Error {
  constructor(message: string = '未能提取文本（疑似扫描件，暂不支持 OCR）') {
    super(message);
    this.name = 'EmptyTextError';
  }
}

/**
 * Deterministic input/structure failures cannot be repaired by running the
 * same index job again. Keep them out of the reaper retry loop.
 */
class PermanentIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentIndexError';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function configuredMaxAttempts(override?: number): number {
  const fromEnv = Number.parseInt(process.env.KB_MAX_ATTEMPTS ?? '3', 10);
  return positiveInteger(override, positiveInteger(fromEnv, 3));
}

function upstreamStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const raw = candidate.status ?? candidate.statusCode ?? candidate.$metadata?.httpStatusCode;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;

  const message = error instanceof Error ? error.message : '';
  const match = message.match(/^HTTP\s+(\d{3})(?:\D|$)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Unknown failures get a bounded retry because storage, network, embedding and
 * database clients often surface transport failures as a plain Error. Known bad
 * input is terminal immediately, while HTTP client errors are terminal except
 * for the conventional transient status codes.
 */
function isRetryableIndexError(error: unknown): boolean {
  if (error instanceof PermanentIndexError || error instanceof EmptyTextError) return false;
  if (error instanceof Error && ['EmptyTextError', 'SsrfError'].includes(error.name)) return false;

  const status = upstreamStatus(error);
  if (status !== null) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (
    message.startsWith('不支持的文件类型：') ||
    message.startsWith('Unknown sourceType:') ||
    message.startsWith('Document not found:') ||
    message.startsWith('Redirect target blocked:') ||
    message.startsWith('Too many redirects') ||
    message.startsWith('Response exceeds max size')
  ) {
    return false;
  }

  return true;
}

/**
 * 向量转 pgvector 字面量 "[a,b,c]"
 * 包含有效性校验：维度检查 + 数值有效性
 */
function toVectorLiteral(v: number[], expectedDimension: number): string {
  if (!Array.isArray(v) || v.length !== expectedDimension) {
    throw new PermanentIndexError(`Invalid embedding dimension: expected ${expectedDimension}, got ${v.length}`);
  }
  if (!v.every((n) => typeof n === 'number' && isFinite(n))) {
    throw new PermanentIndexError('Embedding contains non-finite or NaN values');
  }
  return `[${v.join(',')}]`;
}

function fallbackEmbeddingTokens(input: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(input || ' ', 'utf8') / 3));
}

/**
 * 索引器依赖注入接口（便于测试）
 */
export interface IndexDeps {
  prisma: PrismaClient;
  /**
   * 加载文档内容（FILE/URL/TEXT）
   * loadObject 由调用方注入，indexer 不直接耦合 S3/fetch
   *
   * P5.2 之前这里还有第四个字段 `content`：产物文档不落 S3，正文内联在
   * `Document.content` 里，由 `deps.ts` 的 ARTIFACT 分支读回来。产物不再进知识库，
   * 那一列已随本项删掉，三种来源现在都靠 `sourceUri` 定位内容。
   */
  loadObject: (doc: { sourceType: string; sourceUri: string | null }) => Promise<{
    buf: Buffer;
    mime: string;
    filename: string;
  }>;
  /**
   * 解析为文本（可能抛 EmptyTextError）
   */
  parse: (buf: Buffer, mime: string, filename: string) => Promise<string>;
  /**
   * 分块（包含 env 配置：maxTokens, overlapTokens, maxChunks）
   */
  chunk: (text: string) => string[];
  /**
   * 嵌入单个块，返回向量 + token 数
   */
  embed: (input: string) => Promise<{ vector: number[]; tokens: number }>;
  /** 向量维度，必须与数据库 vector(N) 一致。 */
  embeddingDimension?: number;
  /**
   * 工作者 ID（用于分布式锁）
   */
  workerId: string;
  /**
   * 用于测试的时间函数
   */
  now?: () => Date;
}

export interface IndexOnceOptions {
  /** Override the shared KB_MAX_ATTEMPTS value (primarily for reaper/tests). */
  maxAttempts?: number;
}

/**
 * 原子抢占文档（防重复索引）
 *
 * 返回 true 如果成功抢占，false 如果已被他人锁定或非 pending/indexing 状态。
 * 使用 $executeRaw 的返回行数判定。
 *
 * @param prisma Prisma 客户端
 * @param docId 文档 ID
 * @param workerId 工作者 ID
 * @param leaseMs 锁超时时间（毫秒）
 */
export async function claim(
  prisma: PrismaClient,
  docId: string,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const now = new Date();
  const timeoutAgo = new Date(now.getTime() - leaseMs);

  const rows = await prisma.$executeRaw<number>`
    UPDATE "Document"
    SET
      status = 'indexing',
      "lockedBy" = ${workerId},
      "lockedAt" = ${now},
      attempts = attempts + 1
    WHERE
      id = ${docId}
      AND (
        status = 'pending'
        OR (
          status = 'indexing'
          AND "lockedAt" < ${timeoutAgo}
        )
      )
  `;

  return rows === 1;
}

/**
 * 单次索引流程
 *
 * 步骤：
 * 1. claim 抢占文档
 * 2. 读 Document
 * 3. loadObject 拿 buf/mime/filename
 * 4. parse 解析到文本
 * 5. chunk 分块
 * 6. 并发 embed（上限 KB_EMBED_CONCURRENCY）
 * 7. 事务内：delete 旧 Chunk + 用 raw SQL 插入新 Chunk
 * 8. 置 status='indexed'
 *
 * 失败分支：
 * - 确定性的输入/结构错误立即 failed；
 * - 瞬时错误在 attempts < maxAttempts 时回到 pending，交 reaper 重试；
 * - 瞬时错误耗尽次数后 failed。
 */
export async function indexOnce(
  deps: IndexDeps,
  docId: string,
  options: IndexOnceOptions = {},
): Promise<void> {
  const prisma = deps.prisma;
  const maxAttempts = configuredMaxAttempts(options.maxAttempts);

  // 1. claim 抢占
  const leaseMs = parseInt(process.env.KB_INDEX_LEASE_MS ?? '300000', 10);
  if (!(await claim(prisma, docId, deps.workerId, leaseMs))) {
    return; // 没抢到，别人在做
  }

  try {
    // 2. 读 Document
    const doc = await prisma.document.findUnique({
      where: { id: docId },
    });

    if (!doc) {
      throw new Error(`Document not found: ${docId}`);
    }

    // 3. loadObject 拿内容
    const { buf, mime, filename } = await deps.loadObject({
      sourceType: doc.sourceType,
      sourceUri: doc.sourceUri,
    });

    // 4. parse 解析
    const text = await deps.parse(buf, mime, filename);

    // 5. chunk 分块
    const chunks = deps.chunk(text);

    if (chunks.length === 0) {
      throw new PermanentIndexError('No chunks after splitting');
    }

    // 6. 并发 embed（简单分批）
    const concurrency = parseInt(process.env.KB_EMBED_CONCURRENCY ?? '4', 10);
    const embeds: Array<{ vector: number[]; tokens: number }> = [];
    let totalTokens = 0;

    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const results = await Promise.all(batch.map((chunk) => deps.embed(chunk)));
      embeds.push(...results);
      totalTokens += results.reduce((sum, r, idx) => sum + Math.max(r.tokens, fallbackEmbeddingTokens(batch[idx])), 0);
    }

    // 7. 事务内写入：先删旧 chunk，再插新 chunk
    await prisma.$transaction(async (tx) => {
      // 删除该 doc 的旧 chunks（幂等）
      await tx.chunk.deleteMany({
        where: { documentId: docId },
      });

      // 用 raw SQL 插入向量数据（Prisma 不支持 vector 类型的 create）
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "Chunk" (
            id,
            "documentId",
            "kbId",
            ordinal,
            content,
            embedding,
            "createdAt"
          )
          VALUES (
            ${chunkId},
            ${docId},
            ${doc.kbId},
            ${i},
            ${chunks[i]},
            ${toVectorLiteral(
              embeds[i].vector,
              deps.embeddingDimension ?? DEFAULT_EMBEDDING_DIMENSION,
            )}::vector,
            now()
          )
        `;
      }
    });

    // 8. 置 indexed
    await prisma.document.update({
      where: { id: docId },
      data: {
        status: 'indexed',
        chunkCount: chunks.length,
        tokensUsed: totalTokens,
        lockedBy: null,
        lockedAt: null,
        error: null,
      },
    });
  } catch (err) {
    const errorMsg =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Unknown error';
    const doc = await prisma.document.findUnique({
      where: { id: docId },
    });

    // 文档可能在索引过程中被用户删除；没有终态需要再写。
    if (!doc) return;

    const retryable = isRetryableIndexError(err);
    const willRetry = retryable && doc.attempts < maxAttempts;

    await prisma.document.update({
      where: { id: docId },
      data: {
        status: willRetry ? 'pending' : 'failed',
        error: errorMsg,
        lockedBy: null,
        lockedAt: null,
      },
    });
  }
}
