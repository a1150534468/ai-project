// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，终态收尾）。

import { type CodexPetProject, Prisma, type PrismaClient } from "@prisma/client";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "../codex-pet-call-ledger.js";
import { codexPetGateFailureSnapshotValue } from "../codex-pet-gate-failure.js";
import {
  recordPerImageSettlementFailure,
  refundRun,
  settlePerImageBilling,
  settlePerImageBillingOnFailure,
  settlePerImageRunBilling,
} from "../codex-pet-runner/runner-billing.js";
import { emit, } from "../codex-pet-runner/runner-lease.js";
import {
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetGateFailureError,
  type CodexPetRunnerDeps,
  type RunnerContext,
} from "../codex-pet-runner/runner-types.js";
import { asRecord, imageFailureMetadata, safeError } from "../codex-pet-runner/runner-util.js";

/**
 * Reference loading happens immediately after a lease claim, before the main
 * execution context/monitor is constructed.  If an object was deleted or
 * ownership changed in that small window, release the lease through the same
 * terminal/refund policy as a normal runner failure; otherwise a Bull failure
 * would leave the run permanently active with no worker to recover it.
 */
export async function finalizeClaimedSetupFailure(input: {
  readonly prisma: PrismaClient;
  readonly appendEvent: CodexPetRunnerDeps["appendEvent"];
  readonly billing: CodexPetRunnerDeps["billing"];
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
      return { transitioned: false, refundPending: false, run: current };
    }
    const refundPending = current.billingChargeStatus === "charged"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
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
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: input.project.id, userId: input.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    return { transitioned: true, refundPending, run: current };
  });
  if (!outcome.transitioned) return;
  await input.appendEvent({ prisma: input.prisma, runId: input.runId, type: "run.failed", stage: "failed", progress: outcome.run?.progressPercent ?? 0, message, payload: { retryable: false } }).catch(() => undefined);
  if (outcome.run?.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
    try {
      // Same rule as settlePerImageBillingOnFailure: only a failure that spent
      // nothing may settle here, because settling closes every resume path.
      const sentPlannedCalls = await input.prisma.codexPetImageCall.count({
        where: {
          runId: input.runId,
          projectId: input.project.id,
          userId: input.project.userId,
          callKind: "planned",
          sentAt: { not: null },
        },
      });
      if (sentPlannedCalls > 0) return;
      await settlePerImageRunBilling({
        prisma: input.prisma,
        billing: input.billing,
        runId: input.runId,
        projectId: input.project.id,
        userId: input.project.userId,
      });
    } catch (billingError) {
      await input.prisma.codexPetRun.updateMany({
        where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: { not: "settled" } },
        data: { billingSettlementStatus: "settle_failed", billingChargeError: safeError(billingError) },
      }).catch(() => undefined);
    }
    return;
  }
  if (!outcome.refundPending || !outcome.run?.billingOperationId) return;
  const attemptedAt = new Date();
  try {
    const result = await input.billing.refundResource(outcome.run.billingOperationId);
    if (!result.success) throw new Error("billing refund was not accepted");
    await input.prisma.codexPetRun.updateMany({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingRefundedAt: null }, data: { billingRefundedAt: attemptedAt, billingRefundStatus: "refunded", billingRefundError: null, billingRefundLastAttemptAt: attemptedAt, billingRefundRetryCount: { increment: 1 }, billingRefundNextRetryAt: null } });
    await input.appendEvent({ prisma: input.prisma, runId: input.runId, type: "billing.refunded", stage: "failed", progress: outcome.run.progressPercent, message: "套餐积分已全额退回", payload: { reason: "setup_failure" } }).catch(() => undefined);
  } catch (error) {
    await input.prisma.codexPetRun.updateMany({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingRefundedAt: null }, data: { billingRefundStatus: "pending", billingRefundError: safeError(error), billingRefundLastAttemptAt: attemptedAt, billingRefundRetryCount: { increment: 1 }, billingRefundNextRetryAt: new Date(Date.now() + 30_000) } }).catch(() => undefined);
  }
}

export async function finalizeFailure(ctx: RunnerContext, error: unknown): Promise<void> {
  const message = safeError(error);
  const now = new Date();
  const gateFailure = error instanceof CodexPetGateFailureError && error.rows.length > 0 ? error : null;
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "ready" || current.status === "failed" || current.status === "cancelled") {
      return { transitioned: false, refundPending: false, run: current };
    }
    if (current.cancelRequested) return { transitioned: false, refundPending: false, run: current };
    // A stale worker may still be unwinding an upstream request after a new
    // worker has claimed the lease. It must never overwrite that worker's
    // progress (especially a committed ready state).
    if (current.workerId !== ctx.workerId) return { transitioned: false, refundPending: false, run: current };
    const refundPending = current.billingChargeStatus === "charged"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
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
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
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
    return { transitioned: true, refundPending, run: { ...current, status: "failed", progressStage: "failed", progressMessage: message, progressPercent: current.progressPercent } };
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
  if (ctx.perImageBilling) {
    try {
      const settlementOutcome = await settlePerImageBillingOnFailure(ctx);
      if (settlementOutcome === "deferred") {
        await emit(ctx, "billing.settlement_deferred", "failed", outcome.run?.progressPercent ?? 0,
          "本次失败未结清调用额度，已付费素材仍可在续跑窗口期内复用", {
            reason: "failure_is_resumable",
          }).catch(() => undefined);
      }
    } catch (billingError) {
      await recordPerImageSettlementFailure(ctx, billingError);
    }
    return;
  }
  if (outcome.refundPending) await refundRun(ctx, "system_failure");
}

export async function finalizeCancellation(ctx: RunnerContext): Promise<void> {
  const now = new Date();
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "cancelled" || current.status === "ready" || current.status === "failed") {
      return { transitioned: false, refundPending: false, run: current };
    }
    // Permit an unclaimed run (the API can set cancelRequested before Bull
    // starts), but never let a stale worker cancel a newer worker's lease.
    if (current.workerId !== null && current.workerId !== ctx.workerId) return { transitioned: false, refundPending: false, run: current };
    const refundPending = current.billingChargeStatus === "charged"
      && !current.hasSuccessfulImage
      && current.status !== "awaiting_base_review"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
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
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "cancelled" } });
    await tx.codexPetJob.updateMany({ where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, status: { in: ["queued", "running"] } }, data: { status: "cancelled", error: "用户已取消", completedAt: now, workerId: null } });
    return { transitioned: true, refundPending, run: { ...current, status: "cancelled", progressPercent: current.progressPercent } };
  });
  // The API can cancel an unclaimed queued run while its Bull job is still in
  // flight. Only the process that wins the state transition owns the terminal
  // event/refund, preventing a later queue delivery from duplicating either.
  if (!outcome.transitioned) return;
  await emit(ctx, "run.cancelled", "cancelled", outcome.run?.progressPercent ?? 0, "桌宠制作已取消", { hasSuccessfulImage: outcome.run?.hasSuccessfulImage ?? false }).catch(() => undefined);
  if (ctx.perImageBilling) {
    try {
      await settlePerImageBilling(ctx, false);
    } catch (billingError) {
      await recordPerImageSettlementFailure(ctx, billingError);
    }
    return;
  }
  if (outcome.refundPending) await refundRun(ctx, "cancelled_before_first_image");
}
