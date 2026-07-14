import type { PrismaClient } from "@ai-assistant/db";
import type { Redis } from "ioredis";
import { InsufficientBalanceError, type createBillingClient } from "@ai-assistant/billing";
import { SCHED, SCHED_KEY } from "./config.js";
import { buildReport, type SkipReason } from "./report.js";
import type { EmailSender } from "./email/sender.js";
import type { RunAgentFn } from "./types.js";

type BillingClient = ReturnType<typeof createBillingClient>;

export interface ExecutorDeps {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly billing: BillingClient;
  readonly emailSender: EmailSender;
  readonly runAgent: RunAgentFn;
  readonly now?: () => Date;
}

export async function runScheduledTask(deps: ExecutorDeps, taskId: string, slotIso: string): Promise<void> {
  const { prisma, redis, billing, emailSender, runAgent } = deps;
  const now = deps.now ?? (() => new Date());

  const task = await prisma.scheduledTask.findUnique({ where: { id: taskId } });
  if (!task) return;

  // active NX 防重叠（多副本原子）
  const gotActive = await redis.set(SCHED_KEY.active(taskId), "1", "EX", SCHED.activeTtlSec, "NX");
  if (gotActive !== "OK") {
    await prisma.scheduledTaskRun.create({
      data: { taskId, userId: task.userId, status: "skipped", skipReason: "prev_running", triggeredAt: new Date(slotIso), startedAt: now(), finishedAt: now() },
    });
    return;
  }

  try {
    const run = await prisma.scheduledTaskRun.create({
      data: { taskId, userId: task.userId, status: "running", triggeredAt: new Date(slotIso), startedAt: now() },
    });

    // 离线跳过（不 reserve、不扣费）
    if (task.deviceId) {
      const online = await prisma.device.findFirst({
        where: { id: task.deviceId, userId: task.userId, online: true, revokedAt: null },
        select: { id: true },
      });
      if (!online) { await settleSkip(deps, task, run.id, slotIso, "device_offline"); return; }
    }

    // 预扣
    const operationId = `sched:${run.id}`;
    try {
      await billing.reserve({
        operationId, userId: task.userId, type: "chat", model: task.model,
        inputTokens: estimateInput(task.prompt), maxOutputTokens: SCHED.maxOutputTokens,
      });
    } catch (err) {
      const reason: SkipReason = err instanceof InsufficientBalanceError ? "insufficient_balance" : "billing_unavailable";
      await settleSkip(deps, task, run.id, slotIso, reason);
      return;
    }

    // 执行 + 结算（无论成败都 settle 释放预扣）
    let text = "", toolCalls = 0, inputTokens = 0, outputTokens = 0;
    let failed: string | null = null;
    try {
      const r = await runAgent({
        userId: task.userId, model: task.model, agentId: task.agentId, prompt: task.prompt,
        kbIds: Array.isArray(task.kbIds) ? (task.kbIds as string[]) : undefined, deviceId: task.deviceId,
      });
      text = r.text; toolCalls = r.toolCalls; inputTokens = r.inputTokens; outputTokens = r.outputTokens;
    } catch (err) {
      failed = err instanceof Error ? err.message : "执行失败";
    }

    let pointsCharged: number | null = null;
    try {
      const s = await billing.settle({ operationId, userId: task.userId, model: task.model, inputTokens, outputTokens });
      pointsCharged = typeof s.settled === "number" ? s.settled : null;
    } catch {
      // 结算失败不阻断报告；预扣由对账兜底
    }

    const status = failed ? "failed" : "success";
    const finishedAt = now();
    const durationMs = finishedAt.getTime() - run.startedAt.getTime();
    const report = buildReport({
      title: task.title, status, triggeredAt: new Date(slotIso), durationMs, resultText: text,
      toolCalls, inputTokens, outputTokens, pointsCharged, error: failed ?? undefined,
    });
    const emailStatus = await deliver(emailSender, task.emailTo, report);

    await prisma.scheduledTaskRun.update({
      where: { id: run.id },
      data: { status, error: failed, finishedAt, reportText: report.html, toolCalls, inputTokens, outputTokens, pointsCharged, emailStatus },
    });
    await prisma.scheduledTask.update({ where: { id: taskId }, data: { lastRunAt: finishedAt } });
  } finally {
    await redis.del(SCHED_KEY.active(taskId)).catch(() => {});
  }
}

function estimateInput(prompt: string): number {
  return Math.max(1, Math.ceil(prompt.length / 3));
}

async function deliver(sender: EmailSender, to: string, report: { subject: string; html: string }): Promise<string> {
  if (!to) return "skipped_no_config";
  const r = await sender.send({ to, subject: report.subject, html: report.html });
  if (r.ok) return "sent";
  return r.skippedNoConfig ? "skipped_no_config" : "failed";
}

async function settleSkip(
  deps: ExecutorDeps,
  task: { title: string; emailTo: string },
  runId: string,
  slotIso: string,
  reason: SkipReason,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const report = buildReport({ title: task.title, status: "skipped", skipReason: reason, triggeredAt: new Date(slotIso) });
  const emailStatus = await deliver(deps.emailSender, task.emailTo, report);
  await deps.prisma.scheduledTaskRun.update({
    where: { id: runId },
    data: { status: "skipped", skipReason: reason, finishedAt: now(), reportText: report.html, emailStatus },
  });
}
