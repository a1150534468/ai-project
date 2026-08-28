import { assertRequiredEnv } from "../env.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma, getRedis } from "@ai-assistant/db";
import type { PrismaClient } from "@prisma/client";
import { getObject, makeS3, type S3 } from "../storage/s3.js";
import {
  archiveCodexPetRun,
  closeCodexPetCleanupQueue,
  createCodexPetCleanupWorker,
  enqueueCodexPetProjectCleanup,
  executeCodexPetProjectCleanup,
  appendCodexPetEvent,
  codexPetRunChannel,
  sanitizeCodexPetDiagnosticText,
  listCodexPetBillingReconciliationCandidates,
  reconcileCodexPetRunBilling,
  type CodexPetChargeClient,
  closeCodexPetQueue,
  createCodexPetWorker,
  enqueueCodexPetRun,
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetLeaseLostError,
  executeCodexPetRun,
  createCodexPetArtifactStore,
  deleteCodexPetArtifact,
  assertCodexPetImageRoute,
  installCodexPetUpstreamDnsOverride,
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CODEX_PET_PARKED_APPROVAL_EXPIRY_MS,
  CODEX_PET_FAILED_SETTLEMENT_GRACE_MS,
  refundCodexPetUndispatchedExtraCalls,
  assertCodexPetVisualQaRoute,
} from "../workflow/codex-pet/index.js";
import {
  isVerifiedWorkflowImageObjectKeyForUser,
  sanitizeImageUpstreamRequestId,
} from "../workflow/_shared/image-service.js";
import { runHeavyWorkerTask } from "./heavy-task-gate.js";
import {
  isDirectWorkerEntrypoint,
  runStandaloneWorker,
  type StartedWorkerRuntime,
} from "./worker-runtime.js";

function positiveNumber(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeCodexPetDiagnosticText(message, 1_000);
}

export type WorkerMetrics = {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsCancelled: number;
  billingActivated: number;
  billingRefunded: number;
  billingRefundFailed: number;
  staleRunsRecovered: number;
  parkedRunsExpired: number;
  deletingProjectsRecovered: number;
  deletingProjectRecoveryFailed: number;
  projectsCleaned: number;
  projectCleanupFailed: number;
  artifactsCleaned: number;
  artifactCleanupFailed: number;
  maintenancePasses: number;
  gptImageCalls: number;
  gptInputTokens: number;
  gptOutputTokens: number;
  gptTotalTokens: number;
  gptModelMismatches: number;
  gptSizeMismatches: number;
  gptQualityMismatches: number;
  gptRequestIdsCaptured: number;
  visualRepairAttempts: number;
  transportRetries: number;
  rateLimitFailures: number;
  timeoutFailures: number;
  upstreamFailures: number;
  networkFailures: number;
  authenticationFailures: number;
  moderationFailures: number;
  invalidRequestFailures: number;
  archiveRetries: number;
  archiveCompleted: number;
  validationWarnings: number;
  validationFailures: number;
  activeRuns: number;
  archivingRuns: number;
  readyRunsMissingArchive: number;
  readyRunsMissingDeliverables: number;
  databaseProjects: number;
  databaseReadyRuns: number;
  databaseFailedRuns: number;
  databaseCancelledRuns: number;
  databaseRefundedRuns: number;
  knowledgePendingDocuments: number;
  knowledgeIndexingDocuments: number;
  knowledgeFailedDocuments: number;
};

export function createCodexPetWorkerMetrics(): WorkerMetrics {
  return {
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    runsCancelled: 0,
    billingActivated: 0,
    billingRefunded: 0,
    billingRefundFailed: 0,
    staleRunsRecovered: 0,
    parkedRunsExpired: 0,
    deletingProjectsRecovered: 0,
    deletingProjectRecoveryFailed: 0,
    projectsCleaned: 0,
    projectCleanupFailed: 0,
    artifactsCleaned: 0,
    artifactCleanupFailed: 0,
    maintenancePasses: 0,
    gptImageCalls: 0,
    gptInputTokens: 0,
    gptOutputTokens: 0,
    gptTotalTokens: 0,
    gptModelMismatches: 0,
    gptSizeMismatches: 0,
    gptQualityMismatches: 0,
    gptRequestIdsCaptured: 0,
    visualRepairAttempts: 0,
    transportRetries: 0,
    rateLimitFailures: 0,
    timeoutFailures: 0,
    upstreamFailures: 0,
    networkFailures: 0,
    authenticationFailures: 0,
    moderationFailures: 0,
    invalidRequestFailures: 0,
    archiveRetries: 0,
    archiveCompleted: 0,
    validationWarnings: 0,
    validationFailures: 0,
    activeRuns: 0,
    archivingRuns: 0,
    readyRunsMissingArchive: 0,
    readyRunsMissingDeliverables: 0,
    databaseProjects: 0,
    databaseReadyRuns: 0,
    databaseFailedRuns: 0,
    databaseCancelledRuns: 0,
    databaseRefundedRuns: 0,
    knowledgePendingDocuments: 0,
    knowledgeIndexingDocuments: 0,
    knowledgeFailedDocuments: 0,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface CodexPetRetryMetricDelta {
  readonly visualRepairAttempts: 0 | 1;
  readonly transportRetries: 0 | 1;
  readonly actionRetries: 0 | 1;
  readonly failureCategory: unknown;
}

/**
 * Classify retry events without inferring transport failures from a visual
 * job's attempt counter. Older transport events predate `retryKind`, so a
 * positive integer `transportAttempt` remains the only legacy discriminator.
 */
export function codexPetRetryMetricDelta(input: {
  readonly type: unknown;
  readonly payload?: unknown;
}): CodexPetRetryMetricDelta {
  if (input.type === "run.repairing") {
    return {
      visualRepairAttempts: 1,
      transportRetries: 0,
      actionRetries: 1,
      failureCategory: null,
    };
  }
  if (input.type !== "job.retrying") {
    return {
      visualRepairAttempts: 0,
      transportRetries: 0,
      actionRetries: 0,
      failureCategory: null,
    };
  }

  const payload = jsonRecord(input.payload);
  const retryKind = payload.retryKind;
  const transportAttempt = payload.transportAttempt;
  const isLegacyTransportRetry = retryKind == null
    && typeof transportAttempt === "number"
    && Number.isSafeInteger(transportAttempt)
    && transportAttempt > 0;
  const isTransportRetry = retryKind === "transport" || isLegacyTransportRetry;
  return {
    visualRepairAttempts: 0,
    transportRetries: isTransportRetry ? 1 : 0,
    actionRetries: isTransportRetry ? 1 : 0,
    failureCategory: isTransportRetry ? payload.category : null,
  };
}

export interface CodexPetProviderMetricDelta {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly modelMismatches: number;
  readonly sizeMismatches: number;
  readonly qualityMismatches: number;
  readonly requestIdsCaptured: number;
}

/** Convert persisted, sanitized provider metadata into one Prometheus delta. */
export function codexPetProviderMetricDelta(value: unknown): CodexPetProviderMetricDelta {
  const metadata = jsonRecord(value);
  const usage = jsonRecord(metadata.usage);
  return {
    calls: 1,
    inputTokens: finiteMetric(usage.inputTokens),
    outputTokens: finiteMetric(usage.outputTokens),
    totalTokens: finiteMetric(usage.totalTokens),
    modelMismatches: metadata.requestedModel && metadata.actualModel && metadata.requestedModel !== metadata.actualModel ? 1 : 0,
    sizeMismatches: metadata.requestedSize && metadata.actualSize && metadata.requestedSize !== metadata.actualSize ? 1 : 0,
    qualityMismatches: metadata.requestedQuality && metadata.actualQuality && metadata.requestedQuality !== metadata.actualQuality ? 1 : 0,
    requestIdsCaptured: sanitizeImageUpstreamRequestId(metadata.upstreamRequestId) ? 1 : 0,
  };
}

export function recordCodexPetUpstreamRequestIdMetric(value: unknown, metrics: WorkerMetrics): string | null {
  const requestId = sanitizeImageUpstreamRequestId(value);
  if (requestId) metrics.gptRequestIdsCaptured += 1;
  return requestId;
}

export function recordCodexPetImageFailureMetric(category: unknown, metrics: WorkerMetrics): void {
  if (category === "rate_limit") metrics.rateLimitFailures += 1;
  if (category === "timeout") metrics.timeoutFailures += 1;
  if (category === "upstream") metrics.upstreamFailures += 1;
  if (category === "network") metrics.networkFailures += 1;
  if (category === "authentication") metrics.authenticationFailures += 1;
  if (category === "moderation") metrics.moderationFailures += 1;
  if (category === "invalid_request") metrics.invalidRequestFailures += 1;
}

export function recordCodexPetRetryMetrics(
  input: { readonly type: unknown; readonly payload?: unknown },
  metrics: WorkerMetrics,
): CodexPetRetryMetricDelta {
  const delta = codexPetRetryMetricDelta(input);
  metrics.transportRetries += delta.transportRetries;
  metrics.visualRepairAttempts += delta.visualRepairAttempts;
  if (delta.transportRetries) recordCodexPetImageFailureMetric(delta.failureCategory, metrics);
  return delta;
}

async function observeProviderArtifacts(input: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly metrics: WorkerMetrics;
  readonly seenArtifactIds: Set<string>;
}): Promise<void> {
  const artifacts = await input.prisma.codexPetArtifact.findMany({
    where: { runId: input.runId, kind: { in: ["base_candidate", "pose_board"] } },
    select: { id: true, metadata: true },
  });
  for (const artifact of artifacts) {
    if (input.seenArtifactIds.has(artifact.id)) continue;
    input.seenArtifactIds.add(artifact.id);
    const delta = codexPetProviderMetricDelta(artifact.metadata);
    input.metrics.gptImageCalls += delta.calls;
    input.metrics.gptInputTokens += delta.inputTokens;
    input.metrics.gptOutputTokens += delta.outputTokens;
    input.metrics.gptTotalTokens += delta.totalTokens;
    input.metrics.gptModelMismatches += delta.modelMismatches;
    input.metrics.gptSizeMismatches += delta.sizeMismatches;
    input.metrics.gptQualityMismatches += delta.qualityMismatches;
    input.metrics.gptRequestIdsCaptured += delta.requestIdsCaptured;
  }
  // Bound process memory while retaining enough IDs to de-duplicate every
  // active/recent run. Counters are process-lifetime metrics and reset on a
  // worker restart as normal Prometheus counters do.
  if (input.seenArtifactIds.size > 100_000) input.seenArtifactIds.clear();
}

export async function cleanupExpiredCodexPetArtifacts(input: {
  readonly prisma: PrismaClient;
  readonly s3?: S3;
  readonly now?: Date;
  readonly limit?: number;
  readonly deleteArtifact?: typeof deleteCodexPetArtifact;
  readonly onError?: (error: unknown, artifactId: string) => void;
}): Promise<{ readonly scanned: number; readonly deleted: number; readonly failed: number }> {
  const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 100)));
  const expired = await input.prisma.codexPetArtifact.findMany({
    where: { expiresAt: { lte: input.now ?? new Date() } },
    orderBy: { expiresAt: "asc" },
    select: { id: true, userId: true },
    take: limit,
  });
  const remove = input.deleteArtifact ?? deleteCodexPetArtifact;
  let deleted = 0;
  let failed = 0;
  for (const artifact of expired) {
    try {
      const removed = await remove({
        prisma: input.prisma,
        artifactId: artifact.id,
        userId: artifact.userId,
        s3: input.s3,
      });
      if (removed) deleted += 1;
    } catch (error) {
      failed += 1;
      input.onError?.(error, artifact.id);
    }
  }
  return { scanned: expired.length, deleted, failed };
}

async function refreshDatabaseGauges(prisma: PrismaClient, metrics: WorkerMetrics): Promise<void> {
  const [
    activeRuns,
    archivingRuns,
    readyRunsMissingArchive,
    readyRunsMissingDeliverables,
    databaseProjects,
    databaseReadyRuns,
    databaseFailedRuns,
    databaseCancelledRuns,
    databaseRefundedRuns,
    knowledgePendingDocuments,
    knowledgeIndexingDocuments,
    knowledgeFailedDocuments,
  ] = await Promise.all([
    prisma.codexPetRun.count({ where: { status: { in: [...CODEX_PET_ACTIVE_STATUSES] } } }),
    prisma.codexPetRun.count({ where: { status: "archiving" } }),
    prisma.codexPetRun.count({ where: { status: "ready", knowledgeDocumentId: null } }),
    prisma.codexPetRun.count({ where: {
      status: "ready",
      OR: [
        { spritesheetArtifactId: null },
        { packageArtifactId: null },
        { previewArtifactId: null },
      ],
    } }),
    prisma.codexPetProject.count(),
    prisma.codexPetRun.count({ where: { status: "ready" } }),
    prisma.codexPetRun.count({ where: { status: "failed" } }),
    prisma.codexPetRun.count({ where: { status: "cancelled" } }),
    prisma.codexPetRun.count({ where: { billingRefundedAt: { not: null } } }),
    prisma.document.count({ where: { sourceModule: "codex_pet", status: "pending" } }),
    prisma.document.count({ where: { sourceModule: "codex_pet", status: "indexing" } }),
    prisma.document.count({ where: { sourceModule: "codex_pet", status: "failed" } }),
  ]);
  metrics.activeRuns = activeRuns;
  metrics.archivingRuns = archivingRuns;
  metrics.readyRunsMissingArchive = readyRunsMissingArchive;
  metrics.readyRunsMissingDeliverables = readyRunsMissingDeliverables;
  metrics.databaseProjects = databaseProjects;
  metrics.databaseReadyRuns = databaseReadyRuns;
  metrics.databaseFailedRuns = databaseFailedRuns;
  metrics.databaseCancelledRuns = databaseCancelledRuns;
  metrics.databaseRefundedRuns = databaseRefundedRuns;
  metrics.knowledgePendingDocuments = knowledgePendingDocuments;
  metrics.knowledgeIndexingDocuments = knowledgeIndexingDocuments;
  metrics.knowledgeFailedDocuments = knowledgeFailedDocuments;
}

type StageDurationMetric = { seconds: number; transitions: number };
type ActionOutcomeMetric = { completed: number; failed: number; retries: number };

function metricLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
}

export function codexPetWorkerMetricsText(
  metrics: WorkerMetrics,
  stageDurations: ReadonlyMap<string, StageDurationMetric>,
  actionOutcomes: ReadonlyMap<string, ActionOutcomeMetric>,
): string {
  const lines = Object.entries(metrics)
    .map(([key, value]) => `codex_pet_worker_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} ${value}`);
  for (const [stage, value] of stageDurations) {
    const label = metricLabel(stage);
    lines.push(`codex_pet_worker_stage_duration_seconds_total{stage="${label}"} ${value.seconds}`);
    lines.push(`codex_pet_worker_stage_transitions_total{stage="${label}"} ${value.transitions}`);
  }
  for (const [jobKey, value] of actionOutcomes) {
    const label = metricLabel(jobKey);
    lines.push(`codex_pet_worker_action_completed_total{job_key="${label}"} ${value.completed}`);
    lines.push(`codex_pet_worker_action_failed_total{job_key="${label}"} ${value.failed}`);
    lines.push(`codex_pet_worker_action_retries_total{job_key="${label}"} ${value.retries}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function recoverDeletingProjects(input: {
  readonly prisma?: PrismaClient;
  readonly enqueue?: (payload: { readonly userId: string; readonly projectId: string }) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onEnqueueError?: (error: unknown, projectId: string) => void;
} = {}): Promise<{ readonly scanned: number; readonly enqueued: number; readonly failed: number }> {
  const env = input.env ?? process.env;
  const prisma = input.prisma ?? getPrisma();
  const enqueue = input.enqueue ?? enqueueCodexPetProjectCleanup;
  // A bounded scan runs every maintenance pass. Queue jobId is derived from
  // projectId, so this safely repairs both an API crash after the `deleting`
  // transaction and a first Queue.add failure without multiplying jobs.
  const limit = Math.max(1, Math.floor(positiveNumber("CODEX_PET_CLEANUP_RECOVERY_LIMIT", 100, env)));
  const projects = await prisma.codexPetProject.findMany({
    // `deletedAt` marks the new soft-delete path. Only legacy tombstones
    // without that marker still belong to the old hard-cleanup queue.
    where: { status: "deleting", deletedAt: null },
    orderBy: { updatedAt: "asc" },
    select: { id: true, userId: true },
    take: limit,
  });
  let enqueued = 0;
  let failed = 0;
  for (const project of projects) {
    try {
      await enqueue({ userId: project.userId, projectId: project.id });
      enqueued += 1;
    } catch (error) {
      failed += 1;
      input.onEnqueueError?.(error, project.id);
    }
  }
  return { scanned: projects.length, enqueued, failed };
}

export function createCodexPetWorkerHealthServer(args: {
  readonly port: number;
  readonly isHealthy: () => boolean;
  readonly metrics: WorkerMetrics;
  readonly stageDurations: ReadonlyMap<string, StageDurationMetric>;
  readonly actionOutcomes: ReadonlyMap<string, ActionOutcomeMetric>;
  /** Tests can exercise the exact request handler without opening a socket. */
  readonly listen?: boolean;
}): Server {
  const server = createServer((request, response) => {
    const healthy = args.isHealthy();
    if (request.url?.split("?", 1)[0] === "/metrics") {
      response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(codexPetWorkerMetricsText(args.metrics, args.stageDurations, args.actionOutcomes));
      return;
    }
    response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: healthy, worker: "codex-pet" }));
  });
  if (args.listen !== false) server.listen(args.port, "0.0.0.0");
  return server;
}

export async function recoverStaleRuns(input: {
  readonly prisma?: PrismaClient;
  readonly enqueue?: (runId: string) => Promise<void>;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<number> {
  const env = input.env ?? process.env;
  const prisma = input.prisma ?? getPrisma();
  const now = input.now ?? (() => new Date());
  const enqueue = input.enqueue ?? ((runId: string) => enqueueCodexPetRun({ runId }));
  const staleBefore = new Date(now().getTime() - positiveNumber("CODEX_PET_STALE_RUN_MS", 15 * 60_000, env));
  const pausedStatuses = new Set(["awaiting_base_review", "awaiting_direction_review", "awaiting_regeneration_approval"]);
  const runs = await prisma.codexPetRun.findMany({
    where: {
      status: { in: [...CODEX_PET_ACTIVE_STATUSES].filter((status) => !pausedStatuses.has(status)) },
      AND: [
        {
          OR: [
            { billingChargeStatus: "charged", billingActivatedAt: { not: null } },
            { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" },
          ],
        },
        {
          OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }, { status: "queued" }],
        },
      ],
      // A cancellation requested while a worker owns the lease intentionally
      // leaves the run active until that worker reaches a safe checkpoint.
      // If the worker dies first, the persisted flag must still be recovered;
      // executeCodexPetRun will claim the stale lease and immediately settle
      // the cancellation/refund instead of leaving the run stuck forever.
    },
    select: { id: true },
    take: 500,
  });
  await Promise.all(runs.map((run) => enqueue(run.id).catch(() => undefined)));
  return runs.length;
}

type CodexPetSettlementClient = {
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
    select: { id: true, projectId: true, userId: true, billingOperationId: true, billingResourceKey: true },
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
          billingChargeError: null,
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

export async function releasePreemptedRuns(input: {
  readonly prisma: PrismaClient;
  readonly deliveries: readonly { readonly runId: string; readonly workerLeaseId: string }[];
  readonly enqueue?: (runId: string) => Promise<void>;
  readonly onEnqueueError?: (error: unknown, runId: string) => void;
}): Promise<number> {
  const enqueue = input.enqueue ?? ((runId: string) => enqueueCodexPetRun({ runId }));
  let released = 0;
  for (const delivery of input.deliveries) {
    const result = await input.prisma.codexPetRun.updateMany({
      where: {
        id: delivery.runId,
        workerId: delivery.workerLeaseId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      },
      data: { workerId: null, heartbeatAt: null },
    });
    if (result.count !== 1) continue;
    released += 1;
    // Queue.add is idempotent by runId. If Redis is temporarily unavailable,
    // heartbeatAt=null also makes the next maintenance pass recover the run.
    await enqueue(delivery.runId).catch((error) => input.onEnqueueError?.(error, delivery.runId));
  }
  return released;
}

async function reconcileBillingIntents(prisma: PrismaClient, billing: CodexPetChargeClient): Promise<number> {
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
