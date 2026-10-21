import type { PrismaClient } from "@prisma/client";
// 直接指到叶子，不走 workflow/novel 的门面：门面里排着 novel-routes 等会绕回 src/novel
// 的模块，而本文件在**模块求值期**就要用 NOVEL_TARGET_KINDS.filter(...)，
// 走门面等于在环里取一个还没初始化的绑定（TypeError: Cannot read properties of undefined）。
import { NOVEL_TARGET_KINDS, type NovelTargetKind } from "../workflow/novel/novel-types.js";
import { enqueueNovelEngineStep, enqueueNovelGenerationTask } from "./queue.js";

const OUTBOX_BATCH_SIZE = 50;
export const NOVEL_INTERRUPTED_WORK_MS = 90_000;

/**
 * `NovelTask.targetId` 是一列两义：引擎写的是 `NovelRunStep.id`，局部改写写的是 `NovelChapter.id`。
 * 这张表登记每种 targetKind 的 targetId 会不会是 step id —— 也就是这个 task 归不归 step 恢复管。
 *
 * 归 step 管的必须从 `recoverInterruptedNovelTasks` 里排除：step 重排后引擎会按 targetId 找回同一行
 * task 续跑（`novel/runner.ts:58`），两边都捞就会把同一份生成重复入队、烧两次模型调用。
 *
 * 类型是 `Record<NovelTargetKind, boolean>`，所以往 `NOVEL_TARGET_KINDS` 加新种类时这里会编译报错，
 * 逼人显式表态。别改成 `Partial`，那等于把这道闸拆了。
 */
const TARGET_ID_HOLDS_STEP_ID: Record<NovelTargetKind, boolean> = {
  setupBible: false,
  setupCharacters: false,
  setupLocations: false,
  setupPlot: false,
  // 引擎章节步骤存 step id；路由直发的章节 targetId 为 null，靠下面的 `targetId: null` 分支放行。
  chapter: true,
  // 存的是章节 id。曾因为被当成 step id 而完全落在两套恢复之外（P0.6 查出）。
  chapterRewrite: false,
};

const STEP_OWNED_TARGET_KINDS = NOVEL_TARGET_KINDS.filter((kind) => TARGET_ID_HOLDS_STEP_ID[kind]);

/** outbox 命令的判别联合：kind 列是唯一判别来源（#12 起），解析时校验对应 id 存在。 */
export type NovelOutboxCommand =
  | { readonly kind: "engine-step"; readonly stepId: string }
  | { readonly kind: "generation-task"; readonly taskId: string };

export function outboxCommandOf(row: { kind: string; stepId: string | null; taskId: string | null }): NovelOutboxCommand {
  switch (row.kind) {
    case "engine-step":
      if (row.stepId) return { kind: "engine-step", stepId: row.stepId };
      break;
    case "generation-task":
      if (row.taskId) return { kind: "generation-task", taskId: row.taskId };
      break;
    default:
      break;
  }
  // kind 与 id 不一致（迁移前在途行/脏数据）时按 id 兜底，保持旧分发行为；两者皆无才判坏行。
  if (row.stepId) return { kind: "engine-step", stepId: row.stepId };
  if (row.taskId) return { kind: "generation-task", taskId: row.taskId };
  throw new Error("outbox command is missing stepId/taskId");
}

export async function dispatchNovelOutboxBatch(prisma: PrismaClient, now = new Date()): Promise<number> {
  const rows = await prisma.novelCommandOutbox.findMany({
    where: { status: "pending", availableAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: OUTBOX_BATCH_SIZE,
  });
  let sent = 0;
  for (const row of rows) {
    const claimed = await prisma.novelCommandOutbox.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "dispatching", attempts: { increment: 1 }, lastError: null },
    });
    if (claimed.count !== 1) continue;
    try {
      const command = outboxCommandOf(row);
      switch (command.kind) {
        case "engine-step":
          await enqueueNovelEngineStep(command.stepId, row.priority);
          break;
        case "generation-task":
          await enqueueNovelGenerationTask(command.taskId);
          break;
      }
      await prisma.novelCommandOutbox.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date(), lastError: null },
      });
      sent += 1;
    } catch (error) {
      const delaySeconds = Math.min(60, Math.max(2, 2 ** Math.min(row.attempts + 1, 5)));
      await prisma.novelCommandOutbox.update({
        where: { id: row.id },
        data: {
          status: "pending",
          availableAt: new Date(Date.now() + delaySeconds * 1000),
          lastError: error instanceof Error ? error.message.slice(0, 500) : "outbox dispatch failed",
        },
      });
    }
  }
  return sent;
}

export async function recoverInterruptedNovelSteps(prisma: PrismaClient, staleBefore = new Date(Date.now() - NOVEL_INTERRUPTED_WORK_MS)): Promise<number> {
  const stale = await prisma.novelRunStep.findMany({
    where: { status: "running", updatedAt: { lt: staleBefore } },
    select: { id: true, runId: true, priority: true },
  });
  for (const step of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.novelRunStep.update({
        where: { id: step.id },
        data: { status: "queued", workerId: null, startedAt: null, error: "Worker 中断，已重新排队" },
      });
      await tx.novelCommandOutbox.upsert({
        where: { stepId: step.id },
        create: {
          projectId: (await tx.novelRun.findUniqueOrThrow({ where: { id: step.runId } })).projectId,
          runId: step.runId,
          stepId: step.id,
          kind: "engine-step",
          payload: { type: "engine-step", stepId: step.id },
          priority: step.priority,
        },
        update: { status: "pending", availableAt: new Date(), sentAt: null, lastError: null },
      });
    });
  }
  return stale.length;
}

export async function recoverInterruptedNovelTasks(
  prisma: PrismaClient,
  queuedBefore = new Date(Date.now() - 60_000),
  runningBefore = new Date(Date.now() - NOVEL_INTERRUPTED_WORK_MS),
): Promise<number> {
  const tasks = await prisma.novelTask.findMany({
    where: {
      AND: [
        // 放行"不归 step 管"的两类：targetId 为空的（setup / 路由直发章节），
        // 以及 targetId 非空但存的不是 step id 的（chapterRewrite 存章节 id）。
        { OR: [{ targetId: null }, { targetKind: { notIn: STEP_OWNED_TARGET_KINDS } }] },
        {
          OR: [
            { status: "queued", updatedAt: { lt: queuedBefore } },
            { status: "running", updatedAt: { lt: runningBefore } },
          ],
        },
      ],
    },
    select: { id: true, projectId: true, status: true },
    take: 100,
  });
  for (const task of tasks) {
    await prisma.$transaction(async (tx) => {
      if (task.status === "running") await tx.novelTask.update({
        where: { id: task.id },
        data: {
          status: "queued",
          progressPercent: 0,
          progressStage: "queued",
          progressMessage: "Worker 中断，任务已重新排队",
          progressPreview: "",
          streamedChars: 0,
          error: "Worker 中断，已重新排队",
        },
      });
      await tx.novelCommandOutbox.upsert({
        where: { taskId: task.id },
        create: { projectId: task.projectId, taskId: task.id, kind: "generation-task", payload: { type: "generation-task", taskId: task.id }, priority: 1, jobName: "generation-task" },
        update: { status: "pending", availableAt: new Date(), sentAt: null, lastError: null },
      });
    });
  }
  return tasks.length;
}
