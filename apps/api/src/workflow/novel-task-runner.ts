import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { nextNovelChapterIndex } from "@ai-assistant/novel-workflow";
import { billableCharCount, formatGeneratedNovelDisplayText, parseRequiredGeneratedNovelValue, visibleCharCount } from "./novel-billable.js";
import type { NovelGenerator } from "./novel-generation.js";
import { NOVEL_RESOURCE_KEY, NOVEL_TASK_STATUS, type NovelSetupTargetKind, type NovelTargetKind } from "./novel-types.js";
import { buildNovelGenerationContext, buildNovelEnhancedContextText } from "./novel-context-builder.js";
import { buildNovelChapterPostprocessPayload } from "./novel-postprocess.js";
import { buildNovelReviewPayload } from "./novel-review.js";
import { buildNovelVectorMemoryContext, refreshNovelVectorMemory } from "./novel-vector-memory.js";
import type { NovelForeshadowPayload, NovelKnowledgeFactPayload } from "./novel-workbench-types.js";
import { syncNovelSetupAssets } from "../novel/structured-sync.js";

export interface BillingForNovels {
  reserveResource: (args: { operationId: string; userId: string; resourceKey: string; units: number }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  listModels?: () => Promise<{ data: Array<{ model: string; enabled: boolean }> }>;
}

export interface NovelTaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly operationId: string;
  readonly status: string;
  readonly progressPercent: number;
  readonly progressStage: string;
  readonly progressMessage: string | null;
  readonly progressPreview: string;
  readonly streamedChars: number;
  readonly requestPayload: Prisma.JsonValue | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
}

class NovelTaskStoppedError extends Error {
  constructor() {
    super("任务已取消");
    this.name = "NovelTaskStoppedError";
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "生成失败";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function taskPayload(task: NovelTaskRow): Record<string, unknown> {
  return isRecord(task.requestPayload) ? task.requestPayload : {};
}

const PROGRESS_PREVIEW_CHARS = 1600;

function streamedCharCount(value: string): number {
  return Array.from(value).length;
}

function appendProgressPreview(current: string, chunk: string): string {
  const chars = Array.from(`${current}${chunk}`);
  return chars.slice(Math.max(0, chars.length - PROGRESS_PREVIEW_CHARS)).join("");
}

function expectedStreamChars(targetKind: NovelTargetKind, payload: Record<string, unknown>, targetChapters: number): number {
  if (targetKind === "chapter" || targetKind === "chapterRewrite") {
    return Math.max(300, Number(payload.targetChars) || (targetKind === "chapter" ? 3000 : 500));
  }
  if (targetKind === "setupBible") return 3500;
  if (targetKind === "setupCharacters") return 5000;
  if (targetKind === "setupLocations") return 3500;
  return Math.max(6000, Math.min(16_000, targetChapters * 90));
}

async function updateTaskProgress(prisma: PrismaClient, taskId: string, data: {
  readonly progressPercent: number;
  readonly progressStage: string;
  readonly progressMessage: string;
  readonly progressPreview?: string;
  readonly streamedChars?: number;
}): Promise<void> {
  await prisma.novelTask.update({
    where: { id: taskId },
    data: {
      progressPercent: Math.max(0, Math.min(100, Math.round(data.progressPercent))),
      progressStage: data.progressStage,
      progressMessage: data.progressMessage,
      ...(data.progressPreview === undefined ? {} : { progressPreview: data.progressPreview }),
      ...(data.streamedChars === undefined ? {} : { streamedChars: data.streamedChars }),
    },
  });
}

export function estimateReserveChars(targetKind: NovelTargetKind, targetChars?: number, _targetCount?: number): number {
  if (targetKind === "chapter") return Math.max(1000, Math.min(targetChars ?? 3000, 12000));
  if (targetKind === "chapterRewrite") return Math.max(200, Math.min(targetChars ?? 500, 6000));
  if (targetKind === "setupPlot") return 16_000;
  return 10_000;
}

function isSetupTargetKind(kind: NovelTargetKind): kind is NovelSetupTargetKind {
  return kind === "setupBible" || kind === "setupCharacters" || kind === "setupLocations" || kind === "setupPlot";
}

function operationId(): string {
  return `novel:${randomUUID()}`;
}

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
  return isRecord(value) ? value : {};
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

function promptNodeKey(targetKind: NovelTargetKind): string {
  if (targetKind === "chapter") return "chapter-writing";
  if (targetKind === "chapterRewrite") return "chapter-rewrite";
  return `${targetKind}-generation`;
}

function renderNovelPromptTemplate(content: string, variables: Record<string, string | number>): string {
  return content.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (_match, key: string) => String(variables[key] ?? ""));
}

export function serializeTask(task: NovelTaskRow) {
  return {
    id: task.id,
    projectId: task.projectId,
    targetKind: task.targetKind,
    targetId: task.targetId,
    status: task.status,
    progressPercent: task.progressPercent,
    progressStage: task.progressStage,
    progressMessage: task.progressMessage,
    progressPreview: task.progressPreview,
    streamedChars: task.streamedChars,
    requestPayload: task.requestPayload,
    error: task.error,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    cancelledAt: task.cancelledAt?.toISOString() ?? null,
  };
}

export async function getProjectDetail(prisma: PrismaClient, userId: string, projectId: string) {
  const project = await prisma.novelProject.findFirst({
    where: { id: projectId, userId },
    include: {
      tasks: { orderBy: { updatedAt: "desc" }, take: 20 },
      bible: { include: { worldDimensions: { orderBy: { position: "asc" } }, styleNotes: { orderBy: { position: "asc" } } } },
    },
  });
  if (!project) return null;
  const chapters = await prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" } });
  return {
    project: {
      id: project.id,
      title: project.title,
      genre: project.genre,
      premise: project.premise,
      settings: project.settings,
      targetChapters: project.targetChapters,
      targetCharsPerChapter: project.targetCharsPerChapter,
      setupStage: project.setupStage,
      setupCompleted: project.setupCompleted,
      storyPhase: project.storyPhase,
      autopilotStatus: project.autopilotStatus,
      currentBranch: project.currentBranch,
      status: project.status,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    bible: project.bible ? {
      id: project.bible.id,
      premiseLock: project.bible.premiseLock,
      genreLock: project.bible.genreLock,
      worldPresetLock: project.bible.worldPresetLock,
      version: project.bible.version,
      worldDimensions: project.bible.worldDimensions,
      styleNotes: project.bible.styleNotes,
      updatedAt: project.bible.updatedAt.toISOString(),
    } : null,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      volumeIndex: chapter.volumeIndex,
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      summary: chapter.summary,
      outline: chapter.outline,
      generationHint: chapter.generationHint,
      executionPlan: chapter.executionPlan,
      microBeats: chapter.microBeats,
      content: chapter.content,
      rawContent: chapter.rawContent,
      openThreads: chapter.openThreads,
      contextSnapshot: chapter.contextSnapshot,
      generationMeta: chapter.generationMeta,
      consistencyJson: chapter.consistencyJson,
      status: chapter.status,
      reviewStatus: chapter.reviewStatus,
      reviewNotes: chapter.reviewNotes,
      aiReview: chapter.aiReview,
      aiActionItems: chapter.aiActionItems,
      modificationRate: chapter.modificationRate,
      reviewedAt: chapter.reviewedAt?.toISOString() ?? null,
      tensionScore: chapter.tensionScore,
      plotTension: chapter.plotTension,
      emotionalTension: chapter.emotionalTension,
      pacingTension: chapter.pacingTension,
      qualityScore: chapter.qualityScore,
      billableChars: chapter.billableChars,
      lastTaskId: chapter.lastTaskId,
      updatedAt: chapter.updatedAt.toISOString(),
    })),
    tasks: project.tasks.map(serializeTask),
  };
}

async function loadNovelGenerationContextPayload(args: {
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

async function buildChapterContextText(args: {
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

export async function reserveAndCreateTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForNovels;
  readonly userId: string;
  readonly projectId: string;
  readonly targetKind: NovelTargetKind;
  readonly targetId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly estimateChars: number;
  readonly delivery?: "inline" | "worker-outbox";
}): Promise<NovelTaskRow> {
  const opId = operationId();
  await args.billing.reserveResource({
    operationId: opId,
    userId: args.userId,
    resourceKey: NOVEL_RESOURCE_KEY,
    units: args.estimateChars,
  });
  try {
    return await args.prisma.$transaction(async (tx) => {
      const task = await tx.novelTask.create({
        data: {
          projectId: args.projectId,
          userId: args.userId,
          kind: "generate",
          targetKind: args.targetKind,
          targetId: args.targetId ?? null,
          status: NOVEL_TASK_STATUS.queued,
          progressPercent: 0,
          progressStage: "queued",
          progressMessage: "任务已入队，等待 Novel Worker 接收",
          progressPreview: "",
          streamedChars: 0,
          requestPayload: jsonValue(args.payload),
          operationId: opId,
        },
      });
      if (args.delivery === "worker-outbox") {
        await tx.novelCommandOutbox.create({
          data: {
            projectId: args.projectId,
            taskId: task.id,
            payload: { type: "generation-task", taskId: task.id },
            priority: 1,
            jobName: "generation-task",
          },
        });
      }
      return task;
    });
  } catch (error) {
    await args.billing.refundResource(opId).catch(() => undefined);
    throw error;
  }
}

async function assertTaskActive(prisma: PrismaClient, taskId: string): Promise<NovelTaskRow> {
  const task = await prisma.novelTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("novel task not found");
  if (task.status === NOVEL_TASK_STATUS.cancelled) throw new NovelTaskStoppedError();
  if (task.status !== NOVEL_TASK_STATUS.queued && task.status !== NOVEL_TASK_STATUS.running) {
    throw new NovelTaskStoppedError();
  }
  return task;
}

async function saveGeneratedResult(args: {
  readonly prisma: PrismaClient;
  readonly task: NovelTaskRow;
  readonly parsed: unknown;
  readonly model: string;
  readonly billableChars: number;
  readonly settledPoints: number;
}): Promise<void> {
  const { prisma, task } = args;
  const targetKind = task.targetKind as NovelTargetKind;
  const payload = taskPayload(task);
  const displayText = formatGeneratedNovelDisplayText(targetKind, args.parsed);
  const billableChars = args.billableChars;
  const isChapterTarget = targetKind === "chapter" || targetKind === "chapterRewrite";
  const project = isChapterTarget ? await prisma.novelProject.findUnique({ where: { id: task.projectId } }) : null;
  if (isChapterTarget && !project) throw new Error("novel project not found");
  const chapterIndex = isChapterTarget ? Number(payload.chapterIndex) || 1 : 0;
  const generatedTitle = targetKind === "chapter" && isRecord(args.parsed) && typeof args.parsed.title === "string" ? args.parsed.title.trim() : "";
  const title = isChapterTarget ? generatedTitle || String(payload.title || `第 ${chapterIndex} 章`) : "";
  const [knownCharacters, knownLocations] = targetKind === "chapter" ? await Promise.all([
    prisma.novelCharacter.findMany({ where: { projectId: task.projectId }, select: { name: true }, take: 50 }),
    prisma.novelLocation.findMany({ where: { projectId: task.projectId }, select: { name: true }, take: 50 }),
  ]) : [[], []];
  const contextSnapshot = targetKind === "chapter" && project ? await loadNovelGenerationContextPayload({
    prisma,
    project,
    chapterIndex,
    chapterTitle: title,
    chapterSummary: String(payload.summary || ""),
  }) : null;
  const postprocess = targetKind === "chapter" && project ? buildNovelChapterPostprocessPayload({
    projectTitle: project.title,
    chapterIndex,
    title,
    content: displayText,
    knownCharacters: knownCharacters.map((item) => item.name),
    knownLocations: knownLocations.map((item) => item.name),
  }) : null;

  if (isSetupTargetKind(targetKind)) {
    await syncNovelSetupAssets({ prisma, projectId: task.projectId, targetKind, value: args.parsed });
  }
  const review = postprocess ? buildNovelReviewPayload({
    rawContent: displayText,
    finalContent: displayText,
    summary: postprocess.summary.summary,
    openThreads: postprocess.summary.openThreads,
    consistencyRisks: postprocess.consistencyStatus.risks,
  }) : null;

  await prisma.$transaction(async (tx) => {
    if (targetKind === "chapter") {
      const chapter = await tx.novelChapter.upsert({
        where: { projectId_chapterIndex: { projectId: task.projectId, chapterIndex } },
        create: {
          projectId: task.projectId,
          chapterIndex,
          title,
          summary: postprocess?.summary.summary || String(payload.summary || ""),
          content: displayText,
          rawContent: displayText,
          openThreads: jsonValue(postprocess?.summary.openThreads ?? []),
          contextSnapshot: jsonValue(contextSnapshot),
          generationMeta: jsonValue({ model: args.model, operationId: task.operationId }),
          consistencyJson: jsonValue(postprocess?.consistencyStatus ?? null),
          status: "ready",
          reviewStatus: "pending",
          aiReview: review?.aiReview ?? "",
          aiActionItems: jsonValue(review?.aiActionItems ?? []),
          modificationRate: review?.modificationRate ?? 0,
          billableChars,
          lastTaskId: task.id,
        },
        update: {
          title,
          summary: postprocess?.summary.summary || String(payload.summary || ""),
          content: displayText,
          rawContent: displayText,
          openThreads: jsonValue(postprocess?.summary.openThreads ?? []),
          contextSnapshot: jsonValue(contextSnapshot),
          generationMeta: jsonValue({ model: args.model, operationId: task.operationId }),
          consistencyJson: jsonValue(postprocess?.consistencyStatus ?? null),
          status: "ready",
          reviewStatus: "pending",
          aiReview: review?.aiReview ?? "",
          aiActionItems: jsonValue(review?.aiActionItems ?? []),
          modificationRate: review?.modificationRate ?? 0,
          billableChars,
          lastTaskId: task.id,
        },
      });
      await tx.novelChapterVersion.create({
        data: { chapterId: chapter.id, title, content: displayText, billableChars, operationId: task.operationId },
      });
      await tx.novelKnowledgeFact.deleteMany({ where: { projectId: task.projectId, chapterIndex } });
      await tx.novelForeshadowItem.deleteMany({ where: { projectId: task.projectId, introducedInChapterId: chapter.id, introducedInChapterIndex: chapterIndex } });
      const txWithAssets = tx as typeof tx & {
        novelKnowledgeFact?: { upsert: (args: unknown) => Promise<unknown> };
        novelForeshadowItem?: { upsert: (args: unknown) => Promise<unknown> };
      };
      await Promise.all((postprocess?.facts ?? []).map((fact) => txWithAssets.novelKnowledgeFact?.upsert({
        where: {
          projectId_chapterIndex_subject_predicate_object: {
            projectId: task.projectId,
            chapterIndex: fact.chapterIndex ?? chapterIndex,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
          },
        },
        create: {
          projectId: task.projectId,
          chapterId: chapter.id,
          chapterIndex: fact.chapterIndex ?? chapterIndex,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          sourceExcerpt: fact.sourceExcerpt,
          confidence: fact.confidence,
          status: fact.status,
        },
        update: {
          chapterId: chapter.id,
          sourceExcerpt: fact.sourceExcerpt,
          confidence: fact.confidence,
          status: fact.status,
        },
      }) ?? Promise.resolve()));
      await Promise.all((postprocess?.foreshadowItems ?? []).map((item) => txWithAssets.novelForeshadowItem?.upsert({
        where: { projectId_title: { projectId: task.projectId, title: item.title } },
        create: {
          projectId: task.projectId,
          introducedInChapterId: chapter.id,
          introducedInChapterIndex: item.introducedInChapterIndex ?? chapterIndex,
          title: item.title,
          description: item.description,
          expectedPayoffChapter: item.expectedPayoffChapter,
          status: item.status,
          relatedCharacter: item.relatedCharacter,
        },
        // A repeated mention must not rewrite where the foreshadow was first introduced
        // or reopen an item that an editor already resolved.
        update: {},
      }) ?? Promise.resolve()));
    } else if (targetKind === "chapterRewrite") {
      const chapter = await tx.novelChapter.findUnique({ where: { projectId_chapterIndex: { projectId: task.projectId, chapterIndex } } });
      if (!chapter) throw new Error("chapter not found for rewrite");
      const selectedText = String(payload.selectedText || "");
      const start = Math.max(0, Number(payload.selectionStart) || 0);
      const end = Math.max(start, Number(payload.selectionEnd) || start + selectedText.length);
      if (!selectedText || chapter.content.slice(start, end) !== selectedText) throw new Error("章节正文已变化，请重新选择需要改写的内容");
      const nextContent = `${chapter.content.slice(0, start)}${displayText}${chapter.content.slice(end)}`;
      await tx.novelChapterVersion.create({ data: { chapterId: chapter.id, title: chapter.title, content: chapter.content, billableChars: chapter.billableChars } });
      await tx.novelChapter.update({
        where: { id: chapter.id },
        data: {
          content: nextContent,
          billableChars: visibleCharCount(nextContent),
          reviewStatus: "pending",
          reviewedAt: null,
          lastTaskId: task.id,
          generationMeta: jsonValue({ model: args.model, operationId: task.operationId, operation: "chapterRewrite", selectionStart: start, selectionEnd: end }),
        },
      });
    }
    await tx.novelTask.update({
      where: { id: task.id },
      data: {
        status: NOVEL_TASK_STATUS.succeeded,
        progressPercent: 100,
        progressStage: "completed",
        progressMessage: "生成结果已校验并写入作品资料",
        resultPayload: { model: args.model, billableChars, settledPoints: args.settledPoints },
        completedAt: new Date(),
      },
    });
  });
  await refreshNovelVectorMemoryBestEffort(prisma, task.projectId);
}

export async function runNovelTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForNovels;
  readonly generator: NovelGenerator;
  readonly task: NovelTaskRow;
  readonly onChunk?: (chunk: string) => Promise<void>;
}): Promise<void> {
  const { prisma, billing, generator } = args;
  const latestBeforeRun = await prisma.novelTask.findUnique({ where: { id: args.task.id } });
  if (!latestBeforeRun || latestBeforeRun.status === NOVEL_TASK_STATUS.succeeded || latestBeforeRun.status === NOVEL_TASK_STATUS.failed || latestBeforeRun.status === NOVEL_TASK_STATUS.cancelled) return;
  try {
    const claimed = await assertTaskActive(prisma, args.task.id);
    await prisma.novelTask.update({
      where: { id: claimed.id },
      data: {
        status: NOVEL_TASK_STATUS.running,
        error: null,
        progressPercent: 5,
        progressStage: "preparing",
        progressMessage: "Worker 已接收任务，正在读取作品资料",
        progressPreview: "",
        streamedChars: 0,
      },
    });
    const task = await assertTaskActive(prisma, claimed.id);
    const payload = taskPayload(task);
    const project = await prisma.novelProject.findUnique({ where: { id: task.projectId } });
    if (!project) throw new Error("novel project not found");
    const targetKind = task.targetKind as NovelTargetKind;
    const chapterIndex = Number(payload.chapterIndex) || undefined;
    const chapterTitle = String(payload.title || "");
    const chapterSummary = String(payload.summary || "");
    await updateTaskProgress(prisma, task.id, {
      progressPercent: 12,
      progressStage: "context",
      progressMessage: "正在汇总已确认的故事设定与前序资料",
    });
    const contextText = targetKind === "chapter" || targetKind === "chapterRewrite"
      ? [
          await buildChapterContextText({
            prisma,
            project,
            chapterIndex,
            chapterTitle,
            chapterSummary,
          }),
          targetKind === "chapterRewrite"
            ? [`选区前文：\n${String(payload.selectionBefore || "（章首）")}`, `选区后文：\n${String(payload.selectionAfter || "（章尾）")}`].join("\n\n")
            : "",
        ].filter(Boolean).join("\n\n")
      : [
          `故事梗概：${project.premise}`,
          `锁定类型：${project.genre}`,
          `创作设置：${JSON.stringify(project.settings)}`,
          targetKind !== "setupBible" ? `已确认 Bible：${JSON.stringify(await prisma.novelBible.findUnique({ where: { projectId: project.id }, include: { worldDimensions: true, styleNotes: true } }))}` : "",
          targetKind === "setupPlot" ? `主要人物：${JSON.stringify(await prisma.novelCharacter.findMany({ where: { projectId: project.id } }))}` : "",
          targetKind === "setupPlot" ? `地点：${JSON.stringify(await prisma.novelLocation.findMany({ where: { projectId: project.id } }))}` : "",
        ].filter(Boolean).join("\n\n");
    await updateTaskProgress(prisma, task.id, {
      progressPercent: 24,
      progressStage: "prompting",
      progressMessage: "上下文已就绪，正在构建本步骤生成指令",
    });
    const promptStore = prisma as PrismaClient & {
      novelPromptTemplate?: { findUnique: (args: unknown) => Promise<{ content: string; model: string; temperature: number } | null> };
    };
    const template = await promptStore.novelPromptTemplate?.findUnique({
      where: { projectId_nodeKey: { projectId: project.id, nodeKey: promptNodeKey(targetKind) } },
    }) ?? null;
    let templateModel = template?.model || "";
    if (templateModel && billing.listModels) {
      try {
        const models = await billing.listModels();
        if (!models.data.some((item) => item.enabled && item.model === templateModel)) templateModel = "";
      } catch {
        templateModel = "";
      }
    }
    await updateTaskProgress(prisma, task.id, {
      progressPercent: 32,
      progressStage: "generating",
      progressMessage: "生成指令已提交，等待模型开始流式输出",
    });
    let streamedChars = 0;
    let progressPreview = "";
    let lastPersistedAt = 0;
    let lastPersistedChars = 0;
    const modelRequestedAt = Date.now();
    let waitHeartbeat = Promise.resolve();
    let waitTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      if (streamedChars > 0) return;
      const waitingSeconds = Math.max(1, Math.round((Date.now() - modelRequestedAt) / 1000));
      waitHeartbeat = waitHeartbeat
        .then(() => updateTaskProgress(prisma, task.id, {
          progressPercent: 32,
          progressStage: "generating",
          progressMessage: `模型正在处理生成指令，已等待 ${waitingSeconds} 秒，尚未返回首个可展示文本`,
        }))
        .catch(() => undefined);
    }, 5000);
    const expectedChars = expectedStreamChars(targetKind, payload, project.targetChapters);
    const onChunk = async (chunk: string) => {
      await assertTaskActive(prisma, task.id);
      if (streamedChars === 0 && waitTimer) {
        clearInterval(waitTimer);
        waitTimer = undefined;
        await waitHeartbeat;
      }
      streamedChars += streamedCharCount(chunk);
      progressPreview = appendProgressPreview(progressPreview, chunk);
      await args.onChunk?.(chunk);
      const now = Date.now();
      const charsSincePersist = streamedChars - lastPersistedChars;
      if ((now - lastPersistedAt < 700 || charsSincePersist < 80) && charsSincePersist < 500) return;
      const outputRatio = Math.min(1, streamedChars / expectedChars);
      await updateTaskProgress(prisma, task.id, {
        progressPercent: 35 + outputRatio * 49,
        progressStage: "streaming",
        progressMessage: `模型正在流式生成，已接收 ${streamedChars.toLocaleString("zh-CN")} 字`,
        progressPreview,
        streamedChars,
      });
      lastPersistedAt = now;
      lastPersistedChars = streamedChars;
    };
    let result: Awaited<ReturnType<NovelGenerator>>;
    try {
      result = await generator({
        targetKind,
        projectTitle: project.title,
        genre: project.genre,
        userPrompt: String(payload.prompt || ""),
        contextText,
        chapterTitle,
        chapterSummary,
        chapterIndex,
        targetChars: Number(payload.targetChars) || undefined,
        targetCount: Number(payload.targetCount) || undefined,
        promptOverride: template ? renderNovelPromptTemplate(template.content, {
          projectTitle: project.title,
          genre: project.genre,
          chapterNumber: chapterIndex ?? "",
          chapterTitle,
          chapterPlan: chapterSummary,
          context: contextText,
          targetChars: Number(payload.targetChars) || 3000,
          userPrompt: String(payload.prompt || ""),
        }) : undefined,
        modelOverride: templateModel || undefined,
        temperatureOverride: template?.temperature,
        onChunk,
      });
    } finally {
      if (waitTimer) clearInterval(waitTimer);
      await waitHeartbeat;
    }
    await assertTaskActive(prisma, task.id);
    await updateTaskProgress(prisma, task.id, {
      progressPercent: 86,
      progressStage: "validating",
      progressMessage: `模型输出完成，共接收 ${streamedChars.toLocaleString("zh-CN")} 字，正在校验结构`,
      progressPreview,
      streamedChars,
    });
    const parsed = parseRequiredGeneratedNovelValue(targetKind, result.text);
    const billableChars = billableCharCount(targetKind, parsed);
    await updateTaskProgress(prisma, task.id, {
      progressPercent: 91,
      progressStage: "settling",
      progressMessage: "输出结构校验通过，正在核算本次生成用量",
    });
    const settled = await billing.settleResource({
      operationId: task.operationId,
      resourceKey: NOVEL_RESOURCE_KEY,
      units: billableChars,
    });
    await updateTaskProgress(prisma, task.id, {
      progressPercent: 96,
      progressStage: "saving",
      progressMessage: "用量核算完成，正在写入作品资料",
    });
    await saveGeneratedResult({ prisma, task, parsed, model: result.model, billableChars, settledPoints: settled.settled });
  } catch (error) {
    await billing.refundResource(args.task.operationId).catch(() => undefined);
    const status = error instanceof NovelTaskStoppedError ? NOVEL_TASK_STATUS.cancelled : NOVEL_TASK_STATUS.failed;
    const message = status === NOVEL_TASK_STATUS.cancelled ? "用户已取消" : safeErrorMessage(error);
    await prisma.novelTask.update({
      where: { id: args.task.id },
      data: {
        status,
        progressStage: status,
        progressMessage: message,
        error: message,
        cancelledAt: status === NOVEL_TASK_STATUS.cancelled ? new Date() : undefined,
      },
    }).catch(() => undefined);
  }
}

export async function nextChapterIndex(prisma: PrismaClient, projectId: string): Promise<number> {
  const chapters = await prisma.novelChapter.findMany({
    where: { projectId },
    orderBy: { chapterIndex: "asc" },
    select: { chapterIndex: true, content: true },
  });
  return nextNovelChapterIndex(chapters);
}
