import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { embed, loadEmbeddingConfig, type EmbeddingConfig } from "../memory/embedding-client.js";

const VECTOR_CONTEXT_LIMIT = 8;
const INDEX_CONTENT_LIMIT = 3200;
const HIT_CONTENT_LIMIT = 700;

type NovelVectorStore = {
  readonly novelProject: Pick<PrismaClient["novelProject"], "findUnique">;
  readonly novelBible: Pick<PrismaClient["novelBible"], "findUnique">;
  readonly novelWorldDimension: Pick<PrismaClient["novelWorldDimension"], "findMany">;
  readonly novelStyleNote: Pick<PrismaClient["novelStyleNote"], "findMany">;
  readonly novelCharacter: Pick<PrismaClient["novelCharacter"], "findMany">;
  readonly novelLocation: Pick<PrismaClient["novelLocation"], "findMany">;
  readonly novelStoryline: Pick<PrismaClient["novelStoryline"], "findMany">;
  readonly novelChapter: Pick<PrismaClient["novelChapter"], "findMany">;
  $queryRawUnsafe<T = unknown>(query: string, ...values: readonly unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
};

type NovelVectorDocument = {
  readonly sourceType: "bible" | "world" | "style" | "character" | "location" | "storyline" | "chapter";
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

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function document(args: Omit<NovelVectorDocument, "contentHash">): NovelVectorDocument | null {
  const content = clipText(args.content, INDEX_CONTENT_LIMIT);
  if (!content) return null;
  return { ...args, content, contentHash: hashContent(content) };
}

async function loadNovelVectorDocuments(store: NovelVectorStore, projectId: string): Promise<NovelVectorDocument[]> {
  const [project, bible, worldDimensions, styleNotes, characters, locations, storylines, chapters] = await Promise.all([
    store.novelProject.findUnique({ where: { id: projectId } }),
    store.novelBible.findUnique({ where: { projectId } }),
    store.novelWorldDimension.findMany({ where: { projectId }, orderBy: { position: "asc" } }),
    store.novelStyleNote.findMany({ where: { projectId }, orderBy: { position: "asc" } }),
    store.novelCharacter.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    store.novelLocation.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    store.novelStoryline.findMany({ where: { projectId }, include: { milestones: { orderBy: { chapterNumber: "asc" } } }, orderBy: { createdAt: "asc" } }),
    store.novelChapter.findMany({ where: { projectId }, orderBy: { chapterIndex: "asc" } }),
  ]);
  const docs: Array<NovelVectorDocument | null> = [];
  if (project) {
    docs.push(document({
      sourceType: "bible",
      sourceId: project.id,
      sourceKind: "story-contract",
      title: "故事圣经与叙事契约",
      content: [
        `【故事圣经】\n书名：${project.title}`,
        project.genre ? `题材：${project.genre}` : "",
        project.premise ? `核心梗概：${project.premise}` : "",
        jsonText(project.settings) ? `项目设置：${jsonText(project.settings)}` : "",
        jsonText(project.narrativeContract) ? `叙事契约：${jsonText(project.narrativeContract)}` : "",
      ].filter(Boolean).join("\n"),
    }));
  }
  if (bible) {
    docs.push(document({
      sourceType: "bible",
      sourceId: bible.id,
      sourceKind: "locked-foundation",
      title: "锁定设定",
      content: `【锁定设定】\n故事前提：${bible.premiseLock}\n题材：${bible.genreLock}\n世界预设：${bible.worldPresetLock}`,
    }));
  }
  docs.push(...worldDimensions.map((item) => document({
    sourceType: "world",
    sourceId: item.id,
    sourceKind: item.dimensionKey,
    title: item.title,
    content: `【世界维度·${item.title}】\n${item.summary}\n${jsonText(item.details)}`,
  })));
  docs.push(...styleNotes.map((item) => document({
    sourceType: "style",
    sourceId: item.id,
    sourceKind: item.category,
    title: item.title,
    content: `【文风公约·${item.title}】\n${item.content}`,
  })));
  docs.push(...characters.map((item) => document({
    sourceType: "character",
    sourceId: item.id,
    sourceKind: item.role || "character",
    title: item.name,
    content: [
      `【人物·${item.name}】`,
      item.role ? `角色定位：${item.role}` : "",
      item.description ? `人物简介：${item.description}` : "",
      item.appearance ? `外貌：${item.appearance}` : "",
      item.personality ? `性格：${item.personality}` : "",
      item.coreBelief ? `核心信念：${item.coreBelief}` : "",
      item.coreMotivation ? `核心动机：${item.coreMotivation}` : "",
      item.innerLack ? `内在缺失：${item.innerLack}` : "",
      item.voiceStyle ? `语言风格：${item.voiceStyle}` : "",
      jsonText(item.state) ? `当前状态：${jsonText(item.state)}` : "",
    ].filter(Boolean).join("\n"),
  })));
  docs.push(...locations.map((item) => document({
    sourceType: "location",
    sourceId: item.id,
    sourceKind: "location",
    title: item.name,
    content: `【地点·${item.name}】\n${item.description}\n规则：${item.rules}\n${jsonText(item.metadata)}`,
  })));
  docs.push(...storylines.map((item) => document({
    sourceType: "storyline",
    sourceId: item.id,
    sourceKind: item.storylineType,
    title: item.title,
    content: [
      `【故事线·${item.title}】`,
      `类型：${item.storylineType}；状态：${item.status}`,
      item.goal ? `目标：${item.goal}` : "",
      item.conflict ? `冲突：${item.conflict}` : "",
      item.milestones.length ? `里程碑：\n${item.milestones.map((milestone) => `第${milestone.chapterNumber}章 ${milestone.title}：${milestone.description}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
  })));
  const chapterDocs = chapters
    .filter((chapter) => chapter.content.trim())
    .map((chapter) => {
      const title = `第 ${chapter.chapterIndex} 章 ${chapter.title.trim() || "未命名"}`;
      const summary = chapter.summary.trim() ? `摘要：${clipText(chapter.summary, 500)}\n` : "";
      return document({
        sourceType: "chapter",
        sourceId: chapter.id,
        sourceKind: `chapter:${chapter.chapterIndex}`,
        title,
        content: `【前文正文】\n${title}\n${summary}正文：${chapter.content}`,
      });
    });
  return [...docs, ...chapterDocs].filter((item): item is NovelVectorDocument => item !== null);
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
