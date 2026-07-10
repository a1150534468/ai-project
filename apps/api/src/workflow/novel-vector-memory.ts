import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { embed, loadEmbeddingConfig, type EmbeddingConfig } from "../memory/embedding-client.js";
import { NOVEL_STAGE_LABELS } from "./novel-prompts.js";
import type { NovelStageKind } from "./novel-types.js";

const VECTOR_CONTEXT_LIMIT = 8;
const INDEX_CONTENT_LIMIT = 3200;
const HIT_CONTENT_LIMIT = 700;

type NovelVectorStore = {
  readonly novelSection: Pick<PrismaClient["novelSection"], "findMany">;
  readonly novelChapter: Pick<PrismaClient["novelChapter"], "findMany">;
  $queryRawUnsafe<T = unknown>(query: string, ...values: readonly unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
};

type NovelVectorDocument = {
  readonly sourceType: "section" | "chapter";
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
};

type ExistingVectorRow = {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly contentHash: string;
};

type NovelVectorHitRow = {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly title: string;
  readonly content: string;
  readonly score: number;
};

function toVec(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function clipText(text: string, maxChars: number): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(compacted);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}...` : compacted;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function vectorKey(row: Pick<ExistingVectorRow, "sourceType" | "sourceId">): string {
  return `${row.sourceType}:${row.sourceId}`;
}

function isNovelStageKind(kind: string): kind is NovelStageKind {
  return kind in NOVEL_STAGE_LABELS;
}

function stageLabel(kind: string): string {
  return isNovelStageKind(kind) ? NOVEL_STAGE_LABELS[kind] : kind;
}

async function loadNovelVectorDocuments(store: NovelVectorStore, projectId: string): Promise<NovelVectorDocument[]> {
  const [sections, chapters] = await Promise.all([
    store.novelSection.findMany({ where: { projectId } }),
    store.novelChapter.findMany({ where: { projectId }, orderBy: { chapterIndex: "asc" } }),
  ]);
  const sectionDocs = sections
    .filter((section) => section.displayText.trim())
    .map((section) => {
      const label = stageLabel(section.kind);
      const content = `【${label}】\n${clipText(section.displayText, INDEX_CONTENT_LIMIT)}`;
      return {
        sourceType: "section",
        sourceId: section.id,
        sourceKind: section.kind,
        title: label,
        content,
        contentHash: hashContent(content),
      } satisfies NovelVectorDocument;
    });
  const chapterDocs = chapters
    .filter((chapter) => chapter.content.trim())
    .map((chapter) => {
      const title = `第 ${chapter.chapterIndex} 章 ${chapter.title.trim() || "未命名"}`;
      const summary = chapter.summary.trim() ? `摘要：${clipText(chapter.summary, 500)}\n` : "";
      const content = `【前文正文】\n${title}\n${summary}正文：${clipText(chapter.content, INDEX_CONTENT_LIMIT)}`;
      return {
        sourceType: "chapter",
        sourceId: chapter.id,
        sourceKind: `chapter:${chapter.chapterIndex}`,
        title,
        content,
        contentHash: hashContent(content),
      } satisfies NovelVectorDocument;
    });
  return [...sectionDocs, ...chapterDocs];
}

async function deleteStaleRows(store: NovelVectorStore, projectId: string, rowIds: readonly string[]): Promise<void> {
  if (rowIds.length === 0) return;
  const placeholders = rowIds.map((_, index) => `$${index + 2}`).join(", ");
  await store.$executeRawUnsafe(
    `DELETE FROM "NovelVectorMemory" WHERE "projectId" = $1 AND id IN (${placeholders})`,
    projectId,
    ...rowIds,
  );
}

async function upsertVectorDocument(args: {
  readonly store: NovelVectorStore;
  readonly projectId: string;
  readonly document: NovelVectorDocument;
  readonly vector: readonly number[];
}): Promise<void> {
  await args.store.$executeRawUnsafe(
    `INSERT INTO "NovelVectorMemory"(
      id, "projectId", "sourceType", "sourceId", "sourceKind", title, content, "contentHash", embedding, "createdAt", "updatedAt"
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, now(), now())
    ON CONFLICT ("projectId", "sourceType", "sourceId") DO UPDATE SET
      "sourceKind" = EXCLUDED."sourceKind",
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      "contentHash" = EXCLUDED."contentHash",
      embedding = EXCLUDED.embedding,
      "updatedAt" = now()`,
    randomUUID(),
    args.projectId,
    args.document.sourceType,
    args.document.sourceId,
    args.document.sourceKind,
    args.document.title,
    args.document.content,
    args.document.contentHash,
    toVec(args.vector),
  );
}

export async function refreshNovelVectorMemory(args: {
  readonly store: NovelVectorStore;
  readonly projectId: string;
  readonly embeddingConfig?: EmbeddingConfig;
}): Promise<void> {
  const cfg = args.embeddingConfig ?? loadEmbeddingConfig();
  const documents = await loadNovelVectorDocuments(args.store, args.projectId);
  const existingRows = await args.store.$queryRawUnsafe<ExistingVectorRow[]>(
    `SELECT id, "sourceType", "sourceId", "contentHash"
     FROM "NovelVectorMemory"
     WHERE "projectId" = $1`,
    args.projectId,
  );
  const documentsByKey = new Map(documents.map((document) => [vectorKey(document), document]));
  const existingByKey = new Map(existingRows.map((row) => [vectorKey(row), row]));
  await deleteStaleRows(
    args.store,
    args.projectId,
    existingRows.filter((row) => !documentsByKey.has(vectorKey(row))).map((row) => row.id),
  );
  for (const document of documents) {
    const existing = existingByKey.get(vectorKey(document));
    if (existing?.contentHash === document.contentHash) continue;
    const result = await embed(cfg, document.content);
    await upsertVectorDocument({
      store: args.store,
      projectId: args.projectId,
      document,
      vector: result.vector,
    });
  }
}

export async function queryNovelVectorMemory(args: {
  readonly store: NovelVectorStore;
  readonly projectId: string;
  readonly vector: readonly number[];
  readonly excludedSourceKind?: string;
  readonly limit?: number;
}): Promise<NovelVectorHitRow[]> {
  const excludedSourceKind = args.excludedSourceKind ?? "";
  const limit = Math.max(1, Math.min(args.limit ?? VECTOR_CONTEXT_LIMIT, VECTOR_CONTEXT_LIMIT));
  const rows = await args.store.$queryRawUnsafe<NovelVectorHitRow[]>(
    `SELECT id, "sourceType", "sourceId", "sourceKind", title, content,
            1 - (embedding <=> $1::vector) AS score
     FROM "NovelVectorMemory"
     WHERE "projectId" = $2
       AND "sourceKind" <> $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    toVec(args.vector),
    args.projectId,
    excludedSourceKind,
    limit,
  );
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

export function buildNovelVectorQuery(args: {
  readonly projectTitle: string;
  readonly genre: string;
  readonly chapterIndex?: number;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
}): string {
  return [
    `项目：${args.projectTitle}`,
    args.genre ? `题材：${args.genre}` : "",
    args.chapterIndex ? `章节序号：第 ${args.chapterIndex} 章` : "",
    args.chapterTitle ? `章节标题：${args.chapterTitle}` : "",
    args.chapterSummary ? `章节目标：${args.chapterSummary}` : "",
  ].filter(Boolean).join("\n");
}

export function formatNovelVectorMemoryContext(hits: readonly NovelVectorHitRow[]): string {
  if (hits.length === 0) return "";
  return [
    "向量记忆召回（生成正文必须优先遵守，避免与前文设定冲突）：",
    hits.map((hit) => [
      `【${hit.title}】`,
      clipText(hit.content, HIT_CONTENT_LIMIT),
    ].join("\n")).join("\n\n"),
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
  const cfg = loadEmbeddingConfig();
  await refreshNovelVectorMemory({ store: args.store, projectId: args.projectId, embeddingConfig: cfg });
  const query = buildNovelVectorQuery(args);
  const result = await embed(cfg, query);
  const hits = await queryNovelVectorMemory({
    store: args.store,
    projectId: args.projectId,
    vector: result.vector,
    excludedSourceKind: args.chapterIndex ? `chapter:${args.chapterIndex}` : undefined,
  });
  return formatNovelVectorMemoryContext(hits);
}
