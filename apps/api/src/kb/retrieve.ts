import type { PrismaClient } from "@prisma/client";

/**
 * 解析会话有效挂载的知识库集合（防越权）
 *
 * 规则：
 * - own = 用户自己的全部 KB id（ownerType="USER" && userId=本用户）
 * - effective = (kbAttachAllOwn ? own : (attachedKbIds ∩ own)) ∪ (attachedKbIds ∩ OFFICIAL)
 *   即：attachedKbIds 中只保留"属于本人的"或"ownerType=OFFICIAL 的"，他人 id 一律剔除
 * - 去重返回
 *
 * @param prisma Prisma 客户端
 * @param userId 用户 ID
 * @param sel 选择参数：{ attachedKbIds?: string[], kbAttachAllOwn?: boolean }
 * @returns 有效 KB ID 数组（去重）
 */
export async function resolveEffectiveKbIds(
  prisma: PrismaClient,
  userId: string,
  sel: { attachedKbIds?: string[]; kbAttachAllOwn?: boolean }
): Promise<string[]> {
  // 查询用户自己的所有 KB
  const userOwn = await prisma.knowledgeBase.findMany({
    where: {
      ownerType: "USER",
      userId,
    },
    select: { id: true },
  });

  const ownIds = new Set(userOwn.map((kb) => kb.id));

  // 如果既无 attachedKbIds 也无 kbAttachAllOwn，返回空集
  if (!sel.attachedKbIds || sel.attachedKbIds.length === 0) {
    if (sel.kbAttachAllOwn) {
      return Array.from(ownIds);
    }
    return [];
  }

  // 查询 attachedKbIds 中的 KB，过滤出"属于本人"或"OFFICIAL"的
  const attached = await prisma.knowledgeBase.findMany({
    where: {
      id: { in: sel.attachedKbIds },
    },
    select: { id: true, ownerType: true, userId: true },
  });

  const validAttachedIds = new Set<string>();
  for (const kb of attached) {
    // 保留"属于本人的"或"OFFICIAL"的 KB，他人 KB 一律剔除
    if (kb.ownerType === "OFFICIAL" || (kb.userId === userId && kb.ownerType === "USER")) {
      validAttachedIds.add(kb.id);
    }
  }

  // 根据 kbAttachAllOwn 组合结果
  const result = new Set<string>();

  if (sel.kbAttachAllOwn) {
    // 包含用户的所有 KB + attachedKbIds 中有效的 KB
    for (const id of ownIds) {
      result.add(id);
    }
  } else {
    // 只包含 attachedKbIds 与用户 own 的交集
    for (const id of validAttachedIds) {
      if (ownIds.has(id)) {
        result.add(id);
      }
    }
  }

  // 再加上 attachedKbIds 中的 OFFICIAL KB
  for (const id of validAttachedIds) {
    const isOfficial = attached.find((kb) => kb.id === id)?.ownerType === "OFFICIAL";
    if (isOfficial) {
      result.add(id);
    }
  }

  return Array.from(result);
}

export interface RetrievedChunk {
  content: string;
  docName: string;
  ordinal: number;
  score: number;
}

export interface KbRelevanceOptions {
  minScore: number;
  maxChunks: number;
  maxChunksPerDocument: number;
}

export interface KbCitation {
  docName: string;
  ordinal: number;
}

const LOW_INFORMATION_QUERIES = new Set([
  "hi",
  "hello",
  "hey",
  "你好",
  "您好",
  "在吗",
  "谢谢",
  "感谢",
  "ok",
  "好的",
]);

export function shouldRetrieveKbForQuery(query: string): boolean {
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return false;
  const compact = normalized.replace(/[，。！？!?.,\s]/g, "");
  if (LOW_INFORMATION_QUERIES.has(compact)) return false;
  return compact.length >= 2;
}

export function filterRelevantChunks(
  chunks: readonly RetrievedChunk[],
  options: KbRelevanceOptions,
): RetrievedChunk[] {
  const perDocument = new Map<string, number>();
  const result: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.score < options.minScore) continue;
    const current = perDocument.get(chunk.docName) ?? 0;
    if (current >= options.maxChunksPerDocument) continue;
    perDocument.set(chunk.docName, current + 1);
    result.push(chunk);
    if (result.length >= options.maxChunks) break;
  }
  return result;
}

export function dedupeKbCitations(chunks: readonly RetrievedChunk[]): KbCitation[] {
  const seen = new Set<string>();
  const result: KbCitation[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.docName)) continue;
    seen.add(chunk.docName);
    result.push({ docName: chunk.docName, ordinal: chunk.ordinal });
  }
  return result;
}

/**
 * 从知识库检索相关分块（按向量余弦距离）
 *
 * 规则：
 * - 使用 pgvector 余弦距离：1 - (embedding <=> vector)
 * - 只检索 indexed 文档的块（规避 failed/pending 文档的孤儿块）
 * - 按距离排序，返回 topK
 * - kbIds 为空直接返回 []
 *
 * @param prisma Prisma 客户端
 * @param kbIds 知识库 ID 数组
 * @param vector 查询向量（默认 1024 维，与 EMBEDDING_DIM 一致）
 * @param topK 返回数量上限
 * @returns 检索结果数组
 */
export async function retrieveChunks(
  prisma: PrismaClient,
  kbIds: string[],
  vector: number[],
  topK: number
): Promise<RetrievedChunk[]> {
  // kbIds 为空直接返回空集（不查库）
  if (!kbIds || kbIds.length === 0) {
    return [];
  }

  // 向量格式化为 pgvector 语法
  const vecLiteral = `[${vector.join(",")}]`;

  // 查询：JOIN Document 确保只检索 indexed 文档的块
  const rows = await prisma.$queryRawUnsafe<
    Array<{ content: string; docName: string; ordinal: number; score: number }>
  >(
    `SELECT c.content, d.name AS "docName", c.ordinal, 1 - (c.embedding <=> $1::vector) AS score
     FROM "Chunk" c
     JOIN "Document" d ON d.id = c."documentId"
     WHERE c."kbId" = ANY($2) AND d.status = $3
     ORDER BY c.embedding <=> $1::vector
     LIMIT $4`,
    vecLiteral,
    kbIds,
    "indexed",
    topK
  );

  return rows;
}
