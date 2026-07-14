import type { PrismaClient } from "@prisma/client";
import { enqueueNovelEngineStep, enqueueNovelGenerationTask } from "./queue.js";

const OUTBOX_BATCH_SIZE = 50;

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
      if (row.stepId) await enqueueNovelEngineStep(row.stepId, row.priority);
      else if (row.taskId) await enqueueNovelGenerationTask(row.taskId);
      else throw new Error("outbox command is missing stepId/taskId");
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

export async function recoverInterruptedNovelSteps(prisma: PrismaClient, staleBefore = new Date(Date.now() - 5 * 60_000)): Promise<number> {
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
  runningBefore = new Date(Date.now() - 5 * 60_000),
): Promise<number> {
  const tasks = await prisma.novelTask.findMany({
    where: {
      targetId: null,
      OR: [
        { status: "queued", updatedAt: { lt: queuedBefore } },
        { status: "running", updatedAt: { lt: runningBefore } },
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
        create: { projectId: task.projectId, taskId: task.id, payload: { type: "generation-task", taskId: task.id }, priority: 1, jobName: "generation-task" },
        update: { status: "pending", availableAt: new Date(), sentAt: null, lastError: null },
      });
    });
  }
  return tasks.length;
}
