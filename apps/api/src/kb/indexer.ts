import { getPrisma } from '@ai-assistant/db';
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
 * 向量转 pgvector 字面量 "[a,b,c]"
 * 包含有效性校验：维度检查 + 数值有效性
 */
function toVectorLiteral(v: number[], expectedDimension: number): string {
  if (!Array.isArray(v) || v.length !== expectedDimension) {
    throw new Error(`Invalid embedding dimension: expected ${expectedDimension}, got ${v.length}`);
  }
  if (!v.every((n) => typeof n === 'number' && isFinite(n))) {
    throw new Error('Embedding contains non-finite or NaN values');
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
   */
  loadObject: (doc: { sourceType: string; sourceUri: string | null; content: string | null }) => Promise<{
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
  /**
   * 计费客户端
   */
  billing: {
    settle: (arg: {
      operationId: string;
      userId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
    }) => Promise<unknown>;
  };
  /**
   * 嵌入模型名（用于计费）
   */
  embeddingModel: string;
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
 * 2. 读 Document + KnowledgeBase（获取 ownerType/userId）
 * 3. loadObject 拿 buf/mime/filename
 * 4. parse 解析到文本
 * 5. chunk 分块
 * 6. 并发 embed（上限 KB_EMBED_CONCURRENCY）
 * 7. 事务内：delete 旧 Chunk + 用 raw SQL 插入新 Chunk
 * 8. 计费 settle（仅 USER 库）
 * 9. 置 status='indexed'
 *
 * 失败分支：catch 任何错误 → 置 status='failed' + error + 全额退款（仅 USER 库）
 */
export async function indexOnce(deps: IndexDeps, docId: string): Promise<void> {
  const prisma = deps.prisma;

  // 1. claim 抢占
  const leaseMs = parseInt(process.env.KB_INDEX_LEASE_MS ?? '300000', 10);
  if (!(await claim(prisma, docId, deps.workerId, leaseMs))) {
    return; // 没抢到，别人在做
  }

  try {
    // 2. 读 Document + KnowledgeBase
    const doc = await prisma.document.findUnique({
      where: { id: docId },
      include: { kb: true },
    });

    if (!doc) {
      throw new Error(`Document not found: ${docId}`);
    }

    const kb = doc.kb;

    // 3. loadObject 拿内容
    const { buf, mime, filename } = await deps.loadObject({
      sourceType: doc.sourceType,
      sourceUri: doc.sourceUri,
      content: doc.content,
    });

    // 4. parse 解析
    const text = await deps.parse(buf, mime, filename);

    // 5. chunk 分块
    const chunks = deps.chunk(text);

    if (chunks.length === 0) {
      throw new Error('No chunks after splitting');
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

    // 8. 计费 settle（仅 USER 库）
    // 自动归档产物是平台能力，不重复向用户收取知识库索引费用。
    if (kb.ownerType === 'USER' && kb.userId && !doc.sourceModule) {
      try {
        await deps.billing.settle({
          operationId: doc.opId ?? docId,
          userId: kb.userId,
          model: deps.embeddingModel,
          inputTokens: totalTokens,
          outputTokens: 0,
        });
      } catch (settleErr) {
        // 计费失败视为严重异常，重新置为 failed 并全额退款
        // 然后重新抛出让 reaper 按 attempts 重试
        await prisma.document.update({
          where: { id: docId },
          data: {
            status: 'failed',
            error: `Billing settlement failed: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`,
            lockedBy: null,
          },
        });
        throw settleErr;
      }
    }

    // 9. 置 indexed
    await prisma.document.update({
      where: { id: docId },
      data: {
        status: 'indexed',
        chunkCount: chunks.length,
        tokensUsed: totalTokens,
        lockedBy: null,
        error: null,
      },
    });
  } catch (err) {
    // 失败分支：置 failed + 保存错误信息
    const errorMsg =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Unknown error';

    await prisma.document.update({
      where: { id: docId },
      data: {
        status: 'failed',
        error: errorMsg,
        lockedBy: null,
      },
    });

    // 全额退款（仅 USER 库）
    const doc = await prisma.document.findUnique({
      where: { id: docId },
      include: { kb: true },
    });

    if (doc && doc.kb.ownerType === 'USER' && doc.kb.userId) {
      try {
        await deps.billing.settle({
          operationId: doc.opId ?? docId,
          userId: doc.kb.userId,
          model: deps.embeddingModel,
          inputTokens: 0,
          outputTokens: 0,
        });
      } catch (refundErr) {
        // 退款失败：记录但继续（不重新抛，让 reaper 根据 attempts 重试索引）
        // 注：此时 Document 已经 status=failed，下次重试会再次尝试退款
      }
    }

    // 不要再抛（让 reaper 按 attempts 重试）
  }
}
