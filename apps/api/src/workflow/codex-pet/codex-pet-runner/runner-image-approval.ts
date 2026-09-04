// 真实生图调用的记账与「等一次授权」暂停。
//
// 这三个函数原在 runner-billing.ts 里与按张计费混住，计费下线后只剩这条业务链：
// 记一次真实调用、消耗一次授权额度、没有额度就把运行停到等待复核。

import { CODEX_PET_ACTIVE_STATUSES, CodexPetImageApprovalRequiredError, type RunnerContext } from "./runner-types.js";
import { currentRun, updateOwnedActiveRun } from "./runner-lease.js";

export async function recordImageGenerationAttempt(
  ctx: RunnerContext,
  jobKey: string,
  providerAttempt: number,
): Promise<void> {
  await updateOwnedActiveRun(ctx.prisma, ctx, {
    imageGenerationCallCount: { increment: 1 },
    heartbeatAt: new Date(),
  });
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
  const status = "awaiting_direction_review";
  await ctx.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', ctx.runId);
    await updateOwnedActiveRun(tx, ctx, {
      status,
      progressStage: status,
      progressMessage: message,
      pendingImageJobKey: error.jobKey,
      imageGenerationApprovalBudget: 0,
      workerId: null,
      heartbeatAt: null,
      error: null,
    });
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
    payload: { jobKey: error.jobKey, maxApprovedCalls: 1 },
    jobKey: error.jobKey,
  });
}
