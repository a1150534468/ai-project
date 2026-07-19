import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeS3 } from "../storage/s3.js";
import {
  cleanupExpiredCodexPetArtifacts,
  codexPetProviderMetricDelta,
  codexPetRetryMetricDelta,
  codexPetWorkerMetricsText,
  createCodexPetWorkerHealthServer,
  createCodexPetWorkerMetrics,
  recordCodexPetImageFailureMetric,
  recordCodexPetRetryMetrics,
  recordCodexPetUpstreamRequestIdMetric,
  recoverDeletingProjects,
  recoverStaleRuns,
  releasePreemptedRuns,
} from "./codex-pet-worker.js";

describe("Codex pet worker health and Prometheus lifecycle", () => {
  it("serves health/metrics and sanitizes dynamic labels", async () => {
    const metrics = createCodexPetWorkerMetrics();
    metrics.runsCompleted = 3;
    metrics.gptQualityMismatches = 2;
    const stages = new Map([["packaging\"\nunsafe", { seconds: 12.5, transitions: 2 }]]);
    const actions = new Map([["row/idle\"", { completed: 4, failed: 1, retries: 2 }]]);
    const serialized = codexPetWorkerMetricsText(metrics, stages, actions);
    expect(serialized).toContain("codex_pet_worker_runs_completed 3");
    expect(serialized).toContain("codex_pet_worker_gpt_quality_mismatches 2");
    expect(serialized).toContain('stage="packaging__unsafe"');
    expect(serialized).toContain('job_key="row_idle_"');
    expect(serialized).not.toContain("\nunsafe\"");

    let healthy = true;
    const server = createCodexPetWorkerHealthServer({
      port: 0,
      metrics,
      stageDurations: stages,
      actionOutcomes: actions,
      isHealthy: () => healthy,
      listen: false,
    });
    const dispatch = (url: string) => {
      const result = { status: 0, headers: {} as Record<string, string>, body: "" };
      const response = {
        writeHead(status: number, headers: Record<string, string>) {
          result.status = status;
          result.headers = headers;
        },
        end(body: string) { result.body = body; },
      };
      server.emit("request", { url }, response);
      return result;
    };
    const health = dispatch("/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true, worker: "codex-pet" });
    const response = dispatch("/metrics?format=prometheus");
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toContain("text/plain");
    expect(response.body).toContain("codex_pet_worker_runs_completed 3");
    healthy = false;
    expect(dispatch("/health").status).toBe(503);
    server.removeAllListeners();
  });
});

describe("Codex pet provider observability", () => {
  it("counts persisted low-to-auto quality and other provider mismatches", () => {
    expect(codexPetProviderMetricDelta({
      requestedModel: "gpt-image-2",
      actualModel: "gpt-image-2-codex",
      requestedSize: "1536x1024",
      actualSize: "1024x1024",
      requestedQuality: "low",
      actualQuality: "auto",
      upstreamRequestId: "req-worker-123",
      usage: { inputTokens: 21, outputTokens: 34, totalTokens: 55 },
    })).toEqual({
      calls: 1,
      inputTokens: 21,
      outputTokens: 34,
      totalTokens: 55,
      modelMismatches: 1,
      sizeMismatches: 1,
      qualityMismatches: 1,
      requestIdsCaptured: 1,
    });
  });

  it("counts safe request IDs without exposing them as Prometheus labels", () => {
    const metrics = createCodexPetWorkerMetrics();
    expect(recordCodexPetUpstreamRequestIdMetric("req-failure-456", metrics)).toBe("req-failure-456");
    expect(recordCodexPetUpstreamRequestIdMetric("unsafe request id", metrics)).toBeNull();
    const output = codexPetWorkerMetricsText(metrics, new Map(), new Map());
    expect(output).toContain("codex_pet_worker_gpt_request_ids_captured 1");
    expect(output).not.toContain("req-failure-456");
  });

  it("tracks each actionable GPT edits failure class separately", () => {
    const metrics = createCodexPetWorkerMetrics();
    for (const category of [
      "rate_limit",
      "timeout",
      "upstream",
      "network",
      "authentication",
      "moderation",
      "invalid_request",
      "unknown",
    ]) recordCodexPetImageFailureMetric(category, metrics);
    expect(metrics).toMatchObject({
      rateLimitFailures: 1,
      timeoutFailures: 1,
      upstreamFailures: 1,
      networkFailures: 1,
      authenticationFailures: 1,
      moderationFailures: 1,
      invalidRequestFailures: 1,
    });
  });
});

describe("Codex pet retry observability", () => {
  it("counts one visual and action retry from a repair cycle without double-counting its job restart", () => {
    const metrics = createCodexPetWorkerMetrics();
    const visualRepair = recordCodexPetRetryMetrics({
      type: "run.repairing",
      payload: { attempt: 1, maxAttempts: 3 },
    }, metrics);
    const visualRestart = recordCodexPetRetryMetrics({
      type: "job.retrying",
      payload: { retryKind: "visual", attempt: 2, maxAttempts: 3 },
    }, metrics);

    expect(visualRepair.actionRetries + visualRestart.actionRetries).toBe(1);
    expect(metrics).toMatchObject({
      visualRepairAttempts: 1,
      transportRetries: 0,
      rateLimitFailures: 0,
      timeoutFailures: 0,
    });
  });

  it("counts explicit and legacy transport retries with their failure category and action retry", () => {
    const metrics = createCodexPetWorkerMetrics();
    const explicit = recordCodexPetRetryMetrics({
      type: "job.retrying",
      payload: { retryKind: "transport", transportAttempt: 1, category: "rate_limit" },
    }, metrics);
    const legacy = recordCodexPetRetryMetrics({
      type: "job.retrying",
      payload: { transportAttempt: 2, category: "timeout" },
    }, metrics);

    expect(explicit.actionRetries + legacy.actionRetries).toBe(2);
    expect(metrics).toMatchObject({
      visualRepairAttempts: 0,
      transportRetries: 2,
      rateLimitFailures: 1,
      timeoutFailures: 1,
    });
  });

  it("does not treat historical visual attempt metadata as a transport retry", () => {
    expect(codexPetRetryMetricDelta({
      type: "job.retrying",
      payload: { attempt: 2, maxAttempts: 3, category: "upstream" },
    })).toEqual({
      visualRepairAttempts: 0,
      transportRetries: 0,
      actionRetries: 0,
      failureCategory: null,
    });
    expect(codexPetRetryMetricDelta({
      type: "job.retrying",
      payload: { retryKind: "visual", transportAttempt: 2, category: "timeout" },
    })).toEqual({
      visualRepairAttempts: 0,
      transportRetries: 0,
      actionRetries: 0,
      failureCategory: null,
    });
  });
});

describe("Codex pet intermediate artifact expiry", () => {
  it("scans a bounded TTL batch and deletes each object and row with its owner constraint", async () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    const findMany = vi.fn(async () => [
      { id: "expired-1", userId: "user-1" },
      { id: "expired-2", userId: "user-2" },
    ]);
    const deleteArtifact = vi.fn(async ({ artifactId }: { readonly artifactId: string }) => {
      if (artifactId === "expired-2") throw new Error("temporary S3 failure");
      return true;
    });
    const onError = vi.fn();
    const prisma = { codexPetArtifact: { findMany } } as unknown as PrismaClient;

    await expect(cleanupExpiredCodexPetArtifacts({
      prisma,
      now,
      limit: 25,
      deleteArtifact: deleteArtifact as never,
      onError,
    })).resolves.toEqual({ scanned: 2, deleted: 1, failed: 1 });

    expect(findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: "asc" },
      select: { id: true, userId: true },
      take: 25,
    });
    expect(deleteArtifact).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prisma,
      artifactId: "expired-1",
      userId: "user-1",
    }));
    expect(deleteArtifact).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prisma,
      artifactId: "expired-2",
      userId: "user-2",
    }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "temporary S3 failure" }), "expired-2");
  });

  it("uses the production deleter to remove S3 before deleting the expired database row", async () => {
    const row = {
      id: "expired-owned",
      userId: "user-1",
      projectId: "project-1",
      runId: "run-1",
      objectKey: "workflow/codex-pets/user-1/project-1/run-1/expired-owned/frame.png",
    };
    const findMany = vi.fn(async () => [{ id: row.id, userId: row.userId }]);
    const findFirst = vi.fn(async () => row);
    const deleteRow = vi.fn(async () => row);
    const prisma = {
      codexPetArtifact: { findMany, findFirst, delete: deleteRow },
    } as unknown as PrismaClient;
    const s3 = makeS3({
      endpoint: "https://s3.test",
      region: "test",
      bucket: "private-pets",
      accessKey: "access",
      secretKey: "secret",
      forcePathStyle: true,
    });
    const send = vi.fn(async (_command: unknown) => ({}));
    Object.assign(s3.client, { send });

    await expect(cleanupExpiredCodexPetArtifacts({
      prisma,
      s3,
      now: new Date("2026-07-18T00:00:00.000Z"),
    })).resolves.toEqual({ scanned: 1, deleted: 1, failed: 0 });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: row.id, userId: row.userId },
      select: { id: true, objectKey: true, userId: true, projectId: true, runId: true },
    });
    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0]![0] as { constructor: { name: string } }).constructor.name).toBe("DeleteObjectCommand");
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(deleteRow.mock.invocationCallOrder[0]!);
    expect(deleteRow).toHaveBeenCalledWith({ where: { id: row.id } });
  });
});

describe("Codex pet deleting-project recovery", () => {
  it("boundedly re-enqueues projects left in deleting after an API/Redis failure", async () => {
    const projects = [
      { id: "project-old", userId: "user-1" },
      { id: "project-new", userId: "user-2" },
    ];
    const findMany = vi.fn(async (args: Record<string, unknown>) => {
      expect(args).toEqual({
        where: { status: "deleting" },
        orderBy: { updatedAt: "asc" },
        select: { id: true, userId: true },
        take: 2,
      });
      return projects;
    });
    const enqueue = vi.fn(async (_payload: { readonly userId: string; readonly projectId: string }) => undefined);

    await expect(recoverDeletingProjects({
      prisma: { codexPetProject: { findMany } } as unknown as PrismaClient,
      enqueue,
      env: { CODEX_PET_CLEANUP_RECOVERY_LIMIT: "2" },
    })).resolves.toEqual({ scanned: 2, enqueued: 2, failed: 0 });
    expect(enqueue).toHaveBeenNthCalledWith(1, { userId: "user-1", projectId: "project-old" });
    expect(enqueue).toHaveBeenNthCalledWith(2, { userId: "user-2", projectId: "project-new" });
  });

  it("continues the deleting-project scan when one queue add is unavailable", async () => {
    const queueError = new Error("Redis unavailable");
    const onEnqueueError = vi.fn();
    const enqueue = vi.fn(async ({ projectId }: { readonly projectId: string }) => {
      if (projectId === "project-1") throw queueError;
    });
    const prisma = {
      codexPetProject: {
        findMany: vi.fn(async () => [
          { id: "project-1", userId: "user-1" },
          { id: "project-2", userId: "user-1" },
        ]),
      },
    } as unknown as PrismaClient;

    await expect(recoverDeletingProjects({ prisma, enqueue, onEnqueueError }))
      .resolves.toEqual({ scanned: 2, enqueued: 1, failed: 1 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(onEnqueueError).toHaveBeenCalledWith(queueError, "project-1");
  });
});

describe("Codex pet stale-run recovery", () => {
  it("requeues a stale cancelled lease while leaving a fresh cancelled lease alone", async () => {
    const now = new Date("2026-07-18T00:00:10.000Z");
    const rows = [
      {
        id: "cancel-stale",
        status: "standard_generating",
        cancelRequested: true,
        heartbeatAt: new Date("2026-07-17T23:59:00.000Z"),
      },
      {
        id: "cancel-fresh",
        status: "standard_generating",
        cancelRequested: true,
        heartbeatAt: new Date("2026-07-18T00:00:09.500Z"),
      },
    ];
    const findMany = vi.fn(async ({ where }: { readonly where: Record<string, unknown> }) => {
      // The recovery query must not retain the old cancelRequested=false
      // exclusion; the database predicate below models its stale heartbeat
      // OR and keeps a live cancelled worker protected by its lease.
      expect(where.cancelRequested).toBeUndefined();
      const or = where.OR as readonly Record<string, unknown>[];
      expect(or).toEqual(expect.arrayContaining([
        { heartbeatAt: null },
        { heartbeatAt: { lt: new Date("2026-07-18T00:00:09.000Z") } },
        { status: "queued" },
      ]));
      return rows.filter((row) => row.heartbeatAt === null || row.heartbeatAt < new Date("2026-07-18T00:00:09.000Z") || row.status === "queued");
    });
    const enqueue = vi.fn(async (_runId: string) => undefined);

    await expect(recoverStaleRuns({
      prisma: { codexPetRun: { findMany } } as unknown as PrismaClient,
      enqueue,
      now: () => now,
      env: { CODEX_PET_STALE_RUN_MS: "1000" },
    })).resolves.toBe(1);
    expect(enqueue).toHaveBeenCalledWith("cancel-stale");
    expect(enqueue).not.toHaveBeenCalledWith("cancel-fresh");
  });

  it("releases and immediately requeues only leases still owned during graceful shutdown", async () => {
    const updateMany = vi.fn(async ({ where, data }: {
      readonly where: { readonly id: string; readonly workerId: string; readonly status: unknown };
      readonly data: Record<string, unknown>;
    }) => {
      expect(where.status).toEqual({ in: expect.arrayContaining(["standard_generating", "archiving"]) });
      expect(data).toEqual({ workerId: null, heartbeatAt: null });
      return { count: where.id === "run-active" && where.workerId === "lease-active" ? 1 : 0 };
    });
    const enqueue = vi.fn(async (_runId: string) => undefined);

    await expect(releasePreemptedRuns({
      prisma: { codexPetRun: { updateMany } } as unknown as PrismaClient,
      deliveries: [
        { runId: "run-active", workerLeaseId: "lease-active" },
        { runId: "run-finished", workerLeaseId: "lease-old" },
      ],
      enqueue,
    })).resolves.toBe(1);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("run-active");
  });

  it("leaves a released lease recoverable when graceful Redis requeue fails", async () => {
    const onEnqueueError = vi.fn();
    const enqueueError = new Error("Redis unavailable");
    const prisma = {
      codexPetRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    } as unknown as PrismaClient;

    await expect(releasePreemptedRuns({
      prisma,
      deliveries: [{ runId: "run-active", workerLeaseId: "lease-active" }],
      enqueue: vi.fn(async () => { throw enqueueError; }),
      onEnqueueError,
    })).resolves.toBe(1);

    expect(onEnqueueError).toHaveBeenCalledWith(enqueueError, "run-active");
  });
});
