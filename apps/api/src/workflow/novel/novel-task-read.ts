/**
 * novel-task-runner 拆分后的读取层:任务对外 JSON 形状、项目详情聚合读、下一章序号。
 *
 * `serializeTask` 是任务行对前端可见形状的唯一出处;`getProjectDetail` 里逐字段列出的
 * project / bible / chapters 也是同一个约定（compact 章节使用独立 allowlist） —— 这里不 `...spread` 库行,是为了让"新增库字段
 * 默认不外泄"成为默认行为。要给前端就往这里加一行,不给就什么都不做。
 *
 * `nextChapterIndex` 只负责读齐章节再交给 `nextNovelChapterIndex` 判:序号规则(空洞、
 * 空正文章节算不算占位)在 novel-workflow 包里,别在这里再写一份。
 *
 * 依赖方向:shared → 本文件。不 import context / persist / run。
 */

import { novelChapterSummarySelect, serializeNovelChapterSummary } from "./novel-chapter-summary.js";
import type { PrismaClient } from "@prisma/client";
import { nextNovelChapterIndex } from "@ai-assistant/novel-workflow";
import type { NovelTaskRow } from "./novel-task-shared.js";

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

/** Polling/setup views need progress, not saved model requests or completed prose. */
export function serializeCompactNovelTask(task: NovelTaskRow) {
  const serialized = serializeTask(task);
  return { ...serialized, requestPayload: null, progressPreview: ["queued", "running"].includes(task.status) ? (task.progressPreview ?? "").slice(-4000) : "" };
}

export async function getProjectDetail(prisma: PrismaClient, userId: string, projectId: string, compact = false) {
  const project = await prisma.novelProject.findFirst({
    where: { id: projectId, userId },
    include: {
      tasks: { orderBy: { updatedAt: "desc" }, take: 20 },
      bible: { include: { worldDimensions: { orderBy: { position: "asc" } }, styleNotes: { orderBy: { position: "asc" } } } },
    },
  });
  if (!project) return null;
  const chapters = await prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" }, ...(compact ? { select: novelChapterSummarySelect } : {}) });
  return {
    project: {
      id: project.id,
      title: project.title,
      genre: project.genre,
      premise: project.premise,
      settings: project.settings,
      generationPrefs: project.generationPrefs,
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
    chapters: compact ? chapters.map(serializeNovelChapterSummary) : chapters.map((chapter) => ({
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
    tasks: project.tasks.map((task) => compact ? serializeCompactNovelTask(task) : serializeTask(task)),
  };
}

export async function nextChapterIndex(prisma: PrismaClient, projectId: string): Promise<number> {
  const chapters = await prisma.novelChapter.findMany({
    where: { projectId },
    orderBy: { chapterIndex: "asc" },
    select: { chapterIndex: true, content: true },
  });
  return nextNovelChapterIndex(chapters);
}
