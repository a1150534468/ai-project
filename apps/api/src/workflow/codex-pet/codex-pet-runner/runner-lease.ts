// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，租约、事件与阶段推进）。

import { type CodexPetRun, type Prisma, type PrismaClient } from "@prisma/client";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "../codex-pet-call-ledger.js";
import { type CodexPetRunStage } from "../codex-pet-events.js";
import {
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetCancelledError,
  CodexPetLeaseLostError,
  type RunnerContext,
  type RunnerRunWithProject,
} from "./runner-types.js";
import { staleRunMs } from "./runner-util.js";

export async function emit(ctx: RunnerContext, type: string, stage: string, progress: number, message: string, payload: Record<string, unknown> = {}, jobKey?: string): Promise<void> {
  if (stage === "repairing" && (type === "run.repairing" || type === "job.retrying")) {
    await ctx.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', ctx.runId);
      const current = await tx.codexPetRun.findFirst({
        where: {
          id: ctx.runId,
          projectId: ctx.project.id,
          userId: ctx.project.userId,
          workerId: ctx.workerId,
          status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
          cancelRequested: false,
        },
        select: { progressPercent: true },
      });
      if (!current) throw new CodexPetLeaseLostError();
      await tx.codexPetRun.updateMany({
        where: { id: ctx.runId, workerId: ctx.workerId, cancelRequested: false },
        data: {
          status: "repairing",
          progressStage: "repairing",
          progressPercent: Math.max(current.progressPercent, Math.min(99, progress)),
          progressMessage: message,
          heartbeatAt: new Date(),
        },
      });
      await tx.codexPetProject.updateMany({
        where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
        data: { status: "repairing" },
      });
    });
  }
  await ctx.appendEvent({ prisma: ctx.prisma, runId: ctx.runId, type, stage, progress, message, payload, jobKey });
}

export async function currentRun(ctx: RunnerContext): Promise<CodexPetRun> {
  const run = await ctx.prisma.codexPetRun.findFirst({
    where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
  });
  if (!run) throw new Error("Codex pet run no longer exists");
  return run;
}

/**
 * 既接受 PrismaClient 也接受事务句柄：下面两个 CAS 的调用点一半在 `$transaction`
 * 里、一半直接用 ctx.prisma，谓词却必须逐字一致，所以入口只能是这个联合类型。
 */
type RunnerOwnedStore = PrismaClient | Prisma.TransactionClient;

/**
 * 形状 A：以「本 worker 仍持有这个未被请求取消的活跃 run」为条件写 run 行，
 * 不满足即租约已丢。
 *
 * 谓词照抄 `stage` 与 recordImageGenerationAttempt / pauseForImageApproval /
 * bindBoardJobInput 三处：workerId 进 where 而不是先读后判，是因为「读到自己持有」
 * 与「写成功」之间必须没有窗口 —— 接管者的 claimRunLease 只要抢先一步改掉
 * workerId，这里的 count 就是 0。
 */
export async function updateOwnedActiveRun(
  store: RunnerOwnedStore,
  ctx: RunnerContext,
  data: Prisma.CodexPetRunUpdateManyMutationInput,
): Promise<void> {
  const changed = await store.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      cancelRequested: false,
    },
    data,
  });
  if (changed.count !== 1) throw new CodexPetLeaseLostError();
}

/**
 * 形状 B：以「这个 job 仍属于本 run 与本用户」为条件写 job 行，不满足即租约已丢。
 *
 * 基础谓词里**故意不含 workerId**：主形象手工选择由路由提交，runner 补图时
 * job.workerId 可能是 null（runner-base.ts 的 `status: { not: "completed" }` 那处）。
 * 需要锁 worker 或锁状态的调用点自己用 extraWhere 加，谁加谁负责。
 */
export async function updateOwnedJob(
  store: RunnerOwnedStore,
  ctx: RunnerContext,
  jobId: string,
  data: Prisma.CodexPetJobUpdateManyMutationInput,
  extraWhere: Prisma.CodexPetJobWhereInput = {},
): Promise<void> {
  const changed = await store.codexPetJob.updateMany({
    where: { id: jobId, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, ...extraWhere },
    data,
  });
  if (changed.count !== 1) throw new CodexPetLeaseLostError();
}

/**
 * Atomically claim a run lease.  `workerId` is deliberately part of the
 * compare-and-set predicate: two queue deliveries can both observe a queued
 * row, but only one may transition it to an owned row.  A heartbeat older
 * than the stale threshold is the only way a second worker can take over.
 */
export async function claimRunLease(
  prisma: PrismaClient,
  runId: string,
  workerId: string,
  env: NodeJS.ProcessEnv,
  expectedProjectId?: string,
  expectedUserId?: string,
  zeroChargeRecovery = false,
): Promise<{ claimed: boolean; run: RunnerRunWithProject | null }> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleRunMs(env));
  return prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: runId,
        ...(expectedProjectId ? { projectId: expectedProjectId } : {}),
        ...(expectedUserId ? { userId: expectedUserId } : {}),
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        AND: [
          zeroChargeRecovery
            ? { billingChargeStatus: "not_required", billingPoints: 0 }
            : {
                OR: [
                  { billingChargeStatus: "charged", billingActivatedAt: { not: null } },
                  { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" },
                ],
              },
          {
            OR: [
              { workerId: null },
              { heartbeatAt: null },
              { heartbeatAt: { lt: staleBefore } },
            ],
          },
        ],
      },
      data: {
        workerId,
        heartbeatAt: now,
        startedAt: now,
      },
    });
    const run = await tx.codexPetRun.findFirst({
      where: {
        id: runId,
        ...(expectedProjectId ? { projectId: expectedProjectId } : {}),
        ...(expectedUserId ? { userId: expectedUserId } : {}),
      },
      include: { project: true },
    });
    return { claimed: changed.count === 1, run: run as RunnerRunWithProject | null };
  });
}

export async function checkCancelled(ctx: RunnerContext): Promise<void> {
  if (ctx.signal?.aborted) {
    if (ctx.signal.reason instanceof CodexPetLeaseLostError) throw new CodexPetLeaseLostError();
    throw new CodexPetCancelledError();
  }
  const run = await ctx.prisma.codexPetRun.findFirst({
    where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
    select: { cancelRequested: true, status: true, workerId: true },
  });
  if (!run || run.cancelRequested || run.status === "cancelled") throw new CodexPetCancelledError();
  if (!(CODEX_PET_ACTIVE_STATUSES as readonly string[]).includes(run.status) || run.workerId !== ctx.workerId) {
    throw new CodexPetLeaseLostError();
  }
}

export async function stage(ctx: RunnerContext, status: string, progress: number, message: string): Promise<void> {
  await checkCancelled(ctx);
  const now = new Date();
  const transition = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({
      where: {
        id: ctx.runId,
        workerId: ctx.workerId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        cancelRequested: false,
      },
      select: { progressPercent: true },
    });
    if (!current) return { claimed: false, advanced: false } as const;
    const targetProgress = Math.min(progress, status === "archiving" ? 98 : 99);
    // Every delivery replays the dependency graph so it can recover completed
    // jobs after a process restart.  Cached work must not make the durable
    // stage/progress move backwards while that replay catches up (notably
    // after base review or while resuming packaging/archival).
    const advanced = targetProgress >= current.progressPercent;
    // 两点与合一之前不同、但都不改变可观察行为：谓词比上面的 findFirst 多
    // projectId / userId（checkCancelled 已按这两列查过同一行）；CAS 不中时改为
    // 在事务内抛 LeaseLost，而此刻事务里还没有任何写入，回滚与空提交等价。
    await updateOwnedActiveRun(tx, ctx, advanced
      ? {
          status,
          progressStage: status,
          progressPercent: targetProgress,
          progressMessage: message,
          heartbeatAt: now,
          error: null,
        }
      : { heartbeatAt: now, error: null });
    if (advanced) {
      await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status } });
    }
    return { claimed: true, advanced } as const;
  });
  if (!transition.claimed) throw new CodexPetLeaseLostError();
  if (transition.advanced) await emit(ctx, "stage.started", status, progress, message);
}

/**
 * Visual repair moves the durable run to `repairing`, while a successful
 * per-job event does not own the surrounding workflow stage. Reconcile only
 * after the complete parallel batch/gate has passed. Progress is deliberately
 * a high-water mark because final QA may replay a 20% row from 88%.
 */
export async function resumeStageIfRepairing(
  ctx: RunnerContext,
  status: Extract<CodexPetRunStage, "standard_generating" | "direction_generating" | "validating">,
  progress: number,
  message: string,
): Promise<boolean> {
  const restored = await ctx.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', ctx.runId);
    const current = await tx.codexPetRun.findFirst({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "repairing",
        cancelRequested: false,
      },
      select: { progressPercent: true },
    });
    if (!current) return null;
    const effectiveProgress = Math.max(current.progressPercent, Math.min(99, progress));
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "repairing",
        cancelRequested: false,
      },
      data: {
        status,
        progressStage: status,
        progressPercent: effectiveProgress,
        progressMessage: message,
        heartbeatAt: new Date(),
      },
    });
    if (changed.count !== 1) return null;
    await tx.codexPetProject.updateMany({
      where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
      data: { status },
    });
    return { effectiveProgress };
  });
  if (!restored) return false;
  await emit(ctx, "stage.started", status, restored.effectiveProgress, message, {
    resumedAfterRepair: true,
    resumeStage: status,
  });
  return true;
}
