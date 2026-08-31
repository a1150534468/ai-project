/**
 * codex-pet-worker 拆分后的兜底层:数据库量表刷新、上游用量观测、过期产物清理、
 * 软删项目重投、卡死运行重投,以及优雅停机时释放被抢占的运行。
 *
 * 每个函数都能独立跑一遍(入参对象里 prisma / enqueue / now / deleteArtifact 都可注入),
 * 启动时与维护循环各调一次。它们只读写自己那张表,**不做结算** —— 结算在 billing 那侧。
 *
 * `recoverStaleRuns` 故意把 awaiting_base_review / awaiting_direction_review /
 * awaiting_regeneration_approval 三个暂停态排除在外:那些运行在等人,不是卡死,
 * 重投会把等待中的授权直接顶掉。
 *
 * 依赖方向:support / metrics → 本文件 → codex-pet-worker.ts。不 import billing。
 */

import { getPrisma } from "@ai-assistant/db";
import type { PrismaClient } from "@prisma/client";
import type { S3 } from "../storage/s3.js";
import {
  CODEX_PET_ACTIVE_STATUSES,
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  deleteCodexPetArtifact,
  enqueueCodexPetProjectCleanup,
  enqueueCodexPetRun,
} from "../workflow/codex-pet/index.js";
import { positiveNumber } from "./codex-pet-worker-support.js";
import { codexPetProviderMetricDelta, type WorkerMetrics } from "./codex-pet-worker-metrics.js";

export async function observeProviderArtifacts(input: {
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

export async function refreshDatabaseGauges(prisma: PrismaClient, metrics: WorkerMetrics): Promise<void> {
  const [
    activeRuns,
    archivingRuns,
    readyRunsMissingDeliverables,
    databaseProjects,
    databaseReadyRuns,
    databaseFailedRuns,
    databaseCancelledRuns,
    databaseRefundedRuns,
  ] = await Promise.all([
    prisma.codexPetRun.count({ where: { status: { in: [...CODEX_PET_ACTIVE_STATUSES] } } }),
    prisma.codexPetRun.count({ where: { status: "archiving" } }),
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
  ]);
  metrics.activeRuns = activeRuns;
  metrics.archivingRuns = archivingRuns;
  metrics.readyRunsMissingDeliverables = readyRunsMissingDeliverables;
  metrics.databaseProjects = databaseProjects;
  metrics.databaseReadyRuns = databaseReadyRuns;
  metrics.databaseFailedRuns = databaseFailedRuns;
  metrics.databaseCancelledRuns = databaseCancelledRuns;
  metrics.databaseRefundedRuns = databaseRefundedRuns;
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
