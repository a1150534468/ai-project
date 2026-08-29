/**
 * codex-pet 工作进程的入口。原本这一个文件是 1158 行(指标 + 兜底 + 结算 + 编排 + 进程入口),
 * P2.4 拆分后按依赖方向分成五个文件,这里只留编排与入口:
 *
 * - `codex-pet-worker-support.ts`   env 读正数、异常裁成安全诊断串(叶子)
 * - `codex-pet-worker-metrics.ts`   WorkerMetrics、事件 → 指标增量、/metrics 与 health server
 * - `codex-pet-worker-recovery.ts`  量表刷新、产物清理、软删项目与卡死运行重投、抢占释放
 * - `codex-pet-worker-billing.ts`   授权超时取消、按张预留结算、计费意图补偿激活
 *
 * 本文件**不能**变成纯 re-export 门面:`infra/k8s/base/37-codex-pet-worker.yaml` 与
 * package.json 的 `worker:codex-pet` 都按这个路径起进程,底部的 `isDirectWorkerEntrypoint`
 * 守卫必须留在这里;`env.test.ts` 还钉着"这个文件里出现 assertRequiredEnv()"。
 *
 * 对外导出面与拆分前逐字一致,仍是 20 个名字 —— `codex-pet-worker.test.ts` 与
 * `combined-worker.ts` 一行都不用改。新代码要用更细的层就直接 import 对应文件,
 * 不要往这里补 re-export。
 */

import { assertRequiredEnv } from "../env.js";
import { randomUUID } from "node:crypto";
import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import { getObject, makeS3 } from "../storage/s3.js";
import {
  archiveCodexPetRun,
  closeCodexPetCleanupQueue,
  createCodexPetCleanupWorker,
  executeCodexPetProjectCleanup,
  appendCodexPetEvent,
  sanitizeCodexPetDiagnosticText,
  closeCodexPetQueue,
  createCodexPetWorker,
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetLeaseLostError,
  executeCodexPetRun,
  createCodexPetArtifactStore,
  assertCodexPetImageRoute,
  installCodexPetUpstreamDnsOverride,
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  assertCodexPetVisualQaRoute,
} from "../workflow/codex-pet/index.js";
import { isVerifiedWorkflowImageObjectKeyForUser } from "../workflow/_shared/image-service.js";
import { runHeavyWorkerTask } from "./heavy-task-gate.js";
import {
  isDirectWorkerEntrypoint,
  runStandaloneWorker,
  type StartedWorkerRuntime,
} from "./worker-runtime.js";
import { positiveNumber, safeWorkerError } from "./codex-pet-worker-support.js";
import {
  createCodexPetWorkerHealthServer,
  createCodexPetWorkerMetrics,
  jsonRecord,
  recordCodexPetImageFailureMetric,
  recordCodexPetRetryMetrics,
  recordCodexPetUpstreamRequestIdMetric,
  type ActionOutcomeMetric,
  type StageDurationMetric,
} from "./codex-pet-worker-metrics.js";
import {
  cleanupExpiredCodexPetArtifacts,
  observeProviderArtifacts,
  recoverDeletingProjects,
  recoverStaleRuns,
  refreshDatabaseGauges,
  releasePreemptedRuns,
} from "./codex-pet-worker-recovery.js";
import {
  expireParkedCodexPetRuns,
  reconcileBillingIntents,
  reconcilePerImageBillingSettlements,
} from "./codex-pet-worker-billing.js";

export type {
  CodexPetProviderMetricDelta,
  CodexPetRetryMetricDelta,
  WorkerMetrics,
} from "./codex-pet-worker-metrics.js";
export {
  codexPetProviderMetricDelta,
  codexPetRetryMetricDelta,
  codexPetWorkerMetricsText,
  createCodexPetWorkerHealthServer,
  createCodexPetWorkerMetrics,
  recordCodexPetImageFailureMetric,
  recordCodexPetRetryMetrics,
  recordCodexPetUpstreamRequestIdMetric,
} from "./codex-pet-worker-metrics.js";
export {
  cleanupExpiredCodexPetArtifacts,
  recoverDeletingProjects,
  recoverStaleRuns,
  releasePreemptedRuns,
} from "./codex-pet-worker-recovery.js";
export {
  CODEX_PET_FAILED_SETTLEMENT_GRACE_MS,
  CODEX_PET_PARKED_APPROVAL_EXPIRY_MS,
  expireParkedCodexPetRuns,
  reconcilePerImageBillingSettlements,
} from "./codex-pet-worker-billing.js";

export async function startCodexPetWorker(options: {
  readonly healthPort?: number | false;
} = {}): Promise<StartedWorkerRuntime> {
  assertRequiredEnv();
  const imageRoute = assertCodexPetImageRoute(process.env);
  const dnsOverride = installCodexPetUpstreamDnsOverride(imageRoute.generationEndpoint, process.env);
  console.info(`[codex-pet-worker] image route ready model=${imageRoute.model}`);
  if (dnsOverride) {
    console.info(`[codex-pet-worker] upstream DNS override ready host=${dnsOverride.hostname} family=IPv${dnsOverride.family}`);
  }
  const prisma = getPrisma();
  const qualityRun = await prisma.codexPetRun.findFirst({
    where: {
      status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      qualityInspectionEnabled: true,
    },
    select: { id: true },
  });
  if (qualityRun) {
    const visualQaRoute = assertCodexPetVisualQaRoute(process.env);
    console.info(`[codex-pet-worker] visual QA route ready model=${visualQaRoute.model}`);
  } else {
    console.info("[codex-pet-worker] visual QA preflight skipped; no quality-enabled Codex pet run is active");
  }
  const s3 = makeS3();
  const artifacts = createCodexPetArtifactStore({ prisma, s3 });
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const metrics = createCodexPetWorkerMetrics();
  await refreshDatabaseGauges(prisma, metrics);
  let ready = false;
  let lastMaintenanceAt = Date.now();
  const activeDeliveries = new Map<string, { readonly controller: AbortController; readonly workerLeaseId: string }>();
  const observedProviderArtifactIds = new Set<string>();
  const stageDurations = new Map<string, StageDurationMetric>();
  const stageStartedAt = new Map<string, { readonly stage: string; readonly at: number }>();
  const actionOutcomes = new Map<string, ActionOutcomeMetric>();
  const finishObservedStage = (runId: string, at = Date.now()) => {
    const active = stageStartedAt.get(runId);
    if (!active) return;
    const metric = stageDurations.get(active.stage) ?? { seconds: 0, transitions: 0 };
    metric.seconds += Math.max(0, at - active.at) / 1_000;
    metric.transitions += 1;
    stageDurations.set(active.stage, metric);
    stageStartedAt.delete(runId);
  };
  const activated = await reconcileBillingIntents(prisma, billing);
  metrics.billingActivated += activated;
  if (activated) console.info(`[codex-pet-worker] activated ${activated} billed runs`);
  const settled = await reconcilePerImageBillingSettlements({ prisma, billing });
  if (settled) console.info(`[codex-pet-worker] settled ${settled} per-image billed runs`);
  const recovered = await recoverStaleRuns();
  metrics.staleRunsRecovered += recovered;
  if (recovered) console.info(`[codex-pet-worker] recovered ${recovered} queued/stale runs`);
  const deletionRecovery = await recoverDeletingProjects({
    prisma,
    onEnqueueError: (error) => console.warn(
      `[codex-pet-worker] startup deletion recovery deferred: ${safeWorkerError(error)}`,
    ),
  });
  metrics.deletingProjectsRecovered += deletionRecovery.enqueued;
  metrics.deletingProjectRecoveryFailed += deletionRecovery.failed;
  if (deletionRecovery.enqueued) {
    console.info(`[codex-pet-worker] recovered ${deletionRecovery.enqueued} deleting projects`);
  }

  const worker = createCodexPetWorker((job) => runHeavyWorkerTask(async () => {
    const runId = job.data.runId;
    // A Bull delivery gets a unique lease token. `job.id` is the run id and
    // may be re-delivered after stale recovery; reusing it would let an old
    // delivery's heartbeat overwrite a newer owner's lease.
    const workerLeaseId = `bull:${job.id ?? runId}:${randomUUID().slice(0, 12)}`;
    const controller = new AbortController();
    const eligible = await prisma.codexPetRun.findFirst({
      where: {
        id: runId,
        OR: [
          { billingChargeStatus: "charged", billingActivatedAt: { not: null } },
          { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" },
        ],
      },
      select: { id: true },
    });
    // A producer from an older deployment may enqueue before activation. Drop
    // that Bull delivery without touching workflow state; maintenance requeues
    // the same runId after the durable billing saga activates it.
    if (!eligible) return { status: "billing_pending", runId };
    // BullMQ normally de-duplicates by jobId, but a stale-run recovery or a
    // rolling restart can briefly deliver the same run to two processors in
    // one worker process.  Keep the shutdown registry one-to-one with the
    // active lease: allowing a second callback to overwrite this entry would
    // make the first controller invisible to graceful shutdown, and could
    // leave its provider request running after SIGTERM.
    if (activeDeliveries.has(runId)) return { status: "busy", runId };
    activeDeliveries.set(runId, { controller, workerLeaseId });
    const heartbeat = setInterval(() => {
      void prisma.codexPetRun.updateMany({
        where: {
          id: runId,
          workerId: workerLeaseId,
          status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
          OR: [
            { billingChargeStatus: "charged", billingActivatedAt: { not: null } },
            { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" },
          ],
        },
        data: { heartbeatAt: new Date() },
      }).catch(() => undefined);
    }, positiveNumber("CODEX_PET_HEARTBEAT_MS", 10_000));
    try {
      metrics.runsStarted += 1;
      const result = await executeCodexPetRun({
        runId,
        deps: {
          prisma,
          artifacts,
          appendEvent: async (input) => {
            const event = await appendCodexPetEvent(input);
            const eventAt = Date.now();
            const retryMetric = recordCodexPetRetryMetrics(input, metrics);
            if (input.type === "stage.started") {
              finishObservedStage(runId, eventAt);
              stageStartedAt.set(runId, { stage: input.stage, at: eventAt });
            }
            if (input.type === "base.review_required") {
              finishObservedStage(runId, eventAt);
              stageStartedAt.set(runId, { stage: "awaiting_base_review", at: eventAt });
            }
            if (input.stage === "repairing"
              && (input.type === "run.repairing" || input.type === "job.retrying")
              && stageStartedAt.get(runId)?.stage !== "repairing") {
              finishObservedStage(runId, eventAt);
              stageStartedAt.set(runId, { stage: "repairing", at: eventAt });
            }
            if (["run.completed", "run.failed", "run.cancelled"].includes(input.type)) finishObservedStage(runId, eventAt);
            if (input.jobKey) {
              const action = actionOutcomes.get(input.jobKey) ?? { completed: 0, failed: 0, retries: 0 };
              if (input.type === "job.completed") action.completed += 1;
              if (input.type === "validation.failed") action.failed += 1;
              action.retries += retryMetric.actionRetries;
              actionOutcomes.set(input.jobKey, action);
            }
            if (input.type === "job.retrying" || input.type === "run.failed") {
              const payload = jsonRecord(input.payload);
              const upstreamRequestId = recordCodexPetUpstreamRequestIdMetric(payload.upstreamRequestId, metrics);
              if (upstreamRequestId) {
                const jobKey = sanitizeCodexPetDiagnosticText(input.jobKey ?? "run", 100);
                console.warn(
                  `[codex-pet-worker] upstream image request ${input.type} run=${runId} job=${jobKey} upstream_request_id=${upstreamRequestId}`,
                );
              }
            }
            if (input.type === "knowledge.archive_retrying") metrics.archiveRetries += 1;
            if (input.type === "knowledge.archive_completed") metrics.archiveCompleted += 1;
            if (input.type === "validation.warning") metrics.validationWarnings += 1;
            if (input.type === "validation.failed") metrics.validationFailures += 1;
            if (input.type === "run.failed") {
              const category = jsonRecord(input.payload).errorCategory;
              recordCodexPetImageFailureMetric(category, metrics);
            }
            return event;
          },
          archiveRun: archiveCodexPetRun,
          billing,
          loadReferenceAsset: async (asset) => {
            if (!asset.objectKey) throw new Error("桌宠参考图必须来自已验证的私有对象存储");
            if (!isVerifiedWorkflowImageObjectKeyForUser(asset.objectKey, asset.userId)) throw new Error("参考图对象键不在所属用户的工作流命名空间");
            return { buffer: await getObject(s3, asset.objectKey), mime: asset.mime };
          },
          workerId: workerLeaseId,
          signal: controller.signal,
        },
      });
      await observeProviderArtifacts({ prisma, runId, metrics, seenArtifactIds: observedProviderArtifactIds });
      return result;
    } finally {
      await observeProviderArtifacts({ prisma, runId, metrics, seenArtifactIds: observedProviderArtifactIds }).catch(() => undefined);
      clearInterval(heartbeat);
      activeDeliveries.delete(runId);
    }
  }));
  const cleanupWorker = createCodexPetCleanupWorker(async (job) => executeCodexPetProjectCleanup({
    prisma,
    s3,
    ...job.data,
    persistObjectRefs: async (objectRefs) => {
      await job.updateData({ ...job.data, objectRefs });
    },
  }));

  worker.on("completed", (job, result) => {
    const status = String((result as { status?: string } | undefined)?.status ?? "unknown");
    if (status === "ready") metrics.runsCompleted += 1;
    if (status === "cancelled") metrics.runsCancelled += 1;
    console.info(`[codex-pet-worker] completed run=${job.data.runId} state=${status}`);
  });
  worker.on("failed", (job, error) => {
    metrics.runsFailed += 1;
    console.error(`[codex-pet-worker] failed run=${job?.data.runId ?? "unknown"}: ${safeWorkerError(error)}`);
  });
  cleanupWorker.on("completed", (_job, result) => {
    if ((result as { readonly deleted?: boolean } | undefined)?.deleted) metrics.projectsCleaned += 1;
    console.info("[codex-pet-worker] project cleanup completed");
  });
  cleanupWorker.on("failed", (_job, error) => {
    metrics.projectCleanupFailed += 1;
    console.warn(`[codex-pet-worker] project cleanup deferred: ${safeWorkerError(error)}`);
  });

  const healthPort = options.healthPort === false
    ? null
    : options.healthPort ?? Math.floor(positiveNumber("CODEX_PET_WORKER_HEALTH_PORT", 8092));
  const healthServer = healthPort == null ? null : createCodexPetWorkerHealthServer({
      port: healthPort,
      metrics,
      stageDurations,
      actionOutcomes,
      isHealthy: () => ready && Date.now() - lastMaintenanceAt < Math.max(30_000, positiveNumber("CODEX_PET_HEALTH_STALE_MS", 120_000)),
    });
  ready = true;

  let maintenanceRunning = false;
  const maintenance = setInterval(() => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    void (async () => {
      metrics.maintenancePasses += 1;
      const now = new Date();
      await refreshDatabaseGauges(prisma, metrics);
      metrics.billingActivated += await reconcileBillingIntents(prisma, billing);
      const settled = await reconcilePerImageBillingSettlements({ prisma, billing });
      if (settled) console.info(`[codex-pet-worker] settled ${settled} per-image billed runs`);
      metrics.staleRunsRecovered += await recoverStaleRuns();
      const expiredParked = await expireParkedCodexPetRuns({
        prisma,
        billing,
        now: () => now,
        onError: (error, runId) => console.warn(
          `[codex-pet-worker] parked run ${runId} expiry deferred: ${safeWorkerError(error)}`,
        ),
      });
      metrics.parkedRunsExpired += expiredParked;
      if (expiredParked) console.info(`[codex-pet-worker] cancelled ${expiredParked} runs that waited past the approval window`);
      const deletionRecovery = await recoverDeletingProjects({
        prisma,
        onEnqueueError: (error) => console.warn(
          `[codex-pet-worker] deletion recovery deferred: ${safeWorkerError(error)}`,
        ),
      });
      metrics.deletingProjectsRecovered += deletionRecovery.enqueued;
      metrics.deletingProjectRecoveryFailed += deletionRecovery.failed;
      const [refunds, artifactCleanup] = await Promise.all([
        prisma.codexPetRun.findMany({
          where: {
            billingChargeStatus: "charged",
            billingRefundedAt: null,
            billingOperationId: { not: null },
            billingRefundStatus: { in: ["pending", "failed"] },
            OR: [{ billingRefundNextRetryAt: null }, { billingRefundNextRetryAt: { lte: now } }],
          },
          take: 50,
        }),
        cleanupExpiredCodexPetArtifacts({
          prisma,
          s3,
          now,
          onError: (error) => console.warn(
            `[codex-pet-worker] artifact cleanup failed: ${safeWorkerError(error)}`,
          ),
        }),
      ]);
      metrics.artifactsCleaned += artifactCleanup.deleted;
      metrics.artifactCleanupFailed += artifactCleanup.failed;
      for (const run of refunds) {
        try {
          const result = await billing.refundResource(run.billingOperationId!);
          if (!result.success) throw new Error("billing refund was not accepted");
          // Multiple worker replicas/API cancellation can observe the same
          // durable intent.  The external refund is idempotent by operationId;
          // only the process that wins this conditional transition owns the
          // receipt event and metric.
          const transitioned = await prisma.codexPetRun.updateMany({
            where: {
              id: run.id,
              billingRefundedAt: null,
              billingRefundStatus: { in: ["pending", "failed"] },
            },
            data: { billingRefundedAt: now, billingRefundStatus: "refunded", billingRefundError: null, billingRefundLastAttemptAt: now, billingRefundRetryCount: { increment: 1 }, billingRefundNextRetryAt: null },
          });
          if (transitioned.count !== 1) continue;
          metrics.billingRefunded += 1;
          // The receipt is authoritative; a realtime event failure must not
          // turn an already completed refund back into a pending retry.
          await appendCodexPetEvent({ prisma, runId: run.id, type: "billing.refunded", stage: run.status, progress: run.progressPercent, message: "套餐积分已全额退回", payload: { retry: true } }).catch(() => undefined);
        } catch (error) {
          const retryCount = run.billingRefundRetryCount + 1;
          // If another process completed the refund while this external call
          // failed, never overwrite its authoritative receipt with pending.
          const deferred = await prisma.codexPetRun.updateMany({
            where: {
              id: run.id,
              billingRefundedAt: null,
              billingRefundStatus: { in: ["pending", "failed"] },
            },
            data: { billingRefundStatus: "pending", billingRefundError: safeWorkerError(error), billingRefundLastAttemptAt: now, billingRefundRetryCount: retryCount, billingRefundNextRetryAt: new Date(Date.now() + Math.min(24 * 60 * 60_000, 30_000 * 2 ** Math.min(retryCount, 8))) },
          });
          if (deferred.count === 1) metrics.billingRefundFailed += 1;
        }
      }
      lastMaintenanceAt = Date.now();
    })()
      .catch((error) => console.error(`[codex-pet-worker] maintenance pass failed: ${safeWorkerError(error)}`))
      .finally(() => { maintenanceRunning = false; });
  }, positiveNumber("CODEX_PET_MAINTENANCE_MS", 60_000));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    ready = false;
    clearInterval(maintenance);
    console.info(`[codex-pet-worker] received ${signal}, shutting down`);
    try {
      const preempted = [...activeDeliveries.entries()].map(([runId, delivery]) => ({
        runId,
        workerLeaseId: delivery.workerLeaseId,
      }));
      for (const delivery of activeDeliveries.values()) {
        delivery.controller.abort(new CodexPetLeaseLostError());
      }
      await worker.close();
      if (preempted.length > 0) {
        const released = await releasePreemptedRuns({
          prisma,
          deliveries: preempted,
          onEnqueueError: (error, runId) => console.warn(
            `[codex-pet-worker] graceful requeue deferred run=${runId}: ${safeWorkerError(error)}`,
          ),
        });
        if (released) console.info(`[codex-pet-worker] requeued ${released} runs interrupted by ${signal}`);
      }
      await cleanupWorker.close();
      await closeCodexPetQueue();
      await closeCodexPetCleanupQueue();
      if (healthServer) await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    } finally {
      ready = false;
    }
  };
  return { name: "codex-pet-worker", close: shutdown };
}

if (isDirectWorkerEntrypoint(import.meta.url)) {
  runStandaloneWorker({
    name: "codex-pet-worker",
    start: startCodexPetWorker,
    afterClose: () => getPrisma().$disconnect(),
    onFatal: async () => {
      await closeCodexPetQueue().catch(() => undefined);
      await closeCodexPetCleanupQueue().catch(() => undefined);
      await getPrisma().$disconnect().catch(() => undefined);
    },
  });
}
