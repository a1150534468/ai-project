/**
 * novel-task-runner 拆分后的上下文装配层:把项目下散落的结构化资料(bible / 人物 / 关系 /
 * 地点 / 故事线 / 时间线 / 叙事债务 / 道具 / 知识事实 / 伏笔 / 前序章节与审校反馈)读齐,
 * 压成模型能吃的上下文文本。
 *
 * `loadNovelGenerationContextPayload` 里对 `store.novelXxx?.findMany(...) ?? Promise.resolve([])`
 * 这种写法是刻意的:这些表是逐步加进 schema 的,老库上 client 里没有对应 delegate,直接调
 * 会 TypeError。可选链让"表还不存在"退化成"这类资料为空",而不是整条生成链路失败。
 *
 * `contextRecord` / `contextString` / `contextJson` / `excerpt` 全都是"任何脏值都能吞"的收窄口。
 * 上下文来源是历史数据,字段缺失、类型不对是常态 —— 这一层的职责就是绝不因此抛异常。
 *
 * `buildChapterContextText` 与 `refreshNovelVectorMemoryBestEffort` 都吞掉了向量记忆的错误:
 * 向量库是增强项,它挂了应当降级成"只有结构化上下文",不能让整章生成失败。注意两处都只吞
 * `Error`,非 Error 的 throw 仍然向上抛 —— 那通常是编程错误,不该被静音。
 *
 * 依赖方向:本文件是叶子(只依赖 context-builder / vector-memory / records)。不 import
 * shared / persist / run。
 */

import type { PrismaClient } from "@prisma/client";
import { buildNovelGenerationContext, buildNovelEnhancedContextText } from "./novel-context-builder.js";
import { buildNovelVectorMemoryContext, refreshNovelVectorMemory } from "./novel-vector-memory.js";
import type { NovelForeshadowPayload, NovelKnowledgeFactPayload } from "./novel-workbench-types.js";
import { isPlainObject } from "../../runtime/records.js";

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerpt(text: string, maxChars: number): string {
  const compacted = compactLine(text);
  const chars = Array.from(compacted);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}...` : compacted;
}

function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function factStatus(status: string): NovelKnowledgeFactPayload["status"] {
  return status === "draft" || status === "conflict" ? status : "confirmed";
}

function foreshadowStatus(status: string): NovelForeshadowPayload["status"] {
  return status === "hinted" || status === "resolved" || status === "abandoned" ? status : "open";
}

function contextRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function contextString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function contextJson(value: unknown, maxChars = 240): string {
  if (value === null || value === undefined) return "";
  try {
    return excerpt(JSON.stringify(value), maxChars);
  } catch {
    return "";
  }
}

export async function loadNovelGenerationContextPayload(args: {
  readonly prisma: PrismaClient;
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly premise?: string;
    readonly settings?: unknown;
    readonly narrativeContract?: unknown;
  };
  readonly chapterIndex: number;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
}) {
  const store = args.prisma as PrismaClient & {
    novelKnowledgeFact?: { findMany: (args: unknown) => Promise<NovelKnowledgeFactPayload[]> };
    novelForeshadowItem?: { findMany: (args: unknown) => Promise<NovelForeshadowPayload[]> };
    novelCharacter?: { findMany: (args: unknown) => Promise<unknown[]> };
    novelCharacterRelation?: { findMany: (args: unknown) => Promise<unknown[]> };
    novelLocation?: { findMany: (args: unknown) => Promise<unknown[]> };
    novelStoryline?: { findMany: (args: unknown) => Promise<unknown[]> };
    novelTimelineEvent?: { findMany: (args: unknown) => Promise<unknown[]> };
    novelNarrativeDebt?: { findMany: (args: unknown) => Promise<unknown[]> };
    novelProp?: { findMany: (args: unknown) => Promise<unknown[]> };
    novelBible?: { findUnique: (args: unknown) => Promise<unknown> };
  };
  const [bibleValue, previousChapters, facts, foreshadowItems, characters, relations, locations, storylines, timeline, debts, props] = await Promise.all([
    store.novelBible?.findUnique({ where: { projectId: args.project.id }, include: { worldDimensions: { orderBy: { position: "asc" } }, styleNotes: { orderBy: { position: "asc" } } } }) ?? Promise.resolve(null),
    args.prisma.novelChapter.findMany({ where: { projectId: args.project.id }, orderBy: { chapterIndex: "asc" } }),
    store.novelKnowledgeFact?.findMany({
      where: { projectId: args.project.id, status: { not: "conflict" } },
      orderBy: { updatedAt: "desc" },
      take: 24,
    }) ?? Promise.resolve([]),
    store.novelForeshadowItem?.findMany({
      where: { projectId: args.project.id, status: { not: "resolved" } },
      orderBy: [{ expectedPayoffChapter: "asc" }, { updatedAt: "desc" }],
      take: 24,
    }) ?? Promise.resolve([]),
    store.novelCharacter?.findMany({ where: { projectId: args.project.id }, orderBy: [{ role: "asc" }, { name: "asc" }], take: 24 }) ?? Promise.resolve([]),
    store.novelCharacterRelation?.findMany({ where: { projectId: args.project.id }, include: { fromCharacter: { select: { name: true } }, toCharacter: { select: { name: true } } }, take: 40 }) ?? Promise.resolve([]),
    store.novelLocation?.findMany({ where: { projectId: args.project.id }, orderBy: { updatedAt: "desc" }, take: 16 }) ?? Promise.resolve([]),
    store.novelStoryline?.findMany({ where: { projectId: args.project.id, status: "active" }, include: { milestones: { where: { chapterNumber: { gte: args.chapterIndex - 2, lte: args.chapterIndex + 3 } }, orderBy: { chapterNumber: "asc" } } }, take: 12 }) ?? Promise.resolve([]),
    store.novelTimelineEvent?.findMany({ where: { projectId: args.project.id, OR: [{ chapterNumber: null }, { chapterNumber: { lte: args.chapterIndex } }] }, orderBy: [{ chapterNumber: "desc" }, { updatedAt: "desc" }], take: 16 }) ?? Promise.resolve([]),
    store.novelNarrativeDebt?.findMany({ where: { projectId: args.project.id, status: "open" }, orderBy: [{ dueChapter: "asc" }, { createdAt: "asc" }], take: 16 }) ?? Promise.resolve([]),
    store.novelProp?.findMany({ where: { projectId: args.project.id, status: { not: "retired" } }, orderBy: { updatedAt: "desc" }, take: 16 }) ?? Promise.resolve([]),
  ]);
  const bible = contextRecord(bibleValue);
  const worldDimensions = Array.isArray(bible.worldDimensions) ? bible.worldDimensions : [];
  const styleNotes = Array.isArray(bible.styleNotes) ? bible.styleNotes : [];
  const reviewFeedback = previousChapters
    .filter((chapter) => chapter.chapterIndex < args.chapterIndex)
    .sort((a, b) => b.chapterIndex - a.chapterIndex)
    .slice(0, 5)
    .map((chapter) => ({
      chapterIndex: chapter.chapterIndex,
      status: "reviewStatus" in chapter && typeof chapter.reviewStatus === "string" ? chapter.reviewStatus : "pending",
      reviewNotes: "reviewNotes" in chapter && typeof chapter.reviewNotes === "string" ? chapter.reviewNotes : "",
      aiReview: "aiReview" in chapter && typeof chapter.aiReview === "string" ? chapter.aiReview : "",
      aiActionItems: jsonArray("aiActionItems" in chapter ? chapter.aiActionItems : []),
      modificationRate: "modificationRate" in chapter && typeof chapter.modificationRate === "number" ? chapter.modificationRate : 0,
    }));
  return buildNovelGenerationContext({
    project: args.project,
    chapterIndex: args.chapterIndex,
    chapterTitle: args.chapterTitle,
    chapterSummary: args.chapterSummary,
    conflictAnchor: contextString(contextRecord(args.project.narrativeContract).coreQuestion),
    styleProfileText: styleNotes.map((value) => { const row = contextRecord(value); return `${contextString(row.title)}：${contextString(row.content)}`; }).filter(Boolean).join("；"),
    previousChapters: previousChapters.filter((chapter) => chapter.chapterIndex < args.chapterIndex),
    facts: facts.map((fact) => ({ ...fact, status: factStatus(fact.status) })),
    foreshadowItems: foreshadowItems.map((item) => ({ ...item, status: foreshadowStatus(item.status) })),
    reviewFeedback,
    structuredContext: {
      contract: [
        args.project.premise ? `故事前提：${excerpt(args.project.premise, 360)}` : "",
        contextJson(args.project.narrativeContract) ? `叙事契约：${contextJson(args.project.narrativeContract, 600)}` : "",
      ],
      world: [
        contextJson(args.project.settings) ? `项目世界规则：${contextJson(args.project.settings, 500)}` : "",
        ...worldDimensions.map((value) => {
          const row = contextRecord(value);
          return `世界维度·${contextString(row.title)}：${contextString(row.summary)}；${contextJson(row.details, 400)}`;
        }),
        ...locations.map((value) => {
          const row = contextRecord(value);
          return `地点：${contextString(row.name)}；规则：${contextString(row.rules)}；${contextString(row.description)}`;
        }),
      ],
      characters: [
        ...characters.map((value) => {
          const row = contextRecord(value);
          return `人物：${contextString(row.name)}（${contextString(row.role) || "角色"}）；动机：${contextString(row.coreMotivation)}；信念：${contextString(row.coreBelief)}；当前状态：${contextJson(row.state)}`;
        }),
        ...relations.map((value) => {
          const row = contextRecord(value);
          const from = contextRecord(row.fromCharacter);
          const to = contextRecord(row.toCharacter);
          return `关系：${contextString(from.name) || contextString(row.fromCharacterId)} → ${contextString(to.name) || contextString(row.toCharacterId)} = ${contextString(row.relationType)}；${contextString(row.description)}`;
        }),
      ],
      continuity: [
        ...storylines.map((value) => {
          const row = contextRecord(value);
          return `故事线：${contextString(row.title)}；目标：${contextString(row.goal)}；冲突：${contextString(row.conflict)}；近期里程碑：${contextJson(row.milestones)}`;
        }),
        ...timeline.map((value) => {
          const row = contextRecord(value);
          return `时间线：${contextString(row.timeLabel)} ${contextString(row.title)}；${contextString(row.description)}`;
        }),
        ...debts.map((value) => {
          const row = contextRecord(value);
          return `叙事债务：${contextString(row.title)}；应在第${contextString(row.dueChapter) || "后续"}章前处理；${contextString(row.description)}`;
        }),
        ...props.map((value) => {
          const row = contextRecord(value);
          return `道具：${contextString(row.name)}；持有者：${contextString(row.owner)}；位置：${contextString(row.location)}；状态：${contextString(row.status)}`;
        }),
      ],
    },
  });
}

export async function buildChapterContextText(args: {
  readonly prisma: PrismaClient;
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
  };
  readonly chapterIndex?: number;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
}): Promise<string> {
  const chapterIndex = args.chapterIndex ?? 1;
  const contextPayload = await loadNovelGenerationContextPayload({
    prisma: args.prisma,
    project: args.project,
    chapterIndex,
    chapterTitle: args.chapterTitle,
    chapterSummary: args.chapterSummary,
  });
  const enhancedContextText = buildNovelEnhancedContextText(contextPayload);
  try {
    const vectorContextText = await buildNovelVectorMemoryContext({
      store: args.prisma,
      projectId: args.project.id,
      projectTitle: args.project.title,
      genre: args.project.genre,
      chapterIndex,
      chapterTitle: args.chapterTitle,
      chapterSummary: args.chapterSummary,
    });
    return [enhancedContextText, vectorContextText].filter(Boolean).join("\n\n");
  } catch (error) {
    if (error instanceof Error) return enhancedContextText;
    throw error;
  }
}

export async function refreshNovelVectorMemoryBestEffort(prisma: PrismaClient, projectId: string): Promise<void> {
  try {
    await refreshNovelVectorMemory({ store: prisma, projectId });
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}
