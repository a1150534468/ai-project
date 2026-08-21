// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，按图计费台账与审批暂停）。

import { type PrismaClient } from "@prisma/client";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  completeCodexPetImageCall,
  markCodexPetImageCallSent,
  prepareCodexPetImageCallDispatch,
  refundCodexPetFailedExtraCall,
} from "../codex-pet-call-ledger.js";
import { currentRun, emit } from "./runner-lease.js";
import {
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetImageApprovalRequiredError,
  CodexPetLeaseLostError,
  type CodexPetRunnerDeps,
  type RunnerContext,
} from "./runner-types.js";
import { safeError } from "./runner-util.js";
import { type ImageGenerationResult, classifyImageGenerationError } from "../_shared/image-service.js";

export async function recordImageGenerationAttempt(
  ctx: RunnerContext,
  jobKey: string,
  logicalAttempt: number,
  providerAttempt: number,
): Promise<void> {
  if (ctx.perImageBilling) {
    const sent = await markCodexPetImageCallSent({
      prisma: ctx.prisma,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      jobKey,
      logicalAttempt,
      requestedModel: ctx.imageModel,
      points: ctx.perImageCallPoints,
    });
    const run = await currentRun(ctx);
    await ctx.appendEvent({
      prisma: ctx.prisma,
      runId: ctx.runId,
      type: "image.call.sent",
      stage: run.progressStage,
      progress: run.progressPercent,
      message: providerAttempt > 1
        ? `第 ${sent.callCount} 次真实生图调用重发（同一次授权内的第 ${providerAttempt} 次传输尝试）`
        : `已发起第 ${sent.callCount} 次真实生图调用`,
      payload: {
        callCount: sent.callCount,
        callKind: sent.callKind,
        operationId: sent.operationId,
        requestedModel: ctx.imageModel,
        providerAttempt,
      },
      jobKey,
    });
    return;
  }
  const updated = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      cancelRequested: false,
    },
    data: {
      imageGenerationCallCount: { increment: 1 },
      heartbeatAt: new Date(),
    },
  });
  if (updated.count !== 1) throw new CodexPetLeaseLostError();
  const run = await currentRun(ctx);
  await ctx.appendEvent({
    prisma: ctx.prisma,
    runId: ctx.runId,
    type: "image.call.started",
    stage: run.progressStage,
    progress: run.progressPercent,
    message: `已发起第 ${run.imageGenerationCallCount} 次真实生图调用`,
    payload: {
      callCount: run.imageGenerationCallCount,
      requestedModel: ctx.imageModel,
      providerAttempt,
    },
    jobKey,
  });
}

export async function prepareImageGenerationDispatch(
  ctx: RunnerContext,
  jobKey: string,
  logicalAttempt: number,
  transportAttempt = 1,
): Promise<void> {
  if (!ctx.perImageBilling) return;
  await prepareCodexPetImageCallDispatch({
    prisma: ctx.prisma,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    jobKey,
    logicalAttempt,
    requestedModel: ctx.imageModel,
    points: ctx.perImageCallPoints,
    transportAttempt,
  });
}

export async function completeImageGenerationAttempt(
  ctx: RunnerContext,
  jobKey: string,
  logicalAttempt: number,
  result?: ImageGenerationResult,
  error?: unknown,
): Promise<void> {
  if (!ctx.perImageBilling) return;
  const failure = error === undefined ? null : classifyImageGenerationError(error);
  await completeCodexPetImageCall({
    prisma: ctx.prisma,
    runId: ctx.runId,
    jobKey,
    logicalAttempt,
    actualModel: result?.actualModel,
    upstreamRequestId: result?.upstreamRequestId ?? failure?.upstreamRequestId,
    error,
  });
  if (!failure) return;
  // Extra calls are charged independently at approval time, so a provider
  // failure has already taken the user's points for an image they never got.
  // Best-effort on purpose: the refund receipt lives on the ledger row, so a
  // billing outage here leaves a retryable record instead of failing the run.
  const refunded = await refundCodexPetFailedExtraCall({
    prisma: ctx.prisma,
    billing: ctx.billing,
    runId: ctx.runId,
    jobKey,
    logicalAttempt,
  }).catch(() => false);
  if (!refunded) return;
  const run = await currentRun(ctx);
  await ctx.appendEvent({
    prisma: ctx.prisma,
    runId: ctx.runId,
    type: "image.call.refunded",
    stage: run.progressStage,
    progress: run.progressPercent,
    message: `第 ${logicalAttempt} 次额外生图调用失败，已退回 ${ctx.perImageCallPoints} 积分`,
    payload: { jobKey, logicalAttempt, points: ctx.perImageCallPoints },
    jobKey,
  }).catch(() => undefined);
}

export async function consumeImageGenerationApproval(ctx: RunnerContext, jobKey: string): Promise<void> {
  const consumed = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      imageGenerationApprovalBudget: { gt: 0 },
      cancelRequested: false,
    },
    data: {
      imageGenerationApprovalBudget: { decrement: 1 },
      pendingImageJobKey: null,
      heartbeatAt: new Date(),
    },
  });
  if (consumed.count !== 1) {
    throw new CodexPetImageApprovalRequiredError(jobKey, `${jobKey} 需要用户明确批准下一次真实生图调用`);
  }
}

export async function pauseForImageApproval(ctx: RunnerContext, error: CodexPetImageApprovalRequiredError): Promise<void> {
  const message = `${error.message}；当前不会自动重试或生成下一张图`;
  const status = ctx.perImageBilling ? "awaiting_regeneration_approval" : "awaiting_direction_review";
  await ctx.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', ctx.runId);
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        cancelRequested: false,
      },
      data: {
        status,
        progressStage: status,
        progressMessage: message,
        pendingImageJobKey: error.jobKey,
        imageGenerationApprovalBudget: 0,
        workerId: null,
        heartbeatAt: null,
        error: null,
      },
    });
    if (changed.count !== 1) throw new CodexPetLeaseLostError();
    await tx.codexPetJob.updateMany({
      where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, key: error.jobKey },
      data: { status: "awaiting_approval", workerId: null, completedAt: null, error: message },
    });
    await tx.codexPetProject.updateMany({
      where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
      data: { status },
    });
  });
  await ctx.appendEvent({
    prisma: ctx.prisma,
    runId: ctx.runId,
    type: "image.approval_required",
    stage: status,
    progress: (await currentRun(ctx)).progressPercent,
    message,
    payload: { jobKey: error.jobKey, maxApprovedCalls: 1, callKind: "extra" },
    jobKey: error.jobKey,
  });
}

export async function refundRun(ctx: RunnerContext, reason: string): Promise<boolean> {
  if (ctx.perImageBilling) {
    await settlePerImageBilling(ctx, false);
    return true;
  }
  const run = await currentRun(ctx);
  if (!run.billingOperationId || run.billingRefundedAt || run.billingRefundStatus === "refunded") return Boolean(run.billingRefundedAt);
  const attemptedAt = new Date();
  try {
    const result = await ctx.billing.refundResource(run.billingOperationId);
    if (!result.success) throw new Error("billing refund was not accepted");
    await ctx.prisma.codexPetRun.update({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId }, data: {
      billingRefundedAt: attemptedAt,
      billingRefundStatus: "refunded",
      billingRefundError: null,
      billingRefundLastAttemptAt: attemptedAt,
      billingRefundRetryCount: { increment: 1 },
      billingRefundNextRetryAt: null,
    } });
  } catch (error) {
    const retryCount = run.billingRefundRetryCount + 1;
    await ctx.prisma.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, billingRefundedAt: null }, data: {
      billingRefundStatus: "pending",
      billingRefundError: safeError(error),
      billingRefundLastAttemptAt: attemptedAt,
      billingRefundRetryCount: retryCount,
      billingRefundNextRetryAt: new Date(Date.now() + Math.min(24 * 60 * 60_000, 30_000 * 2 ** Math.min(retryCount, 8))),
    } });
    return false;
  }
  // Terminal state and the refund receipt are already durable. A realtime
  // event outage must not turn a successful refund back into pending or cause
  // the run to be executed/refunded again.
  const refundedRun = await currentRun(ctx);
  await emit(ctx, "billing.refunded", refundedRun.status, refundedRun.progressPercent, "套餐积分已全额退回", { reason }).catch(() => undefined);
  return true;
}

export async function settlePerImageRunBilling(input: {
  readonly prisma: PrismaClient;
  readonly billing: CodexPetRunnerDeps["billing"];
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workerId?: string;
}): Promise<void> {
  const run = await input.prisma.codexPetRun.findFirst({
    where: { id: input.runId, projectId: input.projectId, userId: input.userId },
  });
  if (!run || run.billingMode !== CODEX_PET_PER_IMAGE_BILLING_MODE || run.billingSettlementStatus === "settled") return;
  if (!run.billingOperationId || !run.billingResourceKey || !input.billing.settleResource) {
    throw new Error("Codex pet per-image billing settlement is unavailable");
  }
  if (run.billingSettlementStatus !== "reserved" && run.billingSettlementStatus !== "settle_failed") return;
  // A call that failed at the provider delivered no image, so it is not settled:
  // the completed `老鼠猫`-era run settled 12 units of which 9 had failed, billing
  // the user 1800 points for nothing. `sentAt` still gates the count, so a call
  // that never reached fetch stays free either way.
  const units = await input.prisma.codexPetImageCall.count({
    where: {
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      callKind: "planned",
      sentAt: { not: null },
      status: { not: "failed" },
    },
  });
  const receipt = await input.billing.settleResource({
    operationId: run.billingOperationId,
    resourceKey: run.billingResourceKey,
    units,
  });
  const changed = await input.prisma.codexPetRun.updateMany({
    where: {
      id: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingSettlementStatus: { not: "settled" },
      ...(input.workerId ? { workerId: input.workerId } : {}),
    },
    data: {
      billingSettledUnits: units,
      billingSettledPoints: receipt.settled,
      billingPoints: receipt.settled,
      billingSettlementStatus: "settled",
      billingSettledAt: new Date(),
    },
  });
  if (changed.count !== 1 && input.workerId) throw new CodexPetLeaseLostError();
}

export async function settlePerImageBilling(ctx: RunnerContext, requireLease = true): Promise<void> {
  if (!ctx.perImageBilling) return;
  await settlePerImageRunBilling({
    prisma: ctx.prisma,
    billing: ctx.billing,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    ...(requireLease ? { workerId: ctx.workerId } : {}),
  });
}

/**
 * Settling is irreversible: every resume path (worker eligibility, extra-call
 * approval, failed continuation) requires billingSettlementStatus="reserved",
 * so settling a failed run condemns it permanently even when its paid artifacts
 * are intact and the only defect was a fixable bug. A failure therefore must
 * not settle; the worker maintenance sweeper closes the reservation after a
 * grace window if nobody resumed the run.
 *
 * The one exception is a failure that never sent a paid call: there is nothing
 * to resume and nothing was spent, so releasing the hold at once is strictly
 * better for the user than freezing their points for the whole window.
 */
export async function settlePerImageBillingOnFailure(ctx: RunnerContext): Promise<"settled" | "deferred"> {
  const sentPlannedCalls = await ctx.prisma.codexPetImageCall.count({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      callKind: "planned",
      sentAt: { not: null },
    },
  });
  if (sentPlannedCalls > 0) return "deferred";
  await settlePerImageBilling(ctx, false);
  return "settled";
}

export async function recordPerImageSettlementFailure(ctx: RunnerContext, error: unknown): Promise<void> {
  await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingSettlementStatus: { not: "settled" },
    },
    data: {
      billingSettlementStatus: "settle_failed",
      billingChargeError: safeError(error),
    },
  }).catch(() => undefined);
}
