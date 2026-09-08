import type { PrismaClient } from "@prisma/client";
import { validateEmbeddingVector } from "../memory/embedding-client.js";

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

type KnowledgeBaseReader = Pick<PrismaClient, "knowledgeBase">;
type VectorQueryClient = Pick<PrismaClient, "$queryRawUnsafe">;
type KnowledgeBaseOwner = { id: string; ownerType: string; userId: string | null };

const EMPTY_TALK = new Set(["hi", "hello", "hey", "你好", "您好", "在吗", "谢谢", "感谢", "ok", "好的"]);

/**
 * 只相信数据库里的 ownerType/userId，不相信会话里缓存或客户端送来的 id。
 *
 * attach-all 只展开当前用户自己的库；官方库仍然必须显式选择，否则一个布尔值就会
 * 悄悄挂上所有官方内容。两者最后做集合并集，顺便消掉客户端重复提交的 id。
 */
export async function resolveEffectiveKbIds(
  prisma: KnowledgeBaseReader,
  userId: string,
  selection: { attachedKbIds?: string[]; kbAttachAllOwn?: boolean },
): Promise<string[]> {
  const requested = selection.attachedKbIds ?? [];
  const own = await prisma.knowledgeBase.findMany({
    where: { ownerType: "USER", userId },
    select: { id: true },
  });
  if (!selection.kbAttachAllOwn && requested.length === 0) return [];

  const attached: KnowledgeBaseOwner[] = requested.length > 0
    ? await prisma.knowledgeBase.findMany({
      where: {
        id: { in: requested },
        OR: [{ ownerType: "OFFICIAL" }, { ownerType: "USER", userId }],
      },
      select: { id: true, ownerType: true, userId: true },
    })
    : [];

  const effective = new Set<string>();
  if (selection.kbAttachAllOwn) {
    for (const { id } of own) effective.add(id);
  } else {
    for (const kb of attached) {
      if (kb.ownerType === "USER" && kb.userId === userId) effective.add(kb.id);
    }
  }
  for (const kb of attached) {
    if (kb.ownerType === "OFFICIAL") effective.add(kb.id);
  }
  return [...effective];
}

function compactQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase().replace(/[，。！？!?.,\s]/g, "");
}

/** 短寒暄不值得调用 embedding；其余仍按旧口径用 UTF-16 长度判定。 */
export function shouldRetrieveKbForQuery(query: string): boolean {
  const compact = compactQuery(query);
  return compact.length >= 2 && !EMPTY_TALK.has(compact);
}

/**
 * SQL 已按相关度排序；这里不能重新排序，只做阈值与多样性裁剪。
 * 文档身份暂时只有 docName，因此同名文档共享配额是既有 API 限制，不在 C5 扩字段。
 */
export function filterRelevantChunks(
  chunks: readonly RetrievedChunk[],
  options: KbRelevanceOptions,
): RetrievedChunk[] {
  if (options.maxChunks <= 0 || options.maxChunksPerDocument <= 0) return [];

  const accepted: RetrievedChunk[] = [];
  const countByDocument = new Map<string, number>();
  for (const chunk of chunks) {
    if (accepted.length >= options.maxChunks) break;
    if (chunk.score < options.minScore) continue;

    const used = countByDocument.get(chunk.docName) ?? 0;
    if (used >= options.maxChunksPerDocument) continue;
    countByDocument.set(chunk.docName, used + 1);
    accepted.push(chunk);
  }
  return accepted;
}

/** 角标每个文档只显示一次，采用该文档相关度最高（即输入中最先）的分块号。 */
export function dedupeKbCitations(chunks: readonly RetrievedChunk[]): KbCitation[] {
  const cited = new Set<string>();
  const citations: KbCitation[] = [];
  for (const chunk of chunks) {
    if (cited.has(chunk.docName)) continue;
    cited.add(chunk.docName);
    citations.push({ docName: chunk.docName, ordinal: chunk.ordinal });
  }
  return citations;
}

function resultLimit(topK: number): number {
  if (!Number.isSafeInteger(topK) || topK < 1) {
    throw new Error("knowledge retrieval topK must be a positive integer");
  }
  return topK;
}

/**
 * pgvector 的 `<=>` 是余弦距离，排序表达式必须直接保留，才能命中 vector_cosine_ops HNSW 索引。
 * 向量先在进 SQL 前校验；不能把 NaN、错维数组拼进 `$queryRawUnsafe` 再等数据库报随机错误。
 */
export async function retrieveChunks(
  prisma: VectorQueryClient,
  kbIds: string[],
  vector: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  if (kbIds.length === 0) return [];

  const checked = validateEmbeddingVector(vector);
  if (!checked.some((coordinate) => coordinate !== 0)) {
    throw new Error("knowledge retrieval vector must not be all zeroes");
  }
  const literal = `[${checked.join(",")}]`;
  const rows = await prisma.$queryRawUnsafe<Array<RetrievedChunk & { score: number | string }>>(
    `SELECT c.content, d.name AS "docName", c.ordinal,
            1 - (c.embedding <=> $1::vector) AS score
     FROM "Chunk" AS c
     JOIN "Document" AS d ON d.id = c."documentId"
     WHERE c."kbId" = ANY($2) AND d.status = $3
     ORDER BY c.embedding <=> $1::vector
     LIMIT $4`,
    literal,
    kbIds,
    "indexed",
    resultLimit(topK),
  );
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}
