/**
 * novel-task-runner 拆分后的落库层:开头的"建任务"(`reserveAndCreateTask`)与
 * 结尾的"结果写回作品资料"(`saveGeneratedResult`)。
 *
 * 两个函数放一起是因为它们是同一条任务的两端:一个建出 queued 行,一个把它改成 succeeded。
 *
 * `reserveAndCreateTask` 的建单与 outbox 写在同一个 `$transaction` 里:任务行存在而 outbox
 * 缺失会得到一条永远没人接的 queued 任务,反过来则会让 worker 取到不存在的 taskId。
 *
 * `saveGeneratedResult` 整个写回也在一个 `$transaction` 里,并且**任务状态改 succeeded 是事务的
 * 最后一步**。顺序反了就会出现"任务显示成功、章节没落库"的不可恢复状态。
 *
 * `chapterRewrite` 分支会先校验 `chapter.content.slice(start, end) === selectedText`。这不是
 * 多余的防御:选区偏移是按提交时的正文算的,期间正文被改过就必须让这次改写失败,否则会把
 * 生成结果插到错误的位置并覆盖真实内容。
 *
 * 依赖方向:shared / context → 本文件。不 import read / run。
 */

import type { PrismaClient } from "@prisma/client";
import { formatGeneratedNovelDisplayText, resolveNovelChapterTitle, visibleCharCount } from "./novel-billable.js";
import { NOVEL_TASK_STATUS, type NovelTargetKind } from "./novel-types.js";
import { buildNovelChapterPostprocessPayload } from "./novel-postprocess.js";
import { buildNovelReviewPayload } from "./novel-review.js";
import { syncNovelContinuityAssetsForChapter } from "../../novel/continuity-assets.js";
import { syncNovelNarrativeLedgersForChapter } from "../../novel/narrative-ledger.js";
import { syncNovelSetupAssets } from "../../novel/structured-sync.js";
import { isPlainObject } from "../../runtime/records.js";
import {
  isSetupTargetKind,
  jsonValue,
  operationId,
  taskPayload,
  type NovelTaskRow,
} from "./novel-task-shared.js";
import { loadNovelGenerationContextPayload, refreshNovelVectorMemoryBestEffort } from "./novel-task-context.js";

export async function reserveAndCreateTask(args: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly projectId: string;
  readonly targetKind: NovelTargetKind;
  readonly targetId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly delivery?: "inline" | "worker-outbox";
}): Promise<NovelTaskRow> {
  const opId = operationId();
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
}

export async function saveGeneratedResult(args: {
  readonly prisma: PrismaClient;
  readonly task: NovelTaskRow;
  readonly parsed: unknown;
  readonly model: string;
  readonly billableChars: number;
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
  const generatedTitle = targetKind === "chapter" && isPlainObject(args.parsed) && typeof args.parsed.title === "string" ? args.parsed.title.trim() : "";
  const requestedTitle = isChapterTarget ? String(payload.title || `第 ${chapterIndex} 章`) : "";
  const title = targetKind === "chapter" ? resolveNovelChapterTitle({ requestedTitle, generatedTitle, content: displayText, chapterIndex }) : requestedTitle;
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
      if (title !== requestedTitle) {
        await tx.novelStructureNode.updateMany({ where: { projectId: task.projectId, nodeType: "chapter", number: chapterIndex }, data: { title } });
      }
      await tx.novelChapterVersion.create({
        data: { chapterId: chapter.id, title, content: displayText, billableChars, operationId: task.operationId },
      });
      await tx.novelKnowledgeFact.deleteMany({ where: { projectId: task.projectId, chapterIndex } });
      const txWithAssets = tx as typeof tx & {
        novelKnowledgeFact?: { upsert: (args: unknown) => Promise<unknown> };
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
      if (postprocess) {
        await syncNovelNarrativeLedgersForChapter({
          store: tx,
          projectId: task.projectId,
          chapterId: chapter.id,
          chapterIndex,
          content: displayText,
          foreshadowItems: postprocess.foreshadowItems,
        });
        await syncNovelContinuityAssetsForChapter({
          store: tx,
          projectId: task.projectId,
          chapterIndex,
          title,
          content: displayText,
          eventCards: postprocess.consistencyStatus.chapterAssets.eventCards,
          knownCharacters: knownCharacters.map((item) => item.name),
          knownLocations: knownLocations.map((item) => item.name),
        });
      }
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
        resultPayload: { model: args.model, billableChars },
        completedAt: new Date(),
      },
    });
  });
  await refreshNovelVectorMemoryBestEffort(prisma, task.projectId);
}
