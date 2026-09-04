// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，终态收尾）。

import { type CodexPetProject, Prisma, type PrismaClient } from "@prisma/client";
import { codexPetGateFailureSnapshotValue } from "../codex-pet-gate-failure.js";
import { type CodexPetPackagingDeferredError } from "../codex-pet-packaging.js";
import { pauseForImageApproval } from "./runner-image-approval.js";
import { emit, } from "./runner-lease.js";
import { releaseDeferredPackagingLease } from "./runner-packaging-resume.js";
import {
  CODEX_PET_ACTIVE_STATUSES,
  type CodexPetExecutionResult,
  CodexPetGateFailureError,
  type CodexPetImageApprovalRequiredError,
  type CodexPetRunnerDeps,
  type RunnerContext,
} from "./runner-types.js";
import { asRecord, imageFailureMetadata, safeError } from "./runner-util.js";

/**
 * Reference loading happens immediately after a lease claim, before the main
 * execution context/monitor is constructed.  If an object was deleted or
 * ownership changed in that small window, release the lease through the same
 * terminal policy as a normal runner failure; otherwise a Bull failure would
 * leave the run permanently active with no worker to recover it.
 */
export async function finalizeClaimedSetupFailure(input: {
  readonly prisma: PrismaClient;
  readonly appendEvent: CodexPetRunnerDeps["appendEvent"];
  readonly project: CodexPetProject;
  readonly runId: string;
  readonly workerId: string;
  readonly error: unknown;
}): Promise<void> {
  const message = safeError(input.error);
  const now = new Date();
  const outcome = await input.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId } });
    if (!current || current.status === "ready" || current.status === "failed" || current.status === "cancelled" || current.workerId !== input.workerId || current.cancelRequested) {
      return { transitioned: false, run: current };
    }
    const changed = await tx.codexPetRun.updateMany({
      where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, workerId: input.workerId, status: { in: [...CODEX_PET_ACTIVE_STATUSES] } },
      data: {
        status: "failed",
        progressStage: "failed",
        progressMessage: message,
        error: message,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
      },
    });
    if (changed.count !== 1) return { transitioned: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: input.project.id, userId: input.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    return { transitioned: true, run: current };
  });
  if (!outcome.transitioned) return;
  await input.appendEvent({ prisma: input.prisma, runId: input.runId, type: "run.failed", stage: "failed", progress: outcome.run?.progressPercent ?? 0, message, payload: { retryable: false } }).catch(() => undefined);
}

export async function finalizeFailure(ctx: RunnerContext, error: unknown): Promise<void> {
  const message = safeError(error);
  const now = new Date();
  const gateFailure = error instanceof CodexPetGateFailureError && error.rows.length > 0 ? error : null;
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "ready" || current.status === "failed" || current.status === "cancelled") {
      return { transitioned: false, run: current };
    }
    if (current.cancelRequested) return { transitioned: false, run: current };
    // A stale worker may still be unwinding an upstream request after a new
    // worker has claimed the lease. It must never overwrite that worker's
    // progress (especially a committed ready state).
    if (current.workerId !== ctx.workerId) return { transitioned: false, run: current };
    const changed = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: { in: [...CODEX_PET_ACTIVE_STATUSES] } },
      data: {
        status: "failed",
        progressStage: "failed",
        progressMessage: message,
        error: message,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        // A gate that named its rows leaves behind actionable work: persist that
        // scope so 失败续跑 can redo exactly those action groups. Without it the
        // rows are all `completed` at the current prompt version and admission
        // has nothing to reset, which made this failure shape non-continuable.
        ...(gateFailure
          ? {
            inputSnapshot: {
              ...asRecord(current.inputSnapshot),
              gateFailure: codexPetGateFailureSnapshotValue({
                gate: gateFailure.gate,
                rows: gateFailure.rows,
                failures: gateFailure.failures,
                recordedAt: now,
              }),
            } as Prisma.InputJsonObject,
          }
          : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    const unfinishedJobs: Prisma.CodexPetJobWhereInput = {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: { in: ["queued", "running"] },
    };
    await tx.codexPetJob.updateMany({
      where: {
        ...unfinishedJobs,
        error: null,
      },
      data: {
        error: "同一运行中的其他任务失败，当前任务已停止",
      },
    });
    await tx.codexPetJob.updateMany({
      where: unfinishedJobs,
      data: {
        status: "cancelled",
        completedAt: now,
        workerId: null,
      },
    });
    return { transitioned: true, run: { ...current, status: "failed", progressStage: "failed", progressMessage: message, progressPercent: current.progressPercent } };
  });
  if (!outcome.transitioned) {
    if (outcome.run?.cancelRequested) await finalizeCancellation(ctx);
    return;
  }
  const failure = imageFailureMetadata(error);
  await emit(ctx, "run.failed", "failed", outcome.run?.progressPercent ?? 0, message, {
    retryable: false,
    errorCategory: failure.category,
    ...(gateFailure ? { gate: gateFailure.gate, repairRows: [...gateFailure.rows] } : {}),
    ...(failure.transportCode ? { transportCode: failure.transportCode } : {}),
    ...(failure.upstreamRequestId ? { upstreamRequestId: failure.upstreamRequestId } : {}),
  }).catch(() => undefined);
}

export async function finalizeCancellation(ctx: RunnerContext): Promise<void> {
  const now = new Date();
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "cancelled" || current.status === "ready" || current.status === "failed") {
      return { transitioned: false, run: current };
    }
    // Permit an unclaimed run (the API can set cancelRequested before Bull
    // starts), but never let a stale worker cancel a newer worker's lease.
    if (current.workerId !== null && current.workerId !== ctx.workerId) return { transitioned: false, run: current };
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        OR: [{ workerId: ctx.workerId }, { workerId: null }],
      },
      data: {
        status: "cancelled",
        progressStage: "cancelled",
        progressMessage: "用户已取消",
        error: null,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        cancelRequested: true,
      },
    });
    if (changed.count !== 1) return { transitioned: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "cancelled" } });
    await tx.codexPetJob.updateMany({ where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, status: { in: ["queued", "running"] } }, data: { status: "cancelled", error: "用户已取消", completedAt: now, workerId: null } });
    return { transitioned: true, run: { ...current, status: "cancelled", progressPercent: current.progressPercent } };
  });
  // The API can cancel an unclaimed queued run while its Bull job is still in
  // flight. Only the process that wins the state transition owns the terminal
  // event, preventing a later queue delivery from duplicating it.
  if (!outcome.transitioned) return;
  await emit(ctx, "run.cancelled", "cancelled", outcome.run?.progressPercent ?? 0, "桌宠制作已取消", { hasSuccessfulImage: outcome.run?.hasSuccessfulImage ?? false }).catch(() => undefined);
}

/**
 * 下面五个 handler 是 `executeCodexPetRun` catch 链五类信号异常的处理体，逐一
 * 命名后 catch 链只剩 `instanceof` 分派。三点说明：
 *
 * 1. 原处理体读的是 `run.id / run.project.id / run.userId`，这里换成
 *    `ctx.runId / ctx.project.id / ctx.project.userId`。等价性由
 *    codex-pet-runner.ts 领取租约前的归属断言保证：`initialRun.project.id !==
 *    initialRun.projectId || initialRun.project.userId !== initialRun.userId`
 *    直接抛错，因此走到 catch 链时三列必然同源。
 * 2. 原来四处重复的重读各带三种 `select` 形状（`{status,cancelRequested}` /
 *    `{status}` / `{cancelRequested,status}`），合一为下面的超集查询——多读一列
 *    不改变任何分支判定。
 * 3. `latest.status` 在 Prisma 侧是 `string`，靠 `=== "ready"` 这类字面量比较
 *    收窄后才能塞进 `CodexPetExecutionStatus` 联合类型，比较必须逐字保留。
 */
async function readOwnedRunOutcome(ctx: RunnerContext): Promise<{ readonly status: string; readonly cancelRequested: boolean } | null> {
  return ctx.prisma.codexPetRun.findFirst({
    where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
    select: { status: true, cancelRequested: true },
  });
}

export async function handleImageApprovalRequired(
  ctx: RunnerContext,
  error: CodexPetImageApprovalRequiredError,
): Promise<CodexPetExecutionResult> {
  await pauseForImageApproval(ctx, error);
  return { status: "awaiting_direction_review", runId: ctx.runId };
}

export async function handlePackagingDeferred(
  ctx: RunnerContext,
  error: CodexPetPackagingDeferredError,
): Promise<CodexPetExecutionResult> {
  if (await releaseDeferredPackagingLease(ctx, error)) {
    return { status: "packaging", runId: ctx.runId };
  }
  const latest = await readOwnedRunOutcome(ctx);
  if (latest?.cancelRequested || latest?.status === "cancelled") {
    await finalizeCancellation(ctx);
    return { status: "cancelled", runId: ctx.runId };
  }
  if (latest?.status === "ready" || latest?.status === "failed") {
    return { status: latest.status, runId: ctx.runId };
  }
  if (latest?.status === "archiving") return { status: "archiving", runId: ctx.runId };
  return { status: "busy", runId: ctx.runId };
}

export async function handleLeaseLost(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  const latest = await readOwnedRunOutcome(ctx);
  if (latest?.status === "ready" || latest?.status === "failed" || latest?.status === "cancelled") {
    return { status: latest.status, runId: ctx.runId };
  }
  return { status: "busy", runId: ctx.runId };
}

export async function handleCancelled(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  await finalizeCancellation(ctx);
  return { status: "cancelled", runId: ctx.runId };
}

/**
 * 兜底分支：只有取消竞态那条路径会返回，其余情况登记失败后原样重抛，交给
 * Bull 记录失败。返回类型不含 never 分支是有意的——调用方一律 `return await`。
 */
export async function handleUnexpectedFailure(ctx: RunnerContext, error: unknown): Promise<CodexPetExecutionResult> {
  // Cancellation may be persisted just after an upstream/QA error but
  // before the monitor tick observes it. Re-read the row so that the
  // cancellation policy wins that race instead of recording a system failure.
  const latestBeforeFailure = await readOwnedRunOutcome(ctx);
  if (latestBeforeFailure?.cancelRequested || latestBeforeFailure?.status === "cancelled") {
    await finalizeCancellation(ctx);
    return { status: "cancelled", runId: ctx.runId };
  }
  await finalizeFailure(ctx, error);
  throw error;
}
