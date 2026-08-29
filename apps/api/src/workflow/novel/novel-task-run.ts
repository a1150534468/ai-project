/**
 * novel-task-runner 拆分后的执行层:`runNovelTask` 从领取任务到结算落库的整条主流程,
 * 加上它独占的进度上报、取消检查、提示词模板渲染。
 *
 * `NovelTaskStoppedError`、它唯一的抛出点 `assertTaskActive`、以及唯一的 `instanceof` 捕获点
 * (`runNovelTask` 的 catch 里据此把状态判成 cancelled 而不是 failed)必须留在同一个文件。
 * 把类挪出去就会出现"两个 instanceof 各指一个类"的隐性回归 —— 表现是用户主动取消被记成
 * 生成失败。
 *
 * `assertTaskActive` 在四个点上被调:领取时、置 running 后、每个 chunk、以及输出结束时。
 * 少任何一处都会让"取消"在那一段时间内不生效,而模型仍在烧点数。
 *
 * `waitTimer` / `waitHeartbeat` 这套心跳只在 `streamedChars === 0` 时上报等待秒数,首个 chunk
 * 到达就 `clearInterval` 并 await 掉在飞的那一次上报。`finally` 里再兜一次 clear —— 漏了它,
 * 生成失败的任务会留下一个永久 5 秒一次写库的定时器。
 *
 * catch 块里先 `refundResource` 再改任务状态,且两步都 `.catch(() => undefined)`:退款失败不能
 * 阻止任务被标记为失败,否则任务会永远停在 running 等兜底扫。
 *
 * 依赖方向:shared / context / persist → 本文件。不 import read,不 import 门面。
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { billableCharCount, parseRequiredGeneratedNovelValue } from "./novel-billable.js";
import type { NovelGenerator } from "./novel-generation.js";
import type { NovelPreparedRequest } from "./novel-prompts.js";
import { NOVEL_RESOURCE_KEY, NOVEL_TASK_STATUS, type NovelTargetKind } from "./novel-types.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import { findEnabledNovelModel, novelWritingModel } from "./novel-models.js";
import { taskPayload, type BillingForNovels, type NovelTaskRow } from "./novel-task-shared.js";
import { buildChapterContextText } from "./novel-task-context.js";
import { saveGeneratedResult } from "./novel-task-persist.js";

class NovelTaskStoppedError extends Error {
  constructor() {
    super("任务已取消");
    this.name = "NovelTaskStoppedError";
  }
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

function promptNodeKey(targetKind: NovelTargetKind): string {
  if (targetKind === "chapter") return "chapter-writing";
  if (targetKind === "chapterRewrite") return "chapter-rewrite";
  return `${targetKind}-generation`;
}

function renderNovelPromptTemplate(content: string, variables: Record<string, string | number>): string {
  return content.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (_match, key: string) => String(variables[key] ?? ""));
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
      novelPromptTemplate?: { findUnique: (args: unknown) => Promise<{ id: string; content: string; model: string; temperature: number; activeVersion: number } | null> };
    };
    const template = await promptStore.novelPromptTemplate?.findUnique({
      where: { projectId_nodeKey: { projectId: project.id, nodeKey: promptNodeKey(targetKind) } },
    }) ?? null;
    const templateModel = template?.model || "";
    let requestedModel = templateModel || novelWritingModel(project.generationPrefs);
    if (requestedModel && billing.listModels) {
      try {
        const models = await billing.listModels();
        const selected = findEnabledNovelModel(models.data, requestedModel);
        if (!selected || (!templateModel && selected.showInMarketplace !== true)) requestedModel = "";
      } catch {
        requestedModel = "";
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
    let requestRecorded = false;
    const persistPreparedRequest = async (prepared: NovelPreparedRequest) => {
      const [chapter, step, previousAttempts] = await Promise.all([
        chapterIndex ? prisma.novelChapter.findUnique({ where: { projectId_chapterIndex: { projectId: project.id, chapterIndex } }, select: { id: true } }) : null,
        task.targetId ? prisma.novelRunStep.findUnique({ where: { id: task.targetId }, select: { id: true, runId: true, attempt: true } }) : null,
        chapterIndex ? prisma.novelGenerationRequest.count({ where: { projectId: project.id, chapterIndex, targetKind } }) : Promise.resolve(0),
      ]);
      const requestHash = createHash("sha256").update(JSON.stringify(prepared)).digest("hex");
      await prisma.novelGenerationRequest.upsert({
        where: { taskId: task.id },
        create: {
          projectId: project.id,
          chapterId: chapter?.id ?? null,
          chapterIndex: chapterIndex ?? null,
          taskId: task.id,
          runId: step?.runId ?? null,
          stepId: step?.id ?? null,
          targetKind,
          attempt: step ? Math.max(1, step.attempt) : previousAttempts + 1,
          systemPrompt: prepared.systemPrompt,
          userPrompt: prepared.userPrompt,
          model: prepared.model,
          temperature: prepared.temperature ?? null,
          maxTokens: prepared.maxTokens,
          templateId: template?.id ?? null,
          templateVersion: template?.activeVersion ?? null,
          requestHash,
          status: "submitted",
        },
        update: {},
      });
      requestRecorded = true;
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
        modelOverride: requestedModel || undefined,
        temperatureOverride: template?.temperature,
        onRequestPrepared: persistPreparedRequest,
        onChunk,
      });
      if (requestRecorded) await prisma.novelGenerationRequest.updateMany({ where: { taskId: task.id }, data: { status: "succeeded", error: null } });
    } catch (error) {
      if (requestRecorded) await prisma.novelGenerationRequest.updateMany({ where: { taskId: task.id }, data: { status: "failed", error: errorMessageOrFallback(error, "生成失败") } }).catch(() => undefined);
      throw error;
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
    const message = status === NOVEL_TASK_STATUS.cancelled ? "用户已取消" : errorMessageOrFallback(error, "生成失败");
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
