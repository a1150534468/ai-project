import { embed, loadEmbeddingConfig, type EmbeddingConfig } from "../../memory/embedding-client.js";
import { compactNovelVectorText, loadNovelVectorDocuments } from "./novel-vector-documents.js";
import {
  deleteNovelVectors,
  findNearestNovelVectors,
  readExistingNovelVectors,
  writeNovelVector,
} from "./novel-vector-store.js";
import {
  novelVectorIdentity,
  type NovelVectorHit,
  type NovelVectorStore,
} from "./novel-vector-types.js";

const HIT_CONTENT_LIMIT = 700;

export async function refreshNovelVectorMemory(args: {
  readonly store: NovelVectorStore;
  readonly projectId: string;
  readonly embeddingConfig?: EmbeddingConfig;
}): Promise<void> {
  const config = args.embeddingConfig ?? loadEmbeddingConfig();
  const [documents, existingRows] = await Promise.all([
    loadNovelVectorDocuments(args.store, args.projectId),
    readExistingNovelVectors(args.store, args.projectId),
  ]);
  const documentsByKey = new Map(documents.map((item) => [novelVectorIdentity(item), item]));
  const existingByKey = new Map(existingRows.map((item) => [novelVectorIdentity(item), item]));

  await deleteNovelVectors(
    args.store,
    args.projectId,
    existingRows
      .filter((row) => !documentsByKey.has(novelVectorIdentity(row)))
      .map((row) => row.id),
  );

  for (const document of documents) {
    const current = existingByKey.get(novelVectorIdentity(document));
    if (current?.contentHash === document.contentHash) continue;
    const embedding = await embed(config, document.content);
    await writeNovelVector({
      store: args.store,
      projectId: args.projectId,
      document,
      vector: embedding.vector,
    });
  }
}

export const queryNovelVectorMemory = findNearestNovelVectors;

export function buildNovelVectorQuery(args: {
  readonly projectTitle: string;
  readonly genre: string;
  readonly chapterIndex?: number;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
}): string {
  const fields = [
    ["项目", args.projectTitle],
    ["题材", args.genre],
    ["章节序号", args.chapterIndex ? `第 ${args.chapterIndex} 章` : ""],
    ["章节标题", args.chapterTitle],
    ["章节目标", args.chapterSummary],
  ] as const;
  return fields.filter(([, value]) => Boolean(value)).map(([label, value]) => `${label}：${value}`).join("\n");
}

export function formatNovelVectorMemoryContext(hits: readonly NovelVectorHit[]): string {
  if (hits.length === 0) return "";
  const excerpts = hits.map((hit) => (
    `【${hit.title}】\n${compactNovelVectorText(hit.content, HIT_CONTENT_LIMIT)}`
  ));
  return [
    "向量记忆召回（生成正文必须优先遵守，避免与前文设定冲突）：",
    excerpts.join("\n\n"),
  ].join("\n");
}

export async function buildNovelVectorMemoryContext(args: {
  readonly store: NovelVectorStore;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly genre: string;
  readonly chapterIndex?: number;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
}): Promise<string> {
  const config = loadEmbeddingConfig();
  await refreshNovelVectorMemory({
    store: args.store,
    projectId: args.projectId,
    embeddingConfig: config,
  });
  const queryEmbedding = await embed(config, buildNovelVectorQuery(args));
  const hits = await findNearestNovelVectors({
    store: args.store,
    projectId: args.projectId,
    vector: queryEmbedding.vector,
    excludedSourceKind: args.chapterIndex ? `chapter:${args.chapterIndex}` : undefined,
  });
  return formatNovelVectorMemoryContext(hits);
}
