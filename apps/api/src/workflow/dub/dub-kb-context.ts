import type { PrismaClient } from "@ai-assistant/db";
import { loadEmbeddingConfig } from "../../memory/embedding-client.js";
import { billableEmbed } from "../../memory/embedding-billing.js";
import { resolveEffectiveKbIds, retrieveChunks, filterRelevantChunks, type RetrievedChunk } from "../../kb/retrieve.js";

const KB_TOPK = 6;
const KB_MIN_SCORE = 0.35;
const KB_MAX_CONTEXT_CHUNKS = 4;
const KB_MAX_CHUNKS_PER_DOCUMENT = 2;
const CONTENT_PREVIEW_CHARS = 200;

export function formatKbContext(hits: readonly RetrievedChunk[]): string | null {
  if (hits.length === 0) return null;
  const lines = hits.map((h) => {
    const preview = h.content.substring(0, CONTENT_PREVIEW_CHARS);
    return `- ${h.docName}#${h.ordinal}: ${preview}${h.content.length > CONTENT_PREVIEW_CHARS ? "..." : ""}`;
  });
  return `参考资料：\n${lines.join("\n")}`;
}

// KB 是增强项：任何一步失败都降级返回 null，绝不阻断洗稿主流程。
export async function buildKbContext(args: {
  prisma: PrismaClient;
  billing: Parameters<typeof billableEmbed>[0]["billing"];
  userId: string;
  kbIds: string[];
  query: string;
  embedFn?: typeof billableEmbed;
  retrieveFn?: typeof retrieveChunks;
  resolveFn?: typeof resolveEffectiveKbIds;
}): Promise<string | null> {
  if (!args.kbIds || args.kbIds.length === 0) return null;
  const resolve = args.resolveFn ?? resolveEffectiveKbIds;
  const embed = args.embedFn ?? billableEmbed;
  const retrieve = args.retrieveFn ?? retrieveChunks;
  try {
    // 越权过滤：只保留本人库与官方库
    const effective = await resolve(args.prisma, args.userId, { attachedKbIds: args.kbIds });
    if (effective.length === 0) return null;
    const embedded = await embed({
      billing: args.billing,
      cfg: loadEmbeddingConfig(),
      userId: args.userId,
      operationId: `dub-rewrite-embed:${args.userId}:${Date.now()}`,
      input: args.query,
    });
    const raw = await retrieve(args.prisma, effective, embedded.vector, KB_TOPK);
    return formatKbContext(filterRelevantChunks(raw, {
      minScore: KB_MIN_SCORE,
      maxChunks: KB_MAX_CONTEXT_CHUNKS,
      maxChunksPerDocument: KB_MAX_CHUNKS_PER_DOCUMENT,
    }));
  } catch {
    return null; // 降级：KB 不可用不影响洗稿
  }
}
