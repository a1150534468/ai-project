import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { billableCharCount, formatGeneratedNovelDisplayText, parseGeneratedNovelValue, parseRequiredGeneratedNovelValue, visibleCharCount } from "./novel-billable.js";
import { chapterPlansFromOutline } from "./novel-chapter-plans.js";
import type { NovelGenerator } from "./novel-generation.js";
import { NOVEL_RESOURCE_KEY, NOVEL_STAGE_KINDS, NOVEL_TASK_STATUS, type NovelStageKind, type NovelTargetKind } from "./novel-types.js";
import { NOVEL_STAGE_LABELS } from "./novel-prompts.js";
import { buildNovelVectorMemoryContext, refreshNovelVectorMemory } from "./novel-vector-memory.js";

export interface BillingForNovels {
  reserveResource: (args: { operationId: string; userId: string; resourceKey: string; units: number }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}

export interface NovelTaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly operationId: string;
  readonly status: string;
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

function countOrDefault(targetCount: number | undefined, fallback: number): number {
  return Math.max(1, targetCount ?? fallback);
}

export function estimateReserveChars(targetKind: NovelTargetKind, targetChars?: number, targetCount?: number): number {
  if (targetKind === "chapter") return Math.max(1000, Math.min(targetChars ?? 3000, 12000));
  if (targetKind === "outline") return Math.min(16000, Math.max(10000, countOrDefault(targetCount, 12) * 800));
  if (targetKind === "volumes") return Math.min(12000, Math.max(6000, countOrDefault(targetCount, 6) * 900));
  if (targetKind === "chars") return Math.min(12000, Math.max(5000, countOrDefault(targetCount, 6) * 700));
  if (targetKind === "world") return 6000;
  return 3000;
}

function operationId(): string {
  return `novel:${randomUUID()}`;
}

function stageOrder(kind: string): number {
  const index = NOVEL_STAGE_KINDS.findIndex((item) => item === kind);
  return index >= 0 ? index : NOVEL_STAGE_KINDS.length;
}

type NovelMemoryStore = Pick<PrismaClient, "novelChapter" | "novelSection" | "novelSectionVersion">;

type NovelMemoryChapter = {
  readonly chapterIndex: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
};

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerpt(text: string, maxChars: number): string {
  const compacted = compactLine(text);
  const chars = Array.from(compacted);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}...` : compacted;
}

function buildLongMemoryDisplayText(chapters: readonly NovelMemoryChapter[]): string {
  const completed = chapters
    .filter((chapter) => chapter.content.trim())
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
  if (completed.length === 0) return "";
  const remembered = completed.slice(-24);
  const lastChapter = completed[completed.length - 1];
  if (!lastChapter) return "";
  const chapterBlocks = remembered.map((chapter) => [
    `第 ${chapter.chapterIndex} 章 ${chapter.title.trim() || "未命名"}`,
    chapter.summary.trim() ? `摘要：${compactLine(chapter.summary)}` : "",
    `正文要点：${excerpt(chapter.content, 260)}`,
  ].filter(Boolean).join("\n"));
  return [
    "【长篇记忆】",
    `已记忆至第 ${lastChapter.chapterIndex} 章。`,
    "",
    "章节进展：",
    chapterBlocks.join("\n\n"),
  ].join("\n").trim();
}

export async function refreshNovelLongMemory(args: {
  readonly store: NovelMemoryStore;
  readonly projectId: string;
  readonly sourceTaskId: string | null;
  readonly operationId?: string;
  readonly recordVersion: boolean;
}): Promise<void> {
  const chapters = await args.store.novelChapter.findMany({
    where: { projectId: args.projectId },
    orderBy: { chapterIndex: "asc" },
  });
  const displayText = buildLongMemoryDisplayText(chapters);
  const existing = (await args.store.novelSection.findMany({ where: { projectId: args.projectId } }))
    .find((section) => section.kind === "draft");
  const status = displayText ? "ready" : "empty";
  const billableChars = visibleCharCount(displayText);
  const lastTaskId = args.sourceTaskId ?? existing?.lastTaskId ?? null;
  if (
    existing &&
    existing.status === status &&
    existing.displayText === displayText &&
    existing.billableChars === billableChars &&
    existing.lastTaskId === lastTaskId
  ) {
    return;
  }
  const section = await args.store.novelSection.upsert({
    where: { projectId_kind: { projectId: args.projectId, kind: "draft" } },
    create: {
      projectId: args.projectId,
      kind: "draft",
      status,
      displayText,
      structuredJson: Prisma.JsonNull,
      billableChars,
      lastTaskId,
    },
    update: {
      status,
      displayText,
      structuredJson: Prisma.JsonNull,
      billableChars,
      lastTaskId,
    },
  });
  if (args.recordVersion && existing?.displayText !== displayText) {
    await args.store.novelSectionVersion.create({
      data: {
        sectionId: section.id,
        displayText,
        structuredJson: Prisma.JsonNull,
        billableChars,
        operationId: args.operationId,
      },
    });
  }
}

export function serializeTask(task: NovelTaskRow) {
  return {
    id: task.id,
    projectId: task.projectId,
    targetKind: task.targetKind,
    targetId: task.targetId,
    status: task.status,
    requestPayload: task.requestPayload,
    error: task.error,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    cancelledAt: task.cancelledAt?.toISOString() ?? null,
  };
}

export async function ensureProjectSections(prisma: PrismaClient, projectId: string): Promise<void> {
  await Promise.all(NOVEL_STAGE_KINDS.map((kind) =>
    prisma.novelSection.upsert({
      where: { projectId_kind: { projectId, kind } },
      create: { projectId, kind },
      update: {},
    })
  ));
}

async function syncChaptersFromOutline(prisma: PrismaClient, projectId: string, sections: readonly {
  readonly kind: string;
  readonly displayText: string;
  readonly structuredJson: Prisma.JsonValue | null;
}[]): Promise<void> {
  const outline = sections.find((section) => section.kind === "outline");
  if (!outline) return;
  const plans = chapterPlansFromOutline({ displayText: outline.displayText, structuredJson: outline.structuredJson });
  if (plans.length === 0) return;
  const existing = await prisma.novelChapter.findMany({ where: { projectId } });
  const existingIndexes = new Set(existing.map((chapter) => chapter.chapterIndex));
  await Promise.all(plans
    .filter((plan) => !existingIndexes.has(plan.chapterIndex))
    .map((plan) => prisma.novelChapter.create({
      data: {
        projectId,
        chapterIndex: plan.chapterIndex,
        title: plan.title,
        summary: plan.summary,
        status: "draft",
        billableChars: 0,
      },
    })));
}

export async function getProjectDetail(prisma: PrismaClient, userId: string, projectId: string) {
  const project = await prisma.novelProject.findFirst({
    where: { id: projectId, userId },
    include: {
      sections: true,
      tasks: { orderBy: { updatedAt: "desc" }, take: 20 },
    },
  });
  if (!project) return null;
  await ensureProjectSections(prisma, project.id);
  const sectionsBeforeSync = (await prisma.novelSection.findMany({ where: { projectId: project.id } }))
    .sort((a, b) => stageOrder(a.kind) - stageOrder(b.kind));
  await syncChaptersFromOutline(prisma, project.id, sectionsBeforeSync);
  await refreshNovelLongMemory({
    store: prisma,
    projectId: project.id,
    sourceTaskId: null,
    recordVersion: false,
  });
  const sections = (await prisma.novelSection.findMany({ where: { projectId: project.id } }))
    .sort((a, b) => stageOrder(a.kind) - stageOrder(b.kind));
  const chapters = await prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" } });
  return {
    project: {
      id: project.id,
      title: project.title,
      genre: project.genre,
      status: project.status,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    sections: sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      label: NOVEL_STAGE_LABELS[section.kind as NovelStageKind] ?? section.kind,
      status: section.status,
      displayText: section.displayText,
      billableChars: section.billableChars,
      lastTaskId: section.lastTaskId,
      updatedAt: section.updatedAt.toISOString(),
    })),
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      volumeIndex: chapter.volumeIndex,
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      summary: chapter.summary,
      content: chapter.content,
      status: chapter.status,
      billableChars: chapter.billableChars,
      lastTaskId: chapter.lastTaskId,
      updatedAt: chapter.updatedAt.toISOString(),
    })),
    tasks: project.tasks.map(serializeTask),
  };
}

async function buildContextText(prisma: PrismaClient, projectId: string): Promise<string> {
  const [sections, chapters] = await Promise.all([
    prisma.novelSection.findMany({ where: { projectId } }),
    prisma.novelChapter.findMany({ where: { projectId }, orderBy: { chapterIndex: "asc" }, take: 12 }),
  ]);
  const sectionText = sections
    .filter((section) => section.displayText.trim())
    .sort((a, b) => stageOrder(a.kind) - stageOrder(b.kind))
    .map((section) => `${NOVEL_STAGE_LABELS[section.kind as NovelStageKind] ?? section.kind}：\n${section.displayText}`)
    .join("\n\n");
  const chapterText = chapters
    .map((chapter) => `第 ${chapter.chapterIndex} 章 ${chapter.title || "未命名"}：${chapter.summary || chapter.content.slice(0, 160)}`)
    .join("\n");
  return [sectionText, chapterText].filter(Boolean).join("\n\n");
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
  const baseContextText = await buildContextText(args.prisma, args.project.id);
  try {
    const vectorContextText = await buildNovelVectorMemoryContext({
      store: args.prisma,
      projectId: args.project.id,
      projectTitle: args.project.title,
      genre: args.project.genre,
      chapterIndex: args.chapterIndex,
      chapterTitle: args.chapterTitle,
      chapterSummary: args.chapterSummary,
    });
    return [baseContextText, vectorContextText].filter(Boolean).join("\n\n");
  } catch (error) {
    if (error instanceof Error) return baseContextText;
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
}): Promise<NovelTaskRow> {
  const opId = operationId();
  await args.billing.reserveResource({
    operationId: opId,
    userId: args.userId,
    resourceKey: NOVEL_RESOURCE_KEY,
    units: args.estimateChars,
  });
  try {
    return await args.prisma.novelTask.create({
      data: {
        projectId: args.projectId,
        userId: args.userId,
        kind: "generate",
        targetKind: args.targetKind,
        targetId: args.targetId ?? null,
        status: NOVEL_TASK_STATUS.queued,
        requestPayload: jsonValue(args.payload),
        operationId: opId,
      },
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

  await prisma.$transaction(async (tx) => {
    if (targetKind === "chapter") {
      const chapterIndex = Number(payload.chapterIndex) || 1;
      const generatedTitle = isRecord(args.parsed) && typeof args.parsed.title === "string" ? args.parsed.title.trim() : "";
      const title = generatedTitle || String(payload.title || `第 ${chapterIndex} 章`);
      const chapter = await tx.novelChapter.upsert({
        where: { projectId_chapterIndex: { projectId: task.projectId, chapterIndex } },
        create: {
          projectId: task.projectId,
          chapterIndex,
          title,
          summary: String(payload.summary || ""),
          content: displayText,
          status: "ready",
          billableChars,
          lastTaskId: task.id,
        },
        update: {
          title,
          summary: String(payload.summary || ""),
          content: displayText,
          status: "ready",
          billableChars,
          lastTaskId: task.id,
        },
      });
      await tx.novelChapterVersion.create({
        data: { chapterId: chapter.id, title, content: displayText, billableChars, operationId: task.operationId },
      });
      await refreshNovelLongMemory({
        store: tx,
        projectId: task.projectId,
        sourceTaskId: task.id,
        operationId: task.operationId,
        recordVersion: true,
      });
    } else {
      const structuredJson = typeof args.parsed === "string" ? Prisma.JsonNull : jsonValue(args.parsed);
      const section = await tx.novelSection.upsert({
        where: { projectId_kind: { projectId: task.projectId, kind: targetKind } },
        create: {
          projectId: task.projectId,
          kind: targetKind,
          status: "ready",
          displayText,
          structuredJson,
          billableChars,
          lastTaskId: task.id,
        },
        update: {
          status: "ready",
          displayText,
          structuredJson,
          billableChars,
          lastTaskId: task.id,
        },
      });
      await tx.novelSectionVersion.create({
        data: { sectionId: section.id, displayText, structuredJson, billableChars, operationId: task.operationId },
      });
    }
    await tx.novelTask.update({
      where: { id: task.id },
      data: {
        status: NOVEL_TASK_STATUS.succeeded,
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
}): Promise<void> {
  const { prisma, billing, generator } = args;
  try {
    const claimed = await assertTaskActive(prisma, args.task.id);
    await prisma.novelTask.update({ where: { id: claimed.id }, data: { status: NOVEL_TASK_STATUS.running, error: null } });
    const task = await assertTaskActive(prisma, claimed.id);
    const payload = taskPayload(task);
    const project = await prisma.novelProject.findUnique({ where: { id: task.projectId } });
    if (!project) throw new Error("novel project not found");
    const targetKind = task.targetKind as NovelTargetKind;
    const chapterIndex = Number(payload.chapterIndex) || undefined;
    const chapterTitle = String(payload.title || "");
    const chapterSummary = String(payload.summary || "");
    const result = await generator({
      targetKind,
      projectTitle: project.title,
      genre: project.genre,
      userPrompt: String(payload.prompt || ""),
      contextText: targetKind === "chapter"
        ? await buildChapterContextText({
          prisma,
          project,
          chapterIndex,
          chapterTitle,
          chapterSummary,
        })
        : await buildContextText(prisma, project.id),
      chapterTitle,
      chapterSummary,
      chapterIndex,
      targetChars: Number(payload.targetChars) || undefined,
      targetCount: Number(payload.targetCount) || undefined,
    });
    await assertTaskActive(prisma, task.id);
    const parsed = parseRequiredGeneratedNovelValue(targetKind, result.text);
    const billableChars = billableCharCount(targetKind, parsed);
    const settled = await billing.settleResource({
      operationId: task.operationId,
      resourceKey: NOVEL_RESOURCE_KEY,
      units: billableChars,
    });
    await saveGeneratedResult({ prisma, task, parsed, model: result.model, billableChars, settledPoints: settled.settled });
  } catch (error) {
    await billing.refundResource(args.task.operationId).catch(() => undefined);
    const status = error instanceof NovelTaskStoppedError ? NOVEL_TASK_STATUS.cancelled : NOVEL_TASK_STATUS.failed;
    await prisma.novelTask.update({
      where: { id: args.task.id },
      data: {
        status,
        error: status === NOVEL_TASK_STATUS.cancelled ? "用户已取消" : safeErrorMessage(error),
        cancelledAt: status === NOVEL_TASK_STATUS.cancelled ? new Date() : undefined,
      },
    }).catch(() => undefined);
  }
}

export async function nextChapterIndex(prisma: PrismaClient, projectId: string): Promise<number> {
  const last = await prisma.novelChapter.findFirst({
    where: { projectId },
    orderBy: { chapterIndex: "desc" },
  });
  return (last?.chapterIndex ?? 0) + 1;
}
