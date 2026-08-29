import type { FastifyInstance } from "fastify";
import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import { enqueueCodexPetRun } from "./codex-pet-queue.js";
import { IMAGE_REFERENCE_MIME_TYPES } from "../_shared/image-service.js";
import { isCodexPetArtifactObjectKey } from "./codex-pet-storage.js";
import {
  CODEX_PET_BAILIAN_VISUAL_QA_MODEL,
  CODEX_PET_IMAGE_MODELS,
  CODEX_PET_VISUAL_QA_MODEL,
} from "./codex-pet-model-contract.js";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  refundCodexPetUndispatchedExtraCalls,
} from "./codex-pet-call-ledger.js";
import { codexPetUnderSettledDiagnostic } from "./codex-pet-billing.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import {
  resolvePricing,
  safeDiagnostic,
  validateCodexPetReferenceAsset,
} from "./codex-pet-route-helpers.js";
import type { CodexPetRouteDeps, ResourcePrice, RunShape } from "./codex-pet-route-types.js";

// 拆分 codex-pet-routes.ts 时抽出的共享上下文：原来是插件函数体顶部的依赖解析和
// 8 个闭包，各路由分组都要用。类型由返回值推导，避免在这里再手写一份签名。
export function createCodexPetRouteContext(app: FastifyInstance, deps: CodexPetRouteDeps) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const enqueueRun = deps.enqueueRun ?? ((runId: string) => enqueueCodexPetRun({ runId }));
  const now = deps.now ?? (() => new Date());
  const loadArtifact = deps.loadArtifact ?? ((objectKey: string) => {
    // The production loader is the last boundary before S3. Embedded tests
    // may provide an in-memory loader with synthetic keys, but the real route
    // must never follow a database row outside our private prefix.
    // The caller performs the row-level ownership check before invoking this
    // loader. Keep the generic namespace guard here as defense in depth.
    if (!isCodexPetArtifactObjectKey(objectKey)) throw new Error("invalid Codex pet artifact object key");
    return getObject(makeS3(loadS3Config()), objectKey);
  });
  const validateReferenceAsset = deps.validateReferenceAsset ?? ((asset: {
    readonly id: string;
    readonly userId: string;
    readonly objectKey: string;
    readonly mime: string;
  }) => validateCodexPetReferenceAsset(
    asset,
    (objectKey) => getObject(makeS3(loadS3Config()), objectKey),
  ));

  async function ownedProject(userId: string, projectId: string) {
    return prisma.codexPetProject.findFirst({ where: { id: projectId, userId, deletedAt: null } });
  }

  async function ownedRun(userId: string, projectId: string, runId: string) {
    return prisma.codexPetRun.findFirst({ where: { id: runId, projectId, userId } });
  }

  async function validateReferenceAssets(userId: string, assetIds: readonly string[]): Promise<boolean> {
    if (assetIds.length === 0) return true;
    const assets = await prisma.imageAsset.findMany({
      where: { userId, id: { in: [...assetIds] } },
      select: { id: true, objectKey: true, mime: true },
    });
    if (assets.length !== assetIds.length) return false;
    if (!assets.every((asset) => Boolean(asset.objectKey)
      && IMAGE_REFERENCE_MIME_TYPES.has(asset.mime.toLowerCase().split(";", 1)[0]!))) return false;
    const checks = await Promise.all(assets.map((asset) => validateReferenceAsset({
      id: asset.id,
      userId,
      objectKey: asset.objectKey!,
      mime: asset.mime,
    }).catch(() => false)));
    return checks.every(Boolean);
  }

  async function codexPetModelOptions() {
    const configured = await billing.listEnabledModels?.();
    const visualModels = (configured?.data ?? [])
      .filter((model) => {
        const normalized = model.model.trim().toLowerCase();
        const tags = new Set((model.tags ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean));
        const verifiedWithoutCatalogTag = normalized === CODEX_PET_VISUAL_QA_MODEL
          || normalized === CODEX_PET_BAILIAN_VISUAL_QA_MODEL;
        return normalized.length > 0
          && !normalized.includes("embedding")
          && !normalized.startsWith("qwen3.7")
          && !normalized.includes("image")
          && !normalized.includes("ocr")
          && !tags.has("image-gen")
          && !tags.has("ocr")
          && (verifiedWithoutCatalogTag || tags.has("vision"));
      })
      .map((model) => ({ model: model.model, displayName: model.displayName || model.model }));
    const fallbackVisual = [{ model: CODEX_PET_VISUAL_QA_MODEL, displayName: "GPT-5.6 Sol" }];
    return {
      visualModels: visualModels.length > 0 ? visualModels : fallbackVisual,
      imageModels: CODEX_PET_IMAGE_MODELS.map((model) => ({ model, displayName: "GPT Image 2" })),
    } as const;
  }

  async function selectedVisualModelIsAvailable(model: string): Promise<boolean> {
    const options = await codexPetModelOptions();
    return options.visualModels.some((candidate) => candidate.model === model);
  }

  async function price(): Promise<ResourcePrice> {
    const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
    return resolvePricing(rows);
  }

  async function createCancellation(
    userId: string,
    projectId: string,
    runId: string,
  ): Promise<{ readonly run: RunShape; readonly eventSequences: readonly number[]; readonly refundPending: boolean }> {
    return prisma.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns PostgreSQL `void`. Prisma attempts to
      // deserialize SELECT rows issued through $queryRawUnsafe and raises
      // P2010 for that type, so execute the statement without decoding rows.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-cancel:${runId}`);
      await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', runId);
      const current = await tx.codexPetRun.findFirst({ where: { id: runId, projectId, userId } });
      if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
      if (current.status === "ready" || current.status === "failed" || current.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
        throw new Error("CODEX_PET_RUN_TERMINAL");
      }
      const definitelyUncharged = current.billingActivatedAt === null
        && (current.billingChargeStatus === "pending" || current.billingChargeStatus === "insufficient" || current.billingChargeStatus === "cancelled");
      const chargeConfirmed = current.billingChargeStatus === "charged";
      if (current.status === "cancelled") {
        const attemptedAt = now();
        if (definitelyUncharged && current.billingChargeStatus !== "cancelled") {
          const released = await tx.codexPetRun.update({
            where: { id: current.id },
            data: {
              billingChargeStatus: "cancelled",
              billingChargeError: null,
              billingChargeLeaseUntil: null,
              billingChargeNextRetryAt: null,
            },
          });
          return { run: released as RunShape, eventSequences: [], refundPending: false };
        }
        const refundEligible = chargeConfirmed
          && !current.hasSuccessfulImage
          // A legacy run may have reached base review before the
          // hasSuccessfulImage marker was introduced. Its first cancellation
          // intentionally leaves billingRefundStatus=none; require a durable
          // refund intent here so a duplicate cancellation cannot infer a
          // refund from the now-generic `cancelled` status and charge history.
          && (current.billingRefundStatus === "pending" || current.billingRefundStatus === "failed")
          && Boolean(current.billingOperationId)
          && !current.billingRefundedAt;
        const retryDue = !current.billingRefundNextRetryAt || current.billingRefundNextRetryAt <= attemptedAt;
        if (!refundEligible || !retryDue) return { run: current as RunShape, eventSequences: [], refundPending: false };
        const claimed = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            billingRefundStatus: "pending",
            billingRefundError: null,
            // This is a short durable lease. If the API process dies after
            // commit, maintenance retries the idempotent billing operation.
            billingRefundNextRetryAt: new Date(attemptedAt.getTime() + 60_000),
          },
        });
        return { run: claimed as RunShape, eventSequences: [], refundPending: true };
      }
      if (current.workerId && current.cancelRequested) {
        return { run: current as RunShape, eventSequences: [], refundPending: false };
      }

      // A live worker may still finish an image-generation request after this
      // transaction begins. Persist the flag and let that worker decide the
      // refund only after it has stopped, so the first-successful-image policy
      // cannot race with a refund here.
      if (current.workerId) {
        const requested = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            cancelRequested: true,
            progressMessage: "正在取消桌宠制作",
            lastEventSequence: { increment: 1 },
          },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId,
            runId,
            userId,
            sequence: requested.lastEventSequence,
            type: "run.cancellation_requested",
            stage: requested.progressStage,
            message: "已请求取消桌宠制作，正在等待当前子任务停止",
            progress: requested.progressPercent,
            payload: {},
          },
        });
        return { run: requested as RunShape, eventSequences: [requested.lastEventSequence], refundPending: false };
      }

      const cancelledAt = now();
      // Never refund a merely pending/charging/uncertain operation. An
      // idempotent charge may still settle later; the billing reconciler then
      // records the confirmed charge and creates a fresh durable refund intent.
      const refundPending = chargeConfirmed
        && !current.hasSuccessfulImage
        && current.status !== "awaiting_base_review"
        && Boolean(current.billingOperationId)
        && !current.billingRefundedAt;
      const updated = await tx.codexPetRun.update({
        where: { id: current.id },
        data: {
          cancelRequested: true,
          status: "cancelled",
          progressStage: "cancelled",
          progressMessage: "用户已取消",
          completedAt: cancelledAt,
          lastEventSequence: { increment: 1 },
          ...(definitelyUncharged ? {
            billingChargeStatus: "cancelled",
            billingChargeError: null,
            billingChargeLeaseUntil: null,
            billingChargeNextRetryAt: null,
          } : {}),
          ...(refundPending ? {
            billingRefundStatus: "pending",
            billingRefundError: null,
            billingRefundNextRetryAt: new Date(cancelledAt.getTime() + 60_000),
          } : {}),
        },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId,
          runId,
          userId,
          sequence: updated.lastEventSequence,
          type: "run.cancelled",
          stage: "cancelled",
          message: "用户已取消桌宠制作",
          progress: updated.progressPercent,
          payload: { refundEligible: !updated.hasSuccessfulImage },
        },
      });

      await tx.codexPetProject.updateMany({
        where: { id: projectId, userId, latestRunId: runId, status: { not: "deleting" } },
        data: { status: definitelyUncharged ? "draft" : "cancelled" },
      });
      return { run: updated as RunShape, eventSequences: [updated.lastEventSequence], refundPending };
    });
  }

  async function settleCancellationRefund(
    result: { readonly run: RunShape; readonly eventSequences: readonly number[]; readonly refundPending: boolean },
  ): Promise<{ readonly run: RunShape; readonly eventSequences: readonly number[]; readonly refundPending: boolean }> {
    if (result.run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
      // Extra calls charged at approval but never dispatched are refunded on
      // their own axis: they are not part of the run reservation, so the planned
      // settle below can neither return nor account for them. Runs first so an
      // already-settled reservation does not short-circuit the extras refund.
      let extraRefundSequences = result.eventSequences;
      if (result.run.status === "cancelled" && result.run.workerId === null) {
        const extras = await refundCodexPetUndispatchedExtraCalls({
          prisma,
          billing,
          runId: result.run.id,
          projectId: result.run.projectId,
          userId: result.run.userId,
        }).catch(() => ({ refunded: 0, pending: 0 }));
        if (extras.refunded > 0) {
          const recorded = await prisma.$transaction(async (tx) => {
            const bumped = await tx.codexPetRun.update({
              where: { id: result.run.id },
              data: { lastEventSequence: { increment: 1 } },
              select: { lastEventSequence: true, projectId: true, userId: true, status: true, progressPercent: true },
            });
            await tx.codexPetEvent.create({
              data: {
                projectId: bumped.projectId,
                runId: result.run.id,
                userId: bumped.userId,
                sequence: bumped.lastEventSequence,
                type: "billing.refunded",
                stage: bumped.status,
                message: `已退回 ${extras.refunded} 次已授权但未派发的额外生图积分`,
                progress: bumped.progressPercent,
                payload: { refundedExtraCalls: extras.refunded, pendingExtraRefunds: extras.pending },
              },
            });
            return bumped.lastEventSequence;
          }).catch(() => null);
          if (recorded !== null) extraRefundSequences = [...extraRefundSequences, recorded];
        }
      }
      result = { ...result, eventSequences: extraRefundSequences };
      if (result.run.status !== "cancelled"
        || result.run.workerId !== null
        || result.run.billingSettlementStatus === "settled"
        || (result.run.billingSettlementStatus !== "reserved" && result.run.billingSettlementStatus !== "settle_failed")
        || !result.run.billingOperationId
        || !result.run.billingResourceKey
        || !billing.settleResource) return result;
      try {
        // Must match the runner and the sweeper exactly: a planned call that
        // failed at the provider delivered no image and is not settled.
        const units = await prisma.codexPetImageCall.count({
          where: {
            runId: result.run.id,
            projectId: result.run.projectId,
            userId: result.run.userId,
            callKind: "planned",
            sentAt: { not: null },
            status: { not: "failed" },
          },
        });
        const receipt = await billing.settleResource({
          operationId: result.run.billingOperationId,
          resourceKey: result.run.billingResourceKey,
          units,
        });
        // 取消是按图预留最常见的收口路径（用户手动取消、暂停到期清理都从这里过），
        // 原先无条件写 billingChargeError: null——已交付却结算到 0 点在这里同样被
        // 抹平。口径与 runner 的 settlePerImageRunBilling 和 worker 兜底完全一致，
        // 否则 correctCodexPetPerImageBilling 巡检会漏掉从取消进来的那一半。
        const underSettled = codexPetUnderSettledDiagnostic({
          units,
          settledPoints: receipt.settled,
          reservedPoints: result.run.billingReservedPoints,
        });
        const settled = await prisma.codexPetRun.update({
          where: { id: result.run.id },
          data: {
            billingSettledUnits: units,
            billingSettledPoints: receipt.settled,
            billingPoints: receipt.settled,
            billingSettlementStatus: "settled",
            billingSettledAt: now(),
            billingChargeError: underSettled,
          },
        });
        return { ...result, run: settled as RunShape };
      } catch (error) {
        const deferred = await prisma.codexPetRun.update({
          where: { id: result.run.id },
          data: {
            billingSettlementStatus: "settle_failed",
            billingChargeError: safeDiagnostic(error),
          },
        }).catch(() => null);
        return { ...result, run: (deferred as RunShape | null) ?? result.run };
      }
    }
    const operationId = result.run.billingOperationId;
    if (!result.refundPending
      || result.run.billingChargeStatus !== "charged"
      || !operationId
      || result.run.billingRefundedAt) return result;
    const attemptedAt = now();
    try {
      const refund = await billing.refundResource(operationId);
      if (!refund.success) throw new Error("billing refund was not accepted");
      const settled = await prisma.$transaction(async (tx) => {
        // Billing refunds are idempotent by operationId. This conditional DB
        // transition ensures concurrent API/maintenance attempts create only
        // one persisted billing.refunded event.
        const transition = await tx.codexPetRun.updateMany({
          where: { id: result.run.id, billingRefundedAt: null },
          data: {
            billingRefundedAt: attemptedAt,
            billingRefundStatus: "refunded",
            billingRefundError: null,
            billingRefundLastAttemptAt: attemptedAt,
            billingRefundRetryCount: { increment: 1 },
            billingRefundNextRetryAt: null,
            lastEventSequence: { increment: 1 },
          },
        });
        const run = await tx.codexPetRun.findFirst({ where: { id: result.run.id } });
        if (!run) throw new Error("CODEX_PET_RUN_NOT_FOUND");
        if (transition.count === 0) return { run: run as RunShape, sequence: null as number | null };
        await tx.codexPetEvent.create({
          data: {
            projectId: run.projectId,
            runId: run.id,
            userId: run.userId,
            sequence: run.lastEventSequence,
            type: "billing.refunded",
            stage: run.status,
            message: "套餐积分已全额退回",
            progress: run.progressPercent,
            payload: { operationId },
          },
        });
        return { run: run as RunShape, sequence: run.lastEventSequence as number | null };
      });
      return {
        run: settled.run,
        eventSequences: settled.sequence === null ? result.eventSequences : [...result.eventSequences, settled.sequence],
        refundPending: false,
      };
    } catch (error) {
      // Cancellation was committed before the external call. Keep the durable
      // pending marker even if billing or the success-record transaction
      // fails; maintenance safely retries the same operationId.
      await prisma.codexPetRun.updateMany({
        where: { id: result.run.id, billingRefundedAt: null },
        data: {
          billingRefundStatus: "pending",
          billingRefundError: error instanceof Error ? error.message.slice(0, 500) : "退款失败",
          billingRefundRetryCount: { increment: 1 },
          billingRefundLastAttemptAt: attemptedAt,
          billingRefundNextRetryAt: new Date(attemptedAt.getTime() + 60_000),
        },
      }).catch(() => undefined);
      app.log.warn({ runId: result.run.id }, "Codex pet cancellation refund deferred for retry");
      const current = await prisma.codexPetRun.findFirst({ where: { id: result.run.id } }).catch(() => null);
      return { ...result, run: (current as RunShape | null) ?? result.run, refundPending: true };
    }
  }

  return {
    deps,
    prisma,
    billing,
    enqueueRun,
    now,
    loadArtifact,
    validateReferenceAsset,
    ownedProject,
    ownedRun,
    validateReferenceAssets,
    codexPetModelOptions,
    selectedVisualModelIsAvailable,
    price,
    createCancellation,
    settleCancellationRefund,
  };
}

export type CodexPetRouteContext = ReturnType<typeof createCodexPetRouteContext>;
