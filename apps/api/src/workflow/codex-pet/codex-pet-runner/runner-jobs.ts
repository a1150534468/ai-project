// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，作业记录与产物读写）。

import { Buffer } from "node:buffer";
import { type CodexPetArtifact, type CodexPetJob, Prisma } from "@prisma/client";
import { checkCancelled, emit } from "./runner-lease.js";
import {
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetCancelledError,
  CodexPetLeaseLostError,
  type RunnerContext,
} from "./runner-types.js";
import { asRecord, providerMetadata } from "./runner-util.js";
import { type ImageGenerationResult } from "../../_shared/image-service.js";

export async function ensureJob(
  ctx: RunnerContext,
  key: string,
  kind: string,
  dependencies: readonly string[] = [],
  input: Record<string, unknown> = {},
  maxAttempts = 3,
): Promise<CodexPetJob> {
  const job = await ctx.prisma.codexPetJob.upsert({
    where: { runId_key: { runId: ctx.runId, key } },
    create: {
      projectId: ctx.project.id,
      runId: ctx.runId,
      userId: ctx.project.userId,
      key,
      kind,
      dependencyKeys: [...dependencies],
      input: input as Prisma.InputJsonValue,
      maxAttempts,
    },
    // A per-image run creates each job with one planned attempt. An explicit
    // paid repair raises the durable job limit for that one job; never lower
    // it again while resuming, or the approved logical attempt becomes
    // unreachable before it reaches the ledger gate.
    update: ctx.perImageBilling ? {} : { maxAttempts },
  });
  // The schema stores denormalized ownership columns for efficient user
  // scoping.  Validate them whenever a job is resumed so a legacy/corrupt row
  // cannot make one user's worker operate on another project's artifacts.
  if (job.runId !== ctx.runId || job.projectId !== ctx.project.id || job.userId !== ctx.project.userId) {
    throw new Error("Codex pet job ownership mismatch");
  }
  return job;
}

export function codexPetMaxBoardAttempts(
  env: NodeJS.ProcessEnv,
  snapshottedMaxAttempts: unknown,
): number {
  const snapshotted = Number(snapshottedMaxAttempts);
  const durableLimit = Number.isSafeInteger(snapshotted) && snapshotted >= 1 && snapshotted <= 3
    ? snapshotted
    : 3;
  const configured = Number(env.CODEX_PET_MAX_BOARD_ATTEMPTS);
  const runtimeLimit = Number.isSafeInteger(configured) && configured >= 1 && configured <= 3
    ? configured
    : 3;
  // Runtime configuration is a safety cap only. It cannot silently grant a
  // resumed run more attempts than its durable continuation contract allows.
  return Math.min(durableLimit, runtimeLimit);
}

export async function startJob(ctx: RunnerContext, job: CodexPetJob, attempt: number, progress: number, message: string): Promise<CodexPetJob> {
  await checkCancelled(ctx);
  const retrying = attempt > 1;
  const updated = await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "running",
    attempt,
    workerId: ctx.workerId,
    startedAt: new Date(),
    completedAt: null,
    error: null,
  } });
  const eventStage = retrying
    ? "repairing"
    : job.kind === "base_candidate"
      ? "base_generating"
      : job.kind.startsWith("look_")
        ? "direction_generating"
        : "standard_generating";
  await emit(ctx, retrying ? "job.retrying" : "job.started", eventStage, progress, message, {
    attempt,
    maxAttempts: job.maxAttempts,
    ...(retrying ? { retryKind: "visual" } : {}),
  }, job.key);
  return updated;
}

export async function failJobAttempt(
  ctx: RunnerContext,
  job: CodexPetJob,
  attempt: number,
  detail: string,
  progress: number,
  terminal = false,
  failureMetadata?: Record<string, unknown>,
): Promise<void> {
  await checkCancelled(ctx);
  const failed = terminal || attempt >= job.maxAttempts;
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: failed ? "failed" : "queued",
    error: detail,
    ...(failureMetadata
      ? { providerMetadata: { failure: failureMetadata } as Prisma.InputJsonValue }
      : {}),
    workerId: null,
    completedAt: failed ? new Date() : null,
  } });
  const terminalFailure = failed && terminal;
  await emit(ctx, failed ? "validation.failed" : "run.repairing", terminalFailure ? "failed" : "repairing", progress, detail, {
    attempt,
    maxAttempts: job.maxAttempts,
    ...(terminalFailure ? { failureKind: "terminal" } : { retryKind: "visual" }),
    ...failureMetadata,
  }, job.key);
}

export async function persistProviderMetadata(ctx: RunnerContext, job: CodexPetJob, result: ImageGenerationResult): Promise<void> {
  // Provider metadata is useful even when deterministic/visual QA rejects the
  // image, so retain it independently of the successful-image billing flag.
  const changed = await ctx.prisma.codexPetJob.updateMany({
    where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId },
    data: { providerMetadata: providerMetadata(result) as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new CodexPetLeaseLostError();
}

/**
 * Mark the first user-visible image after its artifact is durably stored.
 * Base candidates count as successful images for the package cancellation
 * policy: once the run is waiting for base review it is no longer refundable.
 * The conditional update remains important because cancellation can be
 * requested while a provider request or artifact write is in flight. In that
 * case the earlier cancellation wins and the run stays refundable.
 */
export async function markImageSucceeded(ctx: RunnerContext, job: CodexPetJob, result?: ImageGenerationResult): Promise<void> {
  const now = new Date();
  await ctx.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        workerId: ctx.workerId,
        cancelRequested: false,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      },
      data: {
        hasSuccessfulImage: true,
        heartbeatAt: now,
        ...(result ? { actualModels: { push: result.actualModel } } : {}),
      },
    });
    if (changed.count !== 1) {
      const fresh = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId }, select: { cancelRequested: true, status: true, workerId: true } });
      if (!fresh || fresh.cancelRequested || fresh.status === "cancelled") throw new CodexPetCancelledError();
      throw new CodexPetLeaseLostError();
    }
    if (result) {
      const jobChanged = await tx.codexPetJob.updateMany({ where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId }, data: { providerMetadata: providerMetadata(result) as Prisma.InputJsonValue } });
      if (jobChanged.count !== 1) throw new CodexPetLeaseLostError();
    }
  });
}

export async function putJsonArtifact(ctx: RunnerContext, input: { jobId?: string; kind: string; name: string; value: unknown; expiresAt?: Date | null }): Promise<CodexPetArtifact> {
  const actualModels = new Set<string>();
  const routes = new Set<string>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.slice(0, 200).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const provenance = asRecord(row.modelProvenance);
    if (typeof provenance.actualModel === "string") actualModels.add(provenance.actualModel);
    if (Array.isArray(provenance.actualModels)) {
      provenance.actualModels.filter((model): model is string => typeof model === "string").forEach((model) => actualModels.add(model));
    }
    if (typeof provenance.route === "string") routes.add(provenance.route);
    Object.values(row).slice(0, 200).forEach((item) => visit(item, depth + 1));
  };
  if (input.kind === "qa_report") visit(input.value);
  const qaProvenance = input.kind === "qa_report" && ctx.qualityInspectionEnabled
    ? {
        visualQa: {
          requestedModel: ctx.visualQaModel,
          actualModels: [...actualModels],
          routes: [...routes],
        },
      }
    : input.kind === "qa_report"
      ? { visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } }
      : null;
  const value = qaProvenance && input.value && typeof input.value === "object" && !Array.isArray(input.value)
    ? { ...(input.value as Record<string, unknown>), modelProvenance: qaProvenance }
    : input.value;
  return ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: input.jobId,
    kind: input.kind,
    name: input.name,
    buffer: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    mime: "application/json",
    metadata: qaProvenance ?? undefined,
    expiresAt: input.expiresAt,
  });
}

export async function loadArtifactsInOrder(ctx: RunnerContext, ids: readonly string[]): Promise<{ artifacts: CodexPetArtifact[]; buffers: Buffer[] }> {
  const rows = ids.length ? await ctx.prisma.codexPetArtifact.findMany({
    where: {
      id: { in: [...ids] },
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
    },
  }) : [];
  const artifacts = ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is CodexPetArtifact => Boolean(row));
  if (artifacts.length !== ids.length) throw new Error("A completed Codex pet job has missing artifacts");
  return { artifacts, buffers: await Promise.all(artifacts.map((artifact) => ctx.artifacts.load(artifact))) };
}
