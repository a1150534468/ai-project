/**
 * codex-pet-worker 拆分后的指标层:`WorkerMetrics` 的形状与工厂、事件 → 指标增量的分类,
 * 以及 /metrics 的 Prometheus 文本序列化和承载它的 health server。
 *
 * 这一层是纯计算 + 一个不主动 listen 的 http server(`listen: false` 让测试只走请求
 * 处理器,不开 socket),不碰 prisma / redis / 队列,测试可以零成本 import。
 *
 * `codexPetRetryMetricDelta` 的判据别动:老事件没有 `retryKind`,正整数 `transportAttempt`
 * 是唯一的遗留判别式;把它当成"视觉重修"会让 transportRetries 与 visualRepairAttempts
 * 互相污染。`metricLabel` 是标签注入的唯一防线(引号与换行都会打断 Prometheus 文本)。
 *
 * 依赖方向:support → 本文件 → recovery → codex-pet-worker.ts。
 */

import { createServer, type Server } from "node:http";
import { sanitizeImageUpstreamRequestId } from "../workflow/_shared/image-service.js";

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

export function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function finiteMetric(value: unknown): number {
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

export type StageDurationMetric = { seconds: number; transitions: number };
export type ActionOutcomeMetric = { completed: number; failed: number; retries: number };

export function metricLabel(value: string): string {
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
