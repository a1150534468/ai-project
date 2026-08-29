/**
 * codex-pet-worker 拆分后的结算兜底层:等授权超时的运行自动取消、按张计费的预留结算,
 * 以及计费意图的补偿激活。
 *
 * 三条路径都只在业务已进终态之后动账,且都用 updateMany 的条件转移收口 —— 多副本同时
 * 扫到同一条运行时,只有赢下条件更新的那个进程记指标、写事件。
 *
 * `reconcilePerImageBillingSettlements` 里写收据那次 updateMany **故意不带终态条件**:
 * 外部 settle 一旦成功,账就必须落库,哪怕运行在这中间被恢复了 —— 丢收据会导致重复结算
 * 且不可逆,而被错判的运行运维还能救回来。
 *
 * 结算静默归零的留痕与 runner 共用 `codexPetUnderSettledDiagnostic`:这条兜底路径原本
 * 无条件写 `billingChargeError: null`,比 runner 那侧更隐蔽 —— 不仅不报错,还会把上一次
 * 的诊断擦掉。
 *
 * 依赖方向:support → 本文件 → codex-pet-worker.ts。不 import recovery / metrics。
 */

import { getRedis } from "@ai-assistant/db";
import type { PrismaClient } from "@prisma/client";
import {
  codexPetRunChannel,
  codexPetUnderSettledDiagnostic,
  listCodexPetBillingReconciliationCandidates,
  reconcileCodexPetRunBilling,
  enqueueCodexPetRun,
  refundCodexPetUndispatchedExtraCalls,
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CODEX_PET_PARKED_APPROVAL_EXPIRY_MS,
  CODEX_PET_FAILED_SETTLEMENT_GRACE_MS,
  type CodexPetChargeClient,
} from "../workflow/codex-pet/index.js";
import { safeWorkerError } from "./codex-pet-worker-support.js";

export type CodexPetSettlementClient = {
  readonly settleResource: (args: {
    readonly operationId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly settled: number }>;
};

// 等授权上限与失败结算宽限的口径在 codex-pet-reservation-window.ts（与 routes 声明给
// billing 的预留有效期同源），这里只做转出，避免两边各写一份而让 billing 兜底早于业务动手。
export { CODEX_PET_PARKED_APPROVAL_EXPIRY_MS, CODEX_PET_FAILED_SETTLEMENT_GRACE_MS };

/**
 * Cancel runs that have waited for image approval past the expiry window.
 *
 * Only flips the run to `cancelled` and records the reason; the reservation is
 * then settled by `reconcilePerImageBillingSettlements` (which already accepts
 * `cancelled`) and any charged-but-undispatched extras are refunded here, since
 * those points sit outside the run reservation entirely.
 */
export async function expireParkedCodexPetRuns(input: {
  readonly prisma: PrismaClient;
  readonly billing?: { readonly refundResource: (operationId: string) => Promise<{ success: boolean }> };
  readonly now?: () => Date;
  readonly limit?: number;
  readonly expiryMs?: number;
  readonly onError?: (error: unknown, runId: string) => void;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  const expiryMs = Math.max(0, input.expiryMs ?? CODEX_PET_PARKED_APPROVAL_EXPIRY_MS);
  const parkedBefore = new Date(now().getTime() - expiryMs);
  const candidates = await input.prisma.codexPetRun.findMany({
    where: {
      status: "awaiting_regeneration_approval",
      // A worker still holding the lease is mid-transition; leave it alone.
      workerId: null,
      updatedAt: { lte: parkedBefore },
    },
    select: { id: true, projectId: true, userId: true, progressPercent: true },
    take: Math.min(200, Math.max(1, input.limit ?? 50)),
  });
  let cancelled = 0;
  for (const run of candidates) {
    try {
      const expiredAt = now();
      const changed = await input.prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', run.id);
        const updated = await tx.codexPetRun.updateMany({
          where: { id: run.id, status: "awaiting_regeneration_approval", workerId: null },
          data: {
            cancelRequested: true,
            status: "cancelled",
            progressStage: "cancelled",
            progressMessage: "等待授权超时，已自动取消并结清",
            completedAt: expiredAt,
            lastEventSequence: { increment: 1 },
          },
        });
        if (updated.count === 0) return false;
        const fresh = await tx.codexPetRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { lastEventSequence: true, progressPercent: true },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId: run.projectId,
            runId: run.id,
            userId: run.userId,
            sequence: fresh.lastEventSequence,
            type: "run.cancelled",
            stage: "cancelled",
            message: "等待重出图授权超时，已自动取消，未交付的预留额度会退回",
            progress: fresh.progressPercent,
            payload: { reason: "approval_expired", expiryMs },
          },
        });
        await tx.codexPetProject.updateMany({
          where: { id: run.projectId, userId: run.userId, latestRunId: run.id, status: { not: "deleting" } },
          data: { status: "cancelled" },
        });
        return true;
      });
      if (!changed) continue;
      cancelled += 1;
      if (input.billing) {
        await refundCodexPetUndispatchedExtraCalls({
          prisma: input.prisma,
          billing: input.billing,
          runId: run.id,
          projectId: run.projectId,
          userId: run.userId,
          onError: (error) => input.onError?.(error, run.id),
        }).catch((error: unknown) => input.onError?.(error, run.id));
      }
    } catch (error) {
      input.onError?.(error, run.id);
    }
  }
  return cancelled;
}

/**
 * A worker can finish the artifact work yet lose connectivity while settling
 * its reservation. This maintenance path only reconciles durable accounting
 * for terminal per-image runs; it never enqueues work or contacts Pixel.
 *
 * 宽限窗口本身（CODEX_PET_FAILED_SETTLEMENT_GRACE_MS）定义在
 * codex-pet-reservation-window.ts，与预留有效期同源。
 */
export async function reconcilePerImageBillingSettlements(input: {
  readonly prisma: PrismaClient;
  readonly billing: CodexPetSettlementClient;
  readonly now?: () => Date;
  readonly limit?: number;
  readonly failedGraceMs?: number;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  const terminalStatuses = ["ready", "failed", "cancelled"];
  const graceMs = Math.max(0, input.failedGraceMs ?? CODEX_PET_FAILED_SETTLEMENT_GRACE_MS);
  const failedSettleBefore = new Date(now().getTime() - graceMs);
  const candidates = await input.prisma.codexPetRun.findMany({
    where: {
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingSettlementStatus: { in: ["reserved", "settle_failed"] },
      billingOperationId: { not: null },
      billingResourceKey: { not: null },
      OR: [
        { status: { in: ["ready", "cancelled"] } },
        // A failed run whose completedAt is missing cannot have its window
        // measured; treat it as expired rather than holding the reservation
        // open forever.
        { status: "failed", completedAt: null },
        { status: "failed", completedAt: { lte: failedSettleBefore } },
      ],
    },
    select: {
      id: true,
      projectId: true,
      userId: true,
      billingOperationId: true,
      billingResourceKey: true,
      billingReservedPoints: true,
    },
    take: Math.min(500, Math.max(1, input.limit ?? 50)),
  });
  let settled = 0;
  for (const run of candidates) {
    try {
      // A failed run stays resumable during its grace window, so it can leave
      // the terminal set between the scan and this settle. Re-read immediately
      // before the irreversible external call to narrow that race.
      const fresh = await input.prisma.codexPetRun.findFirst({
        where: {
          id: run.id,
          projectId: run.projectId,
          userId: run.userId,
          billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
          billingSettlementStatus: { in: ["reserved", "settle_failed"] },
          status: { in: terminalStatuses },
        },
        select: { id: true },
      });
      if (!fresh) continue;
      // Must match the runner and the cancellation path exactly: a planned call
      // that failed at the provider delivered no image and is not settled.
      const units = await input.prisma.codexPetImageCall.count({
        where: {
          runId: run.id,
          projectId: run.projectId,
          userId: run.userId,
          callKind: "planned",
          sentAt: { not: null },
          status: { not: "failed" },
        },
      });
      const receipt = await input.billing.settleResource({
        operationId: run.billingOperationId!,
        resourceKey: run.billingResourceKey!,
        units,
      });
      // 这条兜底路径原来无条件写 billingChargeError: null，于是「已交付却结算到 0」
      // 在这里比 runner 那侧更隐蔽：不仅没报错，还把上一次的诊断擦掉了。留痕口径与
      // runner 共用 codexPetUnderSettledDiagnostic，正常结算时仍然清空。
      const underSettled = codexPetUnderSettledDiagnostic({
        units,
        settledPoints: receipt.settled,
        reservedPoints: run.billingReservedPoints,
      });
      // Deliberately not guarded on terminal status: once the external settle
      // succeeded the accounting must be recorded even if the run was resumed
      // in the meantime. A lost settlement receipt risks a double settle and is
      // unrecoverable; a wrongly condemned run is recoverable by an operator.
      const changed = await input.prisma.codexPetRun.updateMany({
        where: {
          id: run.id,
          projectId: run.projectId,
          userId: run.userId,
          billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
          billingSettlementStatus: { in: ["reserved", "settle_failed"] },
        },
        data: {
          billingSettledUnits: units,
          billingSettledPoints: receipt.settled,
          billingPoints: receipt.settled,
          billingSettlementStatus: "settled",
          billingSettledAt: now(),
          billingChargeError: underSettled,
        },
      });
      settled += changed.count;
    } catch (error) {
      await input.prisma.codexPetRun.updateMany({
        where: {
          id: run.id,
          projectId: run.projectId,
          userId: run.userId,
          billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
          billingSettlementStatus: { in: ["reserved", "settle_failed"] },
          status: { in: terminalStatuses },
        },
        data: {
          billingSettlementStatus: "settle_failed",
          billingChargeError: safeWorkerError(error),
        },
      }).catch(() => undefined);
    }
  }
  return settled;
}

export async function reconcileBillingIntents(prisma: PrismaClient, billing: CodexPetChargeClient): Promise<number> {
  const candidates = await listCodexPetBillingReconciliationCandidates({ prisma, limit: 50 });
  let activated = 0;
  for (const candidate of candidates) {
    const { runId, userId, projectId } = candidate;
    try {
      const result = await reconcileCodexPetRunBilling({
        prisma,
        billing,
        runId,
        userId,
        projectId,
      });
      if (!result.shouldEnqueue) continue;
      await enqueueCodexPetRun({ runId });
      activated += 1;
      await getRedis().publish(codexPetRunChannel(runId), "billing-activated").catch(() => undefined);
    } catch (error) {
      console.warn(`[codex-pet-worker] billing reconciliation deferred run=${runId}: ${safeWorkerError(error)}`);
    }
  }
  return activated;
}
