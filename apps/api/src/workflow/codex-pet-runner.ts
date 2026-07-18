import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type CodexPetArtifact, type CodexPetJob, type CodexPetProject, type CodexPetRun, type ImageAsset, type PrismaClient } from "@prisma/client";
import {
  LOOK_DIRECTIONS,
  PET_ROW_SPECS,
  assemblePetAtlas,
  assembleStandardPetAtlas,
  composeCardinalAnchorStrip,
  chooseChromaKey,
  createAnimatedWebpPreview,
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  createLayoutGuide,
  createStandardAtlasContactSheet,
  despillChromaEdges,
  extractFullPoseBoardsWithSharedRegistration,
  extractPoseBoard,
  inspectCodexPetZip,
  measureDirectionContinuity,
  measureDirectionRowContinuity,
  mirrorFramesPreservingOrder,
  petRowSpec,
  validatePetAtlas,
  validateStandardPetAtlas,
  type PetFramesByState,
  type PetRowSpec,
} from "@ai-assistant/codex-pet-pipeline";
import {
  classifyImageGenerationError,
  type ImageBinaryInput,
  type ImageGenerationResult,
} from "./image-service.js";
import { sanitizeCodexPetDiagnosticText } from "./codex-pet-events.js";
import {
  buildBasePetPrompt,
  buildCardinalPrompt,
  buildLookMechanicsPrompt,
  buildLookRowPrompt,
  buildStandardRowPrompt,
  buildVisualQaPrompt,
  type CodexPetVisualIdentity,
} from "./codex-pet-prompts.js";
import {
  generateCodexPetLookMechanics,
  generateCodexPetVisual,
  runBlindDirectionQa,
  runCodexPetVisualQa,
  runCodexPetVisualQaConsensus,
  runLabeledDirectionSemantics,
  type BlindDirectionValidation,
  type DirectionSemanticVerdict,
  type GeneratedPetVisual,
  type PetVisualQaConsensus,
  type PetVisualQaVerdict,
} from "./codex-pet-visual.js";

export const CODEX_PET_ACTIVE_STATUSES = [
  "queued", "base_generating", "awaiting_base_review", "standard_generating", "direction_generating",
  "validating", "repairing", "packaging", "archiving",
] as const;

export const CODEX_PET_RESOURCE_KEY = "codex_pet_v2_package";
const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60_000;
const WORKER_ID = `codex-pet-${process.pid}-${randomUUID().slice(0, 8)}`;
const DEFAULT_STALE_RUN_MS = 15 * 60_000;

/**
 * The queue is at-least-once. A stale delivery must not be allowed to keep
 * writing a run after another worker has taken its lease. This error is
 * intentionally separate from cancellation: callers should leave the
 * database state alone and let the current lease holder finish the run.
 */
export class CodexPetLeaseLostError extends Error {
  constructor() {
    super("Codex pet run lease is no longer owned by this worker");
    this.name = "CodexPetLeaseLostError";
  }
}

export type CodexPetExecutionStatus = "awaiting_base_review" | "archiving" | "ready" | "failed" | "cancelled" | "busy";
export interface CodexPetExecutionResult {
  readonly status: CodexPetExecutionStatus;
  readonly runId: string;
}

export interface CodexPetArtifactPutInput {
  readonly userId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly jobId?: string | null;
  readonly kind: string;
  readonly name: string;
  readonly buffer: Buffer;
  readonly mime: string;
  readonly metadata?: Record<string, unknown>;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly expiresAt?: Date | null;
}

export interface CodexPetArtifactStore {
  put(input: CodexPetArtifactPutInput): Promise<CodexPetArtifact>;
  load(artifact: Pick<CodexPetArtifact, "objectKey">): Promise<Buffer>;
}

export interface CodexPetEventInput {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly type: string;
  readonly stage: string;
  readonly jobKey?: string | null;
  readonly message?: string | null;
  readonly progress?: number;
  readonly payload?: Record<string, unknown>;
}

export interface CodexPetRunnerDeps {
  readonly prisma: PrismaClient;
  readonly artifacts: CodexPetArtifactStore;
  readonly appendEvent: (input: CodexPetEventInput) => Promise<unknown>;
  readonly loadReferenceAsset: (asset: ImageAsset) => Promise<{ buffer: Buffer; mime: string }>;
  readonly archiveRun: (input: {
    prisma: PrismaClient;
    runId: string;
    userId: string;
    projectId: string;
  }) => Promise<{ documentId: string }>;
  readonly billing: { refundResource(operationId: string): Promise<{ success: boolean }> };
  readonly visual?: {
    generate?: typeof generateCodexPetVisual;
    qa?: typeof runCodexPetVisualQa;
    qaConsensus?: typeof runCodexPetVisualQaConsensus;
    blindQa?: typeof runBlindDirectionQa;
    directionSemantics?: typeof runLabeledDirectionSemantics;
    lookMechanics?: typeof generateCodexPetLookMechanics;
  };
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly workerId?: string;
}

interface RunnerContext extends CodexPetRunnerDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly workerId: string;
  readonly project: CodexPetProject;
  readonly runId: string;
  readonly identity: CodexPetVisualIdentity;
  readonly referenceAssetIds: readonly string[];
  readonly userReferences: readonly ImageBinaryInput[];
  readonly generate: typeof generateCodexPetVisual;
  readonly qa: typeof runCodexPetVisualQa;
  readonly qaConsensus: typeof runCodexPetVisualQaConsensus;
  readonly blindQa: typeof runBlindDirectionQa;
  readonly directionSemantics: typeof runLabeledDirectionSemantics;
  readonly lookMechanics: typeof generateCodexPetLookMechanics;
}

interface BoardJobResult {
  readonly job: CodexPetJob;
  readonly frames: readonly Buffer[];
  readonly frameArtifacts: readonly CodexPetArtifact[];
  readonly board: Buffer;
  readonly boardArtifact: CodexPetArtifact;
  readonly mirrorSafe: boolean;
  readonly qa: PetVisualQaConsensus;
}

class CodexPetCancelledError extends Error {
  constructor() {
    super("用户已取消桌宠制作");
    this.name = "CodexPetCancelledError";
  }
}

class CodexPetArchiveDeferredError extends Error {
  constructor(
    message: string,
    readonly attempt: number,
    readonly maxAttempts: number,
  ) {
    super(message);
    this.name = "CodexPetArchiveDeferredError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeError(error: unknown): string {
  const classification = classifyImageGenerationError(error);
  if (classification.category === "moderation") {
    return "参考图或角色描述未通过内容安全审核，请修改提示词或更换参考图后复制为新项目重试";
  }
  if (classification.category === "invalid_request") {
    return "图片服务无法接受当前参数或参考图，请检查图片格式与角色描述后复制为新项目重试";
  }
  if (classification.category === "authentication") {
    return "图片生成服务配置异常，本次制作已停止并将按系统失败退款";
  }
  if (["rate_limit", "timeout", "upstream", "network"].includes(classification.category)) {
    return "图片生成服务暂时不可用，自动重试仍未成功，本次制作将按系统失败退款";
  }
  return sanitizeCodexPetDiagnosticText(
    error instanceof Error && error.message ? error.message : "桌宠制作失败",
    1_000,
  );
}

function configuredVisualConcurrency(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_VISUAL_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? Math.min(3, value) : 3;
}

function configuredArchiveMaxAttempts(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_ARCHIVE_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? Math.min(100, value) : 10;
}

const FINAL_REPAIR_ROWS = [
  "idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review", "look-a", "look-b",
] as const;
type FinalRepairRow = (typeof FINAL_REPAIR_ROWS)[number];

/** Normalize model-provided repairRows and retain a conservative fallback for
 * providers upgraded before the structured field was introduced. */
function repairRowsFromFinalQa(verdict: PetVisualQaVerdict): FinalRepairRow[] {
  const source = [
    ...(verdict.repairRows ?? []),
    ...verdict.failures,
    verdict.repairPrompt,
  ].join(" ").toLowerCase();
  const explicit = new Set((verdict.repairRows ?? []).map((candidate) => candidate.trim().toLowerCase().replace(/^row[-_]/, "").replaceAll("_", "-")));
  const rows = FINAL_REPAIR_ROWS.filter((row) =>
    explicit.has(row)
    || source.includes(row),
  );
  if (rows.length > 0) return [...rows];
  // A final verdict without structured scope is still actionable: regenerate
  // every complete action group once, never attempt a single-frame patch.
  return [...FINAL_REPAIR_ROWS];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

function providerMetadata(result: ImageGenerationResult): Record<string, unknown> {
  return {
    upstreamRequestId: result.upstreamRequestId,
    requestedModel: result.requestedModel,
    actualModel: result.actualModel,
    requestedSize: result.requestedSize,
    actualSize: result.actualSize,
    requestedQuality: result.requestedQuality,
    actualQuality: result.actualQuality,
    usage: result.usage,
  };
}

function imageFailureMetadata(error: unknown): Record<string, unknown> {
  const classification = classifyImageGenerationError(error);
  return {
    category: classification.category,
    ...(classification.upstreamRequestId
      ? { upstreamRequestId: classification.upstreamRequestId }
      : {}),
  };
}

async function emit(ctx: RunnerContext, type: string, stage: string, progress: number, message: string, payload: Record<string, unknown> = {}, jobKey?: string): Promise<void> {
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

async function currentRun(ctx: RunnerContext): Promise<CodexPetRun> {
  const run = await ctx.prisma.codexPetRun.findFirst({
    where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
  });
  if (!run) throw new Error("Codex pet run no longer exists");
  return run;
}

function staleRunMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_STALE_RUN_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_RUN_MS;
}

type RunnerRunWithProject = CodexPetRun & { project: CodexPetProject };

/**
 * Atomically claim a run lease.  `workerId` is deliberately part of the
 * compare-and-set predicate: two queue deliveries can both observe a queued
 * row, but only one may transition it to an owned row.  A heartbeat older
 * than the stale threshold is the only way a second worker can take over.
 */
async function claimRunLease(
  prisma: PrismaClient,
  runId: string,
  workerId: string,
  env: NodeJS.ProcessEnv,
  expectedProjectId?: string,
  expectedUserId?: string,
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
        billingChargeStatus: "charged",
        billingActivatedAt: { not: null },
        OR: [
          { workerId: null },
          { heartbeatAt: null },
          { heartbeatAt: { lt: staleBefore } },
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

async function checkCancelled(ctx: RunnerContext): Promise<void> {
  if (ctx.signal?.aborted) {
    if (ctx.signal.reason instanceof CodexPetLeaseLostError) throw new CodexPetLeaseLostError();
    throw new CodexPetCancelledError();
  }
  const run = await ctx.prisma.codexPetRun.findFirst({
    where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
    select: { cancelRequested: true, status: true, workerId: true },
  });
  if (!run || run.cancelRequested || run.status === "cancelled") throw new CodexPetCancelledError();
  if ((CODEX_PET_ACTIVE_STATUSES as readonly string[]).includes(run.status) && run.workerId !== ctx.workerId) {
    throw new CodexPetLeaseLostError();
  }
}

async function stage(ctx: RunnerContext, status: string, progress: number, message: string): Promise<void> {
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
    const changed = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, workerId: ctx.workerId, status: { in: [...CODEX_PET_ACTIVE_STATUSES] }, cancelRequested: false },
      data: advanced
        ? {
            status,
            progressStage: status,
            progressPercent: targetProgress,
            progressMessage: message,
            heartbeatAt: now,
            error: null,
          }
        : { heartbeatAt: now, error: null },
    });
    if (changed.count !== 1) return { claimed: false, advanced: false } as const;
    if (advanced) {
      await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status } });
    }
    return { claimed: true, advanced } as const;
  });
  if (!transition.claimed) throw new CodexPetLeaseLostError();
  if (transition.advanced) await emit(ctx, "stage.started", status, progress, message);
}

async function ensureJob(
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
    update: { maxAttempts },
  });
  // The schema stores denormalized ownership columns for efficient user
  // scoping.  Validate them whenever a job is resumed so a legacy/corrupt row
  // cannot make one user's worker operate on another project's artifacts.
  if (job.runId !== ctx.runId || job.projectId !== ctx.project.id || job.userId !== ctx.project.userId) {
    throw new Error("Codex pet job ownership mismatch");
  }
  return job;
}

async function startJob(ctx: RunnerContext, job: CodexPetJob, attempt: number, progress: number, message: string): Promise<CodexPetJob> {
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
  await emit(ctx, retrying ? "job.retrying" : "job.started", eventStage, progress, message, { attempt, maxAttempts: job.maxAttempts }, job.key);
  return updated;
}

async function failJobAttempt(ctx: RunnerContext, job: CodexPetJob, attempt: number, detail: string, progress: number, terminal = false): Promise<void> {
  await checkCancelled(ctx);
  const failed = terminal || attempt >= job.maxAttempts;
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: { status: failed ? "failed" : "queued", error: detail, workerId: null } });
  await emit(ctx, failed ? "validation.failed" : "run.repairing", "repairing", progress, detail, { attempt, maxAttempts: job.maxAttempts }, job.key);
}

async function persistProviderMetadata(ctx: RunnerContext, job: CodexPetJob, result: ImageGenerationResult): Promise<void> {
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
async function markImageSucceeded(ctx: RunnerContext, job: CodexPetJob, result?: ImageGenerationResult): Promise<void> {
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

async function putJsonArtifact(ctx: RunnerContext, input: { jobId?: string; kind: string; name: string; value: unknown; expiresAt?: Date | null }): Promise<CodexPetArtifact> {
  return ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: input.jobId,
    kind: input.kind,
    name: input.name,
    buffer: Buffer.from(`${JSON.stringify(input.value, null, 2)}\n`),
    mime: "application/json",
    expiresAt: input.expiresAt,
  });
}

async function loadArtifactsInOrder(ctx: RunnerContext, ids: readonly string[]): Promise<{ artifacts: CodexPetArtifact[]; buffers: Buffer[] }> {
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

async function generateBaseCandidate(ctx: RunnerContext, candidateIndex: number): Promise<{ artifact: CodexPetArtifact; buffer: Buffer }> {
  const key = `base-candidate-${candidateIndex}`;
  let job = await ensureJob(ctx, key, "base_candidate", [], { candidateIndex, referenceAssetIds: ctx.referenceAssetIds });
  if (job.status === "completed" && job.outputArtifactIds.length === 1) {
    const loaded = await loadArtifactsInOrder(ctx, job.outputArtifactIds);
    return { artifact: loaded.artifacts[0]!, buffer: loaded.buffers[0]! };
  }
  const attempt = Math.max(1, job.attempt + 1);
  job = await startJob(ctx, job, attempt, 6 + candidateIndex * 2, `生成主形象候选 ${candidateIndex}`);
  try {
    const generated = await ctx.generate({
      prompt: buildBasePetPrompt(ctx.identity, candidateIndex),
      references: ctx.userReferences,
      size: "1024x1024",
      quality: "low",
      env: ctx.env,
      signal: ctx.signal,
      onRetry: async (error, transportAttempt) => emit(ctx, "job.retrying", "base_generating", 8, "生图服务暂时不可用，正在重试", {
        transportAttempt,
        ...imageFailureMetadata(error),
      }, key),
    });
    const artifact = await ctx.artifacts.put({
      userId: ctx.project.userId,
      projectId: ctx.project.id,
      runId: ctx.runId,
      jobId: job.id,
      kind: "base_candidate",
      name: `主形象候选 ${candidateIndex}`,
      buffer: generated.buffer,
      mime: generated.mime,
      metadata: providerMetadata(generated.provider),
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    // A stored base candidate is already a successful, user-visible image.
    // Persist this before releasing the run into awaiting_base_review so a
    // cancellation from that state follows the documented no-refund branch.
    await markImageSucceeded(ctx, job, generated.provider);
    job = await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: { status: "completed", outputArtifactIds: [artifact.id], completedAt: new Date(), workerId: null } });
    await emit(ctx, "preview.ready", "base_generating", 10, `主形象候选 ${candidateIndex} 已生成`, { artifactId: artifact.id }, key);
    await emit(ctx, "job.completed", "base_generating", 10, `主形象候选 ${candidateIndex} 已完成`, { artifactId: artifact.id }, key);
    return { artifact, buffer: generated.buffer };
  } catch (error) {
    await failJobAttempt(ctx, job, attempt, safeError(error), 10);
    throw error;
  }
}

async function selectBaseAutomatically(ctx: RunnerContext, candidates: readonly { artifact: CodexPetArtifact; buffer: Buffer }[]): Promise<string> {
  const job = await ensureJob(ctx, "base-selection", "visual_qa", ["base-candidate-1", "base-candidate-2"]);
  const output = asRecord(job.output);
  if (job.status === "completed" && typeof output.selectedArtifactId === "string") return output.selectedArtifactId;
  const verdicts = await Promise.all(candidates.map((candidate, index) => ctx.qa({
    images: [{ buffer: candidate.buffer, mime: candidate.artifact.mime }],
    prompt: buildVisualQaPrompt("base-choice", `Candidate ${index + 1}; choose by identity consistency, pet-size readability and clean whole-body silhouette.`),
    env: ctx.env,
    signal: ctx.signal,
  })));
  await checkCancelled(ctx);
  // Never silently pick a visually rejected candidate.  Continuing with the
  // highest numeric score would produce a run whose canonical identity was
  // explicitly rejected by every reviewer.  The caller treats this as a
  // terminal workflow error (and therefore refunds the package).
  if (verdicts.length === 0 || verdicts.every((verdict) => !verdict.pass)) {
    const qaArtifact = await putJsonArtifact(ctx, {
      jobId: job.id,
      kind: "qa_report",
      name: "主形象自动选择失败报告",
      value: { selectedArtifactId: null, verdicts, reason: "all_candidates_failed" },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "failed",
      attempt: Math.max(1, job.attempt + 1),
      output: { selectedArtifactId: null, qaArtifactId: qaArtifact.id, reason: "all_candidates_failed" } as Prisma.InputJsonValue,
      outputArtifactIds: [qaArtifact.id],
      error: "两个主形象候选均未通过视觉质检",
      completedAt: new Date(),
      workerId: null,
    } });
    throw new Error("两个主形象候选均未通过视觉质检");
  }
  const selectedIndex = verdicts.reduce((best, verdict, index) => {
    const bestVerdict = verdicts[best]!;
    const score = (verdict.pass ? 1000 : 0) + verdict.score;
    const bestScore = (bestVerdict.pass ? 1000 : 0) + bestVerdict.score;
    return score > bestScore ? index : best;
  }, 0);
  const selectedArtifactId = candidates[selectedIndex]!.artifact.id;
  const qaArtifact = await putJsonArtifact(ctx, { jobId: job.id, kind: "qa_report", name: "主形象自动选择报告", value: { selectedArtifactId, verdicts } });
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { selectedArtifactId, qaArtifactId: qaArtifact.id } as Prisma.InputJsonValue,
    outputArtifactIds: [qaArtifact.id],
    completedAt: new Date(),
  } });
  return selectedArtifactId;
}

async function completedBoardJob(ctx: RunnerContext, job: CodexPetJob): Promise<BoardJobResult | null> {
  if (job.status !== "completed" || job.outputArtifactIds.length === 0) return null;
  const output = asRecord(job.output);
  if (typeof output.boardArtifactId !== "string") return null;
  const loadedFrames = await loadArtifactsInOrder(ctx, job.outputArtifactIds);
  const boardArtifact = await ctx.prisma.codexPetArtifact.findFirst({
    where: {
      id: output.boardArtifactId,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
    },
  });
  if (!boardArtifact) return null;
  const qaRaw = asRecord(output.qa);
  return {
    job,
    frames: loadedFrames.buffers,
    frameArtifacts: loadedFrames.artifacts,
    board: await ctx.artifacts.load(boardArtifact),
    boardArtifact,
    mirrorSafe: output.mirrorSafe === true,
    qa: {
      pass: true,
      score: typeof qaRaw.score === "number" ? qaRaw.score : 100,
      mirrorSafe: output.mirrorSafe === true,
      verdicts: [],
      warnings: Array.isArray(qaRaw.warnings) ? qaRaw.warnings.filter((item): item is string => typeof item === "string") : [],
      failures: [],
    },
  };
}

/** Build a deterministic reference from the four QA-approved cardinal cells.
 * The original 2×2 model board remains provenance; direction generation uses
 * this extracted strip so labels/layout noise can never become part of the
 * visual reference. */
async function createApprovedCardinalAnchor(ctx: RunnerContext, cardinals: BoardJobResult, force = false): Promise<{ artifact: CodexPetArtifact; buffer: Buffer }> {
  const job = await ensureJob(ctx, "cardinal-anchor-strip", "deterministic_assembly", ["look-cardinals"], {
    directions: ["000", "090", "180", "270"],
    sourceBoardArtifactId: cardinals.boardArtifact.id,
  });
  const output = asRecord(job.output);
  if (!force && job.status === "completed" && typeof output.artifactId === "string") {
    const artifact = await ctx.prisma.codexPetArtifact.findFirst({
      where: {
        id: output.artifactId,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
    });
    if (artifact) return { artifact, buffer: await ctx.artifacts.load(artifact) };
  }
  const buffer = await composeCardinalAnchorStrip(cardinals.frames);
  const artifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "cardinal_anchor_strip",
    name: "已批准四方向锚点参考",
    buffer,
    mime: "image/png",
    metadata: {
      directions: ["000", "090", "180", "270"],
      sourceBoardArtifactId: cardinals.boardArtifact.id,
      sourceFrameArtifactIds: cardinals.frameArtifacts.map((item) => item.id),
      cardinalEvidence: cardinals.frameArtifacts.map((item, index) => ({
        direction: (["000", "090", "180", "270"] as const)[index],
        frameArtifactId: item.id,
        extractionDiagnostics: asRecord(item.metadata).diagnostics,
        semanticQa: {
          score: cardinals.qa.score,
          pass: cardinals.qa.pass,
          warnings: cardinals.qa.warnings,
          failures: cardinals.qa.failures,
        },
      })),
      approved: true,
      width: 384,
      height: 416,
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    inputArtifactIds: [cardinals.boardArtifact.id, ...cardinals.frameArtifacts.map((item) => item.id)],
    outputArtifactIds: [artifact.id],
    output: { artifactId: artifact.id, sourceBoardArtifactId: cardinals.boardArtifact.id } as Prisma.InputJsonValue,
    attempt: Math.max(1, job.attempt),
    completedAt: new Date(),
    workerId: null,
  } });
  await emit(ctx, "preview.ready", "direction_generating", 70, "四个批准方向锚点参考已生成", { artifactId: artifact.id }, job.key);
  return { artifact, buffer };
}

async function runBoardJob(ctx: RunnerContext, input: {
  readonly key: string;
  readonly kind: string;
  readonly dependencies: readonly string[];
  readonly inputArtifactIds: readonly string[];
  readonly prompt: string;
  readonly references: readonly ImageBinaryInput[];
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
  readonly progress: number;
  readonly qaKind: "row" | "cardinals" | "directions";
  readonly qaContext: string;
  readonly qaRepetitions?: number;
  readonly animationDurations?: readonly number[];
  readonly force?: boolean;
  readonly repairHint?: string;
}): Promise<BoardJobResult> {
  let job = await ensureJob(ctx, input.key, input.kind, input.dependencies, { columns: input.columns, rows: input.rows, frameCount: input.frameCount });
  const previousOutput = asRecord(job.output);
  const supersededArtifactIds = input.force
    ? [...new Set([
        ...job.outputArtifactIds,
        typeof previousOutput.boardArtifactId === "string" ? previousOutput.boardArtifactId : "",
        typeof previousOutput.animationPreviewArtifactId === "string" ? previousOutput.animationPreviewArtifactId : "",
      ].filter(Boolean))]
    : [];
  if (!input.force) {
    const completed = await completedBoardJob(ctx, job);
    if (completed) {
      // A process may have crashed after persisting a passed job but before
      // the billing-success marker in an older deployment. Reconcile that
      // durable passed result when resuming, without treating a merely
      // generated/failed board as a success.
      const run = await currentRun(ctx);
      if (!run.hasSuccessfulImage) await markImageSucceeded(ctx, completed.job);
      return completed;
    }
  }
  let repairPrompt = input.repairHint ?? "";
  let lastError = "";
  for (let attempt = Math.max(1, job.attempt + 1); attempt <= job.maxAttempts; attempt += 1) {
    await checkCancelled(ctx);
    job = await startJob(ctx, job, attempt, input.progress, `${input.qaContext}${attempt > 1 ? `（自动修复 ${attempt - 1}/2）` : ""}`);
    try {
      const generated = await ctx.generate({
        prompt: `${input.prompt}${repairPrompt ? `\n\nRepair the complete pose group: ${repairPrompt}` : ""}`,
        references: input.references,
        size: "1536x1024",
        quality: "low",
        env: ctx.env,
        signal: ctx.signal,
        onRetry: async (error, transportAttempt) => emit(ctx, "job.retrying", "repairing", input.progress, "上游生图调用重试中", {
          transportAttempt,
          ...imageFailureMetadata(error),
        }, input.key),
      });
      const boardArtifact = await ctx.artifacts.put({
        userId: ctx.project.userId,
        projectId: ctx.project.id,
        runId: ctx.runId,
        jobId: job.id,
        kind: "pose_board",
        name: `${input.qaContext}姿势板 · 第 ${attempt} 次`,
        buffer: generated.buffer,
        mime: generated.mime,
        metadata: { ...providerMetadata(generated.provider), attempt, jobKey: input.key },
        expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
      });
      await persistProviderMetadata(ctx, job, generated.provider);
      const extracted = await extractPoseBoard(generated.buffer, {
        columns: input.columns,
        rows: input.rows,
        frameCount: input.frameCount,
        chromaKey: ctx.identity.chromaKey,
        requireUnusedSlotsEmpty: true,
        allowVerticalTravel: input.key === "row-jumping",
      });
      let qa: PetVisualQaConsensus = { pass: false, verdicts: [], score: 0, mirrorSafe: false, warnings: extracted.warnings, failures: extracted.errors };
      if (extracted.ok) {
        const visualQa = await ctx.qaConsensus({
          images: [
            { buffer: input.references[0] ? Buffer.from(input.references[0].b64, "base64") : generated.buffer, mime: input.references[0]?.mime },
            { buffer: generated.buffer, mime: generated.mime },
          ],
          prompt: buildVisualQaPrompt(
            input.qaKind,
            `${input.qaContext}${extracted.geometry.warnings.length > 0
              ? `。确定性尺寸/基线指标需要复核：${extracted.geometry.warnings.join("；")}`
              : ""}`,
          ),
          env: ctx.env,
          signal: ctx.signal,
          repetitions: input.qaRepetitions ?? 1,
        });
        qa = {
          ...visualQa,
          warnings: [...new Set([...extracted.warnings, ...visualQa.warnings])],
        };
      }
      if (!extracted.ok || !qa.pass) {
        lastError = [...extracted.errors, ...qa.failures].join("；") || "视觉质量检查未通过";
        repairPrompt = qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt || lastError;
        await putJsonArtifact(ctx, {
          jobId: job.id,
          kind: "qa_report",
          name: `${input.qaContext}失败诊断 · 第 ${attempt} 次`,
          value: { deterministic: extracted, visual: qa },
          expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
        });
        await failJobAttempt(ctx, job, attempt, lastError, input.progress);
        if (attempt >= job.maxAttempts) throw new Error(`${input.qaContext}经两轮自动修复后仍未通过：${lastError}`);
        continue;
      }
      // Only now has this image passed both deterministic extraction and the
      // visual action/identity gate.  A generated-but-rejected board must not
      // affect the cancellation refund decision.
      await markImageSucceeded(ctx, job, generated.provider);
      const frameArtifacts: CodexPetArtifact[] = [];
      for (let index = 0; index < extracted.frames.length; index += 1) {
        frameArtifacts.push(await ctx.artifacts.put({
          userId: ctx.project.userId,
          projectId: ctx.project.id,
          runId: ctx.runId,
          jobId: job.id,
          kind: "frame",
          name: `${input.key} · frame ${String(index).padStart(2, "0")}`,
          buffer: extracted.frames[index]!,
          mime: "image/png",
          metadata: { jobKey: input.key, index, diagnostics: extracted.diagnostics[index] },
          expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
        }));
      }
      const animationDurations = input.animationDurations;
      const animationPreviewArtifact = animationDurations
        ? await (async () => {
            const preview = await createAnimatedWebpPreview(extracted.frames, animationDurations);
            return ctx.artifacts.put({
              userId: ctx.project.userId,
              projectId: ctx.project.id,
              runId: ctx.runId,
              jobId: job.id,
              kind: "animation_preview",
              name: `${input.key} · 动画预览.webp`,
              buffer: preview.image,
              mime: preview.mime,
              metadata: { jobKey: input.key, frameCount: preview.frameCount, durations: preview.durations, loop: preview.loop },
              // Animated previews are user-facing finished-state previews
              // shown from the completed workbench. Keep them with the final
              // deliverables; raw boards/frames and failed QA reports still
              // use the seven-day intermediate TTL.
              expiresAt: null,
            });
          })()
        : null;
      if (supersededArtifactIds.length > 0) {
        await ctx.prisma.codexPetArtifact.updateMany({
          where: {
            id: { in: supersededArtifactIds },
            runId: ctx.runId,
            projectId: ctx.project.id,
            userId: ctx.project.userId,
          },
          data: {
            status: "superseded",
            expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
          },
        });
      }
      job = await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
        status: "completed",
        inputArtifactIds: [...input.inputArtifactIds],
        outputArtifactIds: frameArtifacts.map((artifact) => artifact.id),
        output: {
          boardArtifactId: boardArtifact.id,
          animationPreviewArtifactId: animationPreviewArtifact?.id ?? null,
          mirrorSafe: qa.mirrorSafe,
          qa: { score: qa.score, warnings: qa.warnings },
          deterministic: {
            geometry: extracted.geometry,
            chromaCoverage: extracted.diagnostics.map((diagnostic) => diagnostic.chromaCoverage),
          },
        } as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
        workerId: null,
        error: null,
      } });
      const eventStage = input.qaKind === "directions" || input.qaKind === "cardinals" ? "direction_generating" : "standard_generating";
      await emit(ctx, "preview.ready", eventStage, input.progress, `${input.qaContext}预览已就绪`, {
        artifactId: boardArtifact.id,
        animationPreviewArtifactId: animationPreviewArtifact?.id ?? null,
        frameArtifactIds: frameArtifacts.map((artifact) => artifact.id),
      }, input.key);
      await emit(ctx, "job.completed", eventStage, input.progress, `${input.qaContext}已通过检查`, { attempt, warnings: qa.warnings }, input.key);
      return { job, frames: extracted.frames, frameArtifacts, board: generated.buffer, boardArtifact, mirrorSafe: qa.mirrorSafe, qa };
    } catch (error) {
      if (error instanceof CodexPetLeaseLostError || ctx.signal?.reason instanceof CodexPetLeaseLostError) throw new CodexPetLeaseLostError();
      if (error instanceof CodexPetCancelledError || ctx.signal?.aborted) throw new CodexPetCancelledError();
      lastError = safeError(error);
      const latest = await ctx.prisma.codexPetJob.findUnique({ where: { id: job.id } });
      if (latest?.status !== "failed") await failJobAttempt(ctx, job, attempt, lastError, input.progress, true);
      // Transport retries are already bounded inside generateCodexPetVisual.
      // Infrastructure, moderation and invalid-parameter failures must not be
      // multiplied by the complete-action-group visual repair loop.
      throw error;
    }
  }
  throw new Error(lastError || `${input.qaContext} failed`);
}

async function deriveRunningLeft(ctx: RunnerContext, right: BoardJobResult, canonical: { artifact: CodexPetArtifact; buffer: Buffer }): Promise<BoardJobResult> {
  let job = await ensureJob(ctx, "row-running-left", "derived_row", ["row-running-right"], { derivation: "per-frame-mirror-preserve-order" });
  const completed = await completedBoardJob(ctx, job);
  if (completed) return completed;
  const previousOutput = asRecord(job.output);
  const previousArtifactIds = [...new Set([
    ...job.outputArtifactIds,
    typeof previousOutput.boardArtifactId === "string" ? previousOutput.boardArtifactId : "",
  ].filter(Boolean))];
  job = await startJob(ctx, job, 1, 30, "逐帧镜像生成向左移动动画");
  const frames = await mirrorFramesPreservingOrder(right.frames);
  const preview = await createAnimatedWebpPreview(frames, petRowSpec("running-left").durations);
  const boardArtifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "animation_preview",
    name: "running-left 逐帧镜像预览",
    buffer: preview.image,
    mime: "image/webp",
    metadata: { derivation: "per-frame-mirror-preserve-order", sourceJobId: right.job.id },
    // Treat the preview as intermediate until mirror-specific visual QA has
    // passed. A rejected/errored mirror must never remain as a permanent,
    // user-visible animation preview.
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const frameArtifacts: CodexPetArtifact[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    frameArtifacts.push(await ctx.artifacts.put({
      userId: ctx.project.userId,
      projectId: ctx.project.id,
      runId: ctx.runId,
      jobId: job.id,
      kind: "frame",
      name: `running-left · frame ${String(index).padStart(2, "0")}`,
      buffer: frames[index]!,
      mime: "image/png",
      metadata: { index, mirroredFrom: right.frameArtifacts[index]?.id },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    }));
  }
  const generatedArtifactIds = [boardArtifact.id, ...frameArtifacts.map((artifact) => artifact.id)];
  const supersedeRejectedMirror = async () => {
    await ctx.prisma.codexPetArtifact.updateMany({
      where: {
        id: { in: generatedArtifactIds },
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
      data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
    });
  };
  let qa: PetVisualQaConsensus;
  try {
    qa = await ctx.qaConsensus({
      images: [{ buffer: canonical.buffer, mime: canonical.artifact.mime }, { buffer: preview.image, mime: "image/webp" }],
      prompt: buildVisualQaPrompt("row", "running-left must face/travel left; mirroring must preserve identity, timing and all asymmetric meaning"),
      env: ctx.env,
      signal: ctx.signal,
      repetitions: 1,
    });
  } catch (error) {
    await supersedeRejectedMirror().catch(() => undefined);
    await failJobAttempt(ctx, job, 1, safeError(error), 30, true).catch(() => undefined);
    throw error;
  }
  if (!qa.pass) {
    await supersedeRejectedMirror();
    await failJobAttempt(ctx, job, 1, qa.failures.join("；") || "镜像结果不适用", 30);
    throw new Error("MIRROR_NOT_SAFE");
  }
  job = await ctx.prisma.$transaction(async (tx) => {
    if (previousArtifactIds.length > 0) {
      await tx.codexPetArtifact.updateMany({
        where: {
          id: { in: previousArtifactIds },
          runId: ctx.runId,
          projectId: ctx.project.id,
          userId: ctx.project.userId,
        },
        data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
      });
    }
    const promoted = await tx.codexPetArtifact.updateMany({
      where: {
        id: boardArtifact.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: "ready",
      },
      data: { expiresAt: null },
    });
    if (promoted.count !== 1) throw new CodexPetLeaseLostError();
    return tx.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      inputArtifactIds: right.frameArtifacts.map((artifact) => artifact.id),
      outputArtifactIds: frameArtifacts.map((artifact) => artifact.id),
      output: { boardArtifactId: boardArtifact.id, mirrorSafe: true, qa: { score: qa.score, warnings: qa.warnings } } as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
    } });
  });
  return { job, frames, frameArtifacts, board: preview.image, boardArtifact, mirrorSafe: true, qa };
}

function imageInput(buffer: Buffer, mime = "image/png", filename = "reference.png"): ImageBinaryInput {
  return { b64: buffer.toString("base64"), mime, filename };
}

async function runStandardRow(
  ctx: RunnerContext,
  state: Exclude<PetRowSpec["state"], "look-a" | "look-b">,
  canonical: { artifact: CodexPetArtifact; buffer: Buffer },
  progress: number,
  force = false,
  repairHint = "",
): Promise<BoardJobResult> {
  const spec = petRowSpec(state);
  const layout = await createLayoutGuide({ columns: spec.boardColumns, rows: spec.boardRows, frameCount: spec.frameCount, title: `${state} ${spec.frameCount}-pose board` });
  return runBoardJob(ctx, {
    key: `row-${state}`,
    kind: "standard_row",
    dependencies: state === "running-left" ? ["row-running-right"] : ["base-selection"],
    inputArtifactIds: [canonical.artifact.id],
    prompt: buildStandardRowPrompt(ctx.identity, state),
    references: [imageInput(canonical.buffer, canonical.artifact.mime, "canonical-base.png"), imageInput(layout, "image/png", `${state}-layout.png`)],
    columns: spec.boardColumns,
    rows: spec.boardRows,
    frameCount: spec.frameCount,
    progress,
    qaKind: "row",
    qaContext: `${state} 动作组：身份、${spec.frameCount} 帧结构、动作语义和连续性`,
    animationDurations: spec.durations,
    force,
    repairHint,
  });
}

async function storeStandardAtlas(ctx: RunnerContext, frames: PetFramesByState, force = false): Promise<{
  atlas: Buffer;
  contact: Buffer;
  atlasArtifact: CodexPetArtifact;
  contactArtifact: CodexPetArtifact;
  validation: Awaited<ReturnType<typeof validateStandardPetAtlas>>;
}> {
  const job = await ensureJob(ctx, "standard-atlas", "deterministic_assembly", PET_ROW_SPECS.slice(0, 9).map((spec) => `row-${spec.state}`));
  const output = asRecord(job.output);
  if (!force && job.status === "completed" && typeof output.atlasArtifactId === "string" && typeof output.contactArtifactId === "string") {
    const [atlasArtifact, contactArtifact] = await Promise.all([
      ctx.prisma.codexPetArtifact.findFirst({ where: { id: output.atlasArtifactId, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } }),
      ctx.prisma.codexPetArtifact.findFirst({ where: { id: output.contactArtifactId, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } }),
    ]);
    if (atlasArtifact && contactArtifact) {
      const [atlas, contact] = await Promise.all([ctx.artifacts.load(atlasArtifact), ctx.artifacts.load(contactArtifact)]);
      const validation = await validateStandardPetAtlas(atlas);
      if (!validation.ok) throw new Error(`已恢复的标准 8×9 图集结构检查失败：${validation.errors.join("；")}`);
      return { atlas, contact, atlasArtifact, contactArtifact, validation };
    }
  }
  const atlas = await assembleStandardPetAtlas(frames, "webp");
  const validation = await validateStandardPetAtlas(atlas);
  if (!validation.ok) throw new Error(`标准 8×9 图集结构检查失败：${validation.errors.join("；")}`);
  const contact = await createStandardAtlasContactSheet(atlas);
  const [atlasArtifact, contactArtifact, validationArtifact] = await Promise.all([
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, jobId: job.id, kind: "standard_atlas", name: "标准 8×9 中间图集", buffer: atlas, mime: "image/webp", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) }),
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, jobId: job.id, kind: "qa_contact_sheet", name: "标准动作 Contact Sheet", buffer: contact, mime: "image/png", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) }),
    putJsonArtifact(ctx, { jobId: job.id, kind: "qa_report", name: "标准 8×9 图集结构验证", value: validation, expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) }),
  ]);
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { atlasArtifactId: atlasArtifact.id, contactArtifactId: contactArtifact.id, validationArtifactId: validationArtifact.id } as Prisma.InputJsonValue,
    outputArtifactIds: [atlasArtifact.id, contactArtifact.id, validationArtifact.id],
    completedAt: new Date(),
  } });
  if (validation.warnings.length > 0) {
    await emit(ctx, "validation.warning", "standard_generating", 65, "标准动作图集通过结构检查，存在可复核警告", { warnings: validation.warnings }, job.key);
  }
  return { atlas, contact, atlasArtifact, contactArtifact, validation };
}

async function getLookMechanics(ctx: RunnerContext, canonical: { artifact: CodexPetArtifact; buffer: Buffer }): Promise<string> {
  const job = await ensureJob(ctx, "look-mechanics", "look_mechanics", ["standard-atlas"]);
  const output = asRecord(job.output);
  if (job.status === "completed" && typeof output.mechanics === "string") return output.mechanics;
  const mechanics = await ctx.lookMechanics({ prompt: buildLookMechanicsPrompt(ctx.identity), reference: canonical.buffer, env: ctx.env, signal: ctx.signal });
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: { status: "completed", attempt: 1, output: { mechanics } as Prisma.InputJsonValue, completedAt: new Date() } });
  return mechanics;
}

async function reviewFirstLookRow(
  ctx: RunnerContext,
  input: {
    readonly look: BoardJobResult;
    readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly standardContact: Buffer;
    readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  },
) {
  const directions = LOOK_DIRECTIONS.slice(0, 8);
  const continuity = await measureDirectionRowContinuity(input.look.frames, directions);
  if (!continuity.ok) {
    return {
      pass: false,
      continuity,
      failures: continuity.errors,
      repairPrompt: continuity.errors.join("; ") || "repair empty or structurally invalid direction cells",
    };
  }
  const preview = await createAnimatedWebpPreview(input.look.frames, petRowSpec("look-a").durations);
  const qa = await ctx.qaConsensus({
    images: [
      { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
      { buffer: input.standardContact, mime: "image/png" },
      { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
      { buffer: preview.image, mime: preview.mime },
    ],
    prompt: buildVisualQaPrompt(
      "directions",
      `Pre-row-10 gate for the registered row-9 sequence 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5. `
      + `Confirm 000 unmistakably up, 090 unmistakably screen-right, every intermediate stays in its labeled quadrant, and the animated sequence advances clockwise without reversal, registration snap, scale pop or identity drift. `
      + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
    ),
    env: ctx.env,
    signal: ctx.signal,
    repetitions: 1,
  });
  await putJsonArtifact(ctx, {
    jobId: input.look.job.id,
    kind: "qa_report",
    name: `方向 000–157.5 注册与连续性门禁 · 第 ${input.look.job.attempt} 次`,
    value: { deterministicContinuity: continuity, visual: qa },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  return {
    pass: qa.pass,
    continuity,
    failures: qa.failures,
    repairPrompt: qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt
      || qa.failures.join("; ")
      || "strengthen labeled direction semantics and adjacent continuity for the complete row",
  };
}

/**
 * Independent row-10 (180–337.5°) gate.  Row 10 is checked before final
 * assembly, rather than relying solely on the full-atlas blind test.  The
 * previous row is supplied to the multimodal reviewer to expose both seam
 * continuity (157.5→180 and 337.5→000) and registration/scale changes.
 */
async function reviewSecondLookRow(
  ctx: RunnerContext,
  input: {
    readonly look: BoardJobResult;
    readonly previousLook: BoardJobResult;
    readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly standardContact: Buffer;
    readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  },
) {
  const directions = LOOK_DIRECTIONS.slice(8);
  const continuity = await measureDirectionRowContinuity(input.look.frames, directions);
  const preview = await createAnimatedWebpPreview(input.look.frames, petRowSpec("look-b").durations);
  let qa: PetVisualQaConsensus = {
    pass: false,
    verdicts: [],
    score: 0,
    mirrorSafe: false,
    warnings: [],
    failures: [],
  };
  if (continuity.ok) {
    qa = await ctx.qaConsensus({
      images: [
        { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
        { buffer: input.standardContact, mime: "image/png" },
        { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
        { buffer: input.previousLook.board, mime: input.previousLook.boardArtifact.mime },
        { buffer: input.look.board, mime: input.look.boardArtifact.mime },
        { buffer: preview.image, mime: preview.mime },
      ],
      prompt: buildVisualQaPrompt(
        "directions",
        `Independent pre-row-10 gate for registered directions 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5. `
        + `Confirm 180 unmistakably down, 270 unmistakably screen-left, every intermediate remains in its labeled quadrant, and the animated row advances clockwise without reversal, registration snap, scale pop or identity drift. `
        + `Compare the preceding 157.5 frame from row 9 and the 000 anchor for both row-boundary seams. `
        + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
      ),
      env: ctx.env,
      signal: ctx.signal,
      repetitions: 1,
    });
  }
  const failures = [...continuity.errors, ...qa.failures];
  const repairPrompt = qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt
    || failures.join("; ")
    || "strengthen the complete 180–337.5 direction row and both row-boundary seams";
  await putJsonArtifact(ctx, {
    jobId: input.look.job.id,
    kind: "qa_report",
    name: `方向 180–337.5 注册与连续性门禁 · 第 ${input.look.job.attempt} 次`,
    value: {
      row: 10,
      directions,
      deterministicContinuity: continuity,
      visual: qa,
      animationPreview: { frameCount: preview.frameCount, durations: preview.durations },
      previousRowArtifactId: input.previousLook.boardArtifact.id,
      cardinalAnchorArtifactId: input.cardinalAnchor.artifact.id,
      row10PreGenerationGate: { passed: continuity.ok && qa.pass, failures },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  return {
    pass: continuity.ok && qa.pass,
    continuity,
    visual: qa,
    failures,
    repairPrompt,
  };
}

async function summarizeProviderUsage(ctx: RunnerContext): Promise<{ actualModels: string[]; usage: Record<string, number> }> {
  const artifacts = await ctx.prisma.codexPetArtifact.findMany({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      kind: { in: ["base_candidate", "pose_board"] },
    },
    select: { metadata: true },
  });
  const actualModels = new Set<string>();
  const usage = { inputTokens: 0, imageInputTokens: 0, textInputTokens: 0, outputTokens: 0, imageOutputTokens: 0, totalTokens: 0 };
  for (const artifact of artifacts) {
    const metadata = asRecord(artifact.metadata);
    if (typeof metadata.actualModel === "string") actualModels.add(metadata.actualModel);
    const row = asRecord(metadata.usage);
    for (const key of Object.keys(usage) as Array<keyof typeof usage>) {
      if (typeof row[key] === "number") usage[key] += row[key] as number;
    }
  }
  return { actualModels: [...actualModels], usage };
}

async function refundRun(ctx: RunnerContext, reason: string): Promise<boolean> {
  const run = await currentRun(ctx);
  if (!run.billingOperationId || run.billingRefundedAt || run.billingRefundStatus === "refunded") return Boolean(run.billingRefundedAt);
  const attemptedAt = new Date();
  try {
    const result = await ctx.billing.refundResource(run.billingOperationId);
    if (!result.success) throw new Error("billing refund was not accepted");
    await ctx.prisma.codexPetRun.update({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId }, data: {
      billingRefundedAt: attemptedAt,
      billingRefundStatus: "refunded",
      billingRefundError: null,
      billingRefundLastAttemptAt: attemptedAt,
      billingRefundRetryCount: { increment: 1 },
      billingRefundNextRetryAt: null,
    } });
  } catch (error) {
    const retryCount = run.billingRefundRetryCount + 1;
    await ctx.prisma.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, billingRefundedAt: null }, data: {
      billingRefundStatus: "pending",
      billingRefundError: safeError(error),
      billingRefundLastAttemptAt: attemptedAt,
      billingRefundRetryCount: retryCount,
      billingRefundNextRetryAt: new Date(Date.now() + Math.min(24 * 60 * 60_000, 30_000 * 2 ** Math.min(retryCount, 8))),
    } });
    return false;
  }
  // Terminal state and the refund receipt are already durable. A realtime
  // event outage must not turn a successful refund back into pending or cause
  // the run to be executed/refunded again.
  const refundedRun = await currentRun(ctx);
  await emit(ctx, "billing.refunded", refundedRun.status, refundedRun.progressPercent, "套餐积分已全额退回", { reason }).catch(() => undefined);
  return true;
}

/**
 * Reference loading happens immediately after a lease claim, before the main
 * execution context/monitor is constructed.  If an object was deleted or
 * ownership changed in that small window, release the lease through the same
 * terminal/refund policy as a normal runner failure; otherwise a Bull failure
 * would leave the run permanently active with no worker to recover it.
 */
async function finalizeClaimedSetupFailure(input: {
  readonly prisma: PrismaClient;
  readonly appendEvent: CodexPetRunnerDeps["appendEvent"];
  readonly billing: CodexPetRunnerDeps["billing"];
  readonly project: CodexPetProject;
  readonly runId: string;
  readonly workerId: string;
  readonly error: unknown;
}): Promise<void> {
  const message = safeError(input.error);
  const now = new Date();
  const outcome = await input.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId } });
    if (!current || current.status === "ready" || current.status === "failed" || current.status === "cancelled" || current.workerId !== input.workerId || current.cancelRequested) {
      return { transitioned: false, refundPending: false, run: current };
    }
    const refundPending = current.billingChargeStatus === "charged"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
    const changed = await tx.codexPetRun.updateMany({
      where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, workerId: input.workerId, status: { in: [...CODEX_PET_ACTIVE_STATUSES] } },
      data: {
        status: "failed",
        progressStage: "failed",
        progressMessage: message,
        error: message,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: input.project.id, userId: input.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    return { transitioned: true, refundPending, run: current };
  });
  if (!outcome.transitioned) return;
  await input.appendEvent({ prisma: input.prisma, runId: input.runId, type: "run.failed", stage: "failed", progress: outcome.run?.progressPercent ?? 0, message, payload: { retryable: false } }).catch(() => undefined);
  if (!outcome.refundPending || !outcome.run?.billingOperationId) return;
  const attemptedAt = new Date();
  try {
    const result = await input.billing.refundResource(outcome.run.billingOperationId);
    if (!result.success) throw new Error("billing refund was not accepted");
    await input.prisma.codexPetRun.updateMany({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingRefundedAt: null }, data: { billingRefundedAt: attemptedAt, billingRefundStatus: "refunded", billingRefundError: null, billingRefundLastAttemptAt: attemptedAt, billingRefundRetryCount: { increment: 1 }, billingRefundNextRetryAt: null } });
    await input.appendEvent({ prisma: input.prisma, runId: input.runId, type: "billing.refunded", stage: "failed", progress: outcome.run.progressPercent, message: "套餐积分已全额退回", payload: { reason: "setup_failure" } }).catch(() => undefined);
  } catch (error) {
    await input.prisma.codexPetRun.updateMany({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingRefundedAt: null }, data: { billingRefundStatus: "pending", billingRefundError: safeError(error), billingRefundLastAttemptAt: attemptedAt, billingRefundRetryCount: { increment: 1 }, billingRefundNextRetryAt: new Date(Date.now() + 30_000) } }).catch(() => undefined);
  }
}

async function finalizeFailure(ctx: RunnerContext, error: unknown): Promise<void> {
  const message = safeError(error);
  const now = new Date();
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "ready" || current.status === "failed" || current.status === "cancelled") {
      return { transitioned: false, refundPending: false, run: current };
    }
    if (current.cancelRequested) return { transitioned: false, refundPending: false, run: current };
    // A stale worker may still be unwinding an upstream request after a new
    // worker has claimed the lease. It must never overwrite that worker's
    // progress (especially a committed ready state).
    if (current.workerId !== ctx.workerId) return { transitioned: false, refundPending: false, run: current };
    const refundPending = current.billingChargeStatus === "charged"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
    const changed = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: { in: [...CODEX_PET_ACTIVE_STATUSES] } },
      data: {
        status: "failed",
        progressStage: "failed",
        progressMessage: message,
        error: message,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    return { transitioned: true, refundPending, run: { ...current, status: "failed", progressStage: "failed", progressMessage: message, progressPercent: current.progressPercent } };
  });
  if (!outcome.transitioned) {
    if (outcome.run?.cancelRequested) await finalizeCancellation(ctx);
    return;
  }
  const failure = imageFailureMetadata(error);
  await emit(ctx, "run.failed", "failed", outcome.run?.progressPercent ?? 0, message, {
    retryable: false,
    errorCategory: failure.category,
    ...(failure.upstreamRequestId ? { upstreamRequestId: failure.upstreamRequestId } : {}),
  }).catch(() => undefined);
  if (outcome.refundPending) await refundRun(ctx, "system_failure");
}

async function finalizeCancellation(ctx: RunnerContext): Promise<void> {
  const now = new Date();
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "cancelled" || current.status === "ready" || current.status === "failed") {
      return { transitioned: false, refundPending: false, run: current };
    }
    // Permit an unclaimed run (the API can set cancelRequested before Bull
    // starts), but never let a stale worker cancel a newer worker's lease.
    if (current.workerId !== null && current.workerId !== ctx.workerId) return { transitioned: false, refundPending: false, run: current };
    const refundPending = current.billingChargeStatus === "charged"
      && !current.hasSuccessfulImage
      && current.status !== "awaiting_base_review"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        OR: [{ workerId: ctx.workerId }, { workerId: null }],
      },
      data: {
        status: "cancelled",
        progressStage: "cancelled",
        progressMessage: "用户已取消",
        error: null,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        cancelRequested: true,
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "cancelled" } });
    await tx.codexPetJob.updateMany({ where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, status: { in: ["queued", "running"] } }, data: { status: "cancelled", error: "用户已取消", completedAt: now, workerId: null } });
    return { transitioned: true, refundPending, run: { ...current, status: "cancelled", progressPercent: current.progressPercent } };
  });
  // The API can cancel an unclaimed queued run while its Bull job is still in
  // flight. Only the process that wins the state transition owns the terminal
  // event/refund, preventing a later queue delivery from duplicating either.
  if (!outcome.transitioned) return;
  await emit(ctx, "run.cancelled", "cancelled", outcome.run?.progressPercent ?? 0, "桌宠制作已取消", { hasSuccessfulImage: outcome.run?.hasSuccessfulImage ?? false }).catch(() => undefined);
  if (outcome.refundPending) await refundRun(ctx, "cancelled_before_first_image");
}

const TERMINAL_ARCHIVE_ERROR_CODES = new Set([
  "run_not_found",
  "invalid_stage",
  "archive_deleted",
  "package_incomplete",
  "validation_failed",
  "source_conflict",
]);

function terminalArchiveError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === "string" && TERMINAL_ARCHIVE_ERROR_CODES.has(code);
}

/**
 * Knowledge archival is a durable job rather than an in-process retry loop.
 * Transient database/indexing-control-plane failures leave the run at 98% in
 * `archiving`; the worker releases its lease and the stale-run scanner queues
 * another attempt. Permanent contract failures, or exhaustion of the bounded
 * deployment-configured attempts, still follow the normal full-refund path.
 */
async function runKnowledgeArchiveAttempt(ctx: RunnerContext): Promise<string> {
  const maxAttempts = configuredArchiveMaxAttempts(ctx.env);
  let job = await ensureJob(
    ctx,
    "knowledge-archive",
    "knowledge_archive",
    ["standard-atlas", "look-a", "look-b"],
    {},
    maxAttempts,
  );
  const previous = asRecord(job.output);
  if (job.status === "completed" && typeof previous.documentId === "string" && previous.documentId) {
    return previous.documentId;
  }
  const attempt = job.attempt + 1;
  if (attempt > job.maxAttempts) throw new Error("AI 产物知识库归档重试次数已耗尽");
  job = await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "running",
    attempt,
    workerId: ctx.workerId,
    startedAt: new Date(),
    completedAt: null,
    error: null,
  } });
  if (attempt === 1) {
    await emit(ctx, "knowledge.archive_started", "archiving", 98, "开始写入 AI 产物知识库", {
      attempt,
      maxAttempts: job.maxAttempts,
    }, job.key).catch(() => undefined);
  }
  try {
    const documentId = (await ctx.archiveRun({
      prisma: ctx.prisma,
      runId: ctx.runId,
      userId: ctx.project.userId,
      projectId: ctx.project.id,
    })).documentId;
    if (!documentId) throw new Error("知识库归档未返回文档 ID");
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      output: { documentId } as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
      error: null,
    } });
    await emit(ctx, "knowledge.archive_completed", "archiving", 98, "已归档到 AI 产物知识库", {
      knowledgeDocumentId: documentId,
      attempt,
    }, job.key).catch(() => undefined);
    return documentId;
  } catch (error) {
    const terminal = terminalArchiveError(error) || attempt >= job.maxAttempts;
    await ctx.prisma.codexPetJob.updateMany({
      where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
      data: {
        status: terminal ? "failed" : "queued",
        workerId: null,
        error: safeError(error),
        completedAt: terminal ? new Date() : null,
      },
    }).catch(() => undefined);
    await emit(ctx, "knowledge.archive_retrying", "archiving", 98, terminal
      ? "AI 产物知识库归档最终失败"
      : "知识库归档暂时失败，等待 Worker 重试", {
      attempt,
      maxAttempts: job.maxAttempts,
      terminal,
      error: safeError(error),
    }, job.key).catch(() => undefined);
    if (terminal) throw error;
    throw new CodexPetArchiveDeferredError(safeError(error), attempt, job.maxAttempts);
  }
}

async function completeKnowledgeArchive(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  const documentId = await runKnowledgeArchiveAttempt(ctx);
  const now = new Date();
  const readyCommitted = await ctx.prisma.$transaction(async (tx) => {
    // Document deletion uses FK SetNull. Require the exact archive link and
    // archiving stage in the same conditional transition so a concurrent
    // knowledge-base deletion can never produce ready + null document.
    const transition = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: "archiving", knowledgeDocumentId: documentId, cancelRequested: false },
      data: { status: "ready", progressStage: "ready", progressPercent: 100, progressMessage: "桌宠已完成，可安装到 Codex", completedAt: now, heartbeatAt: now, workerId: null, error: null },
    });
    if (transition.count !== 1) return false;
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "ready" } });
    return true;
  });
  if (!readyCommitted) throw new Error("知识库归档关联已变化，桌宠不能进入 ready");
  // ready + knowledgeDocumentId is the authoritative committed outcome. A
  // final SSE/event write failure must never downgrade a deliverable run to
  // failed or trigger a package refund.
  await emit(ctx, "run.completed", "ready", 100, "桌宠已完成并归档", {
    knowledgeDocumentId: documentId,
  }).catch(() => undefined);
  return { status: "ready", runId: ctx.runId };
}

async function releaseDeferredArchiveLease(ctx: RunnerContext, error: CodexPetArchiveDeferredError): Promise<boolean> {
  const released = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: "archiving",
      cancelRequested: false,
    },
    data: {
      progressStage: "archiving",
      progressPercent: 98,
      progressMessage: `知识库归档暂时失败，等待重试（${error.attempt}/${error.maxAttempts}）`,
      error: error.message,
      workerId: null,
      heartbeatAt: null,
    },
  });
  return released.count === 1;
}

async function executeRun(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  let run = await currentRun(ctx);
  if (run.status === "ready") return { status: "ready", runId: ctx.runId };
  if (run.status === "failed") return { status: "failed", runId: ctx.runId };
  if (run.status === "cancelled" || run.cancelRequested) throw new CodexPetCancelledError();
  if (run.status === "archiving") return completeKnowledgeArchive(ctx);

  await stage(ctx, "base_generating", 5, "正在生成主形象候选");
  const visualConcurrency = configuredVisualConcurrency(ctx.env);
  const candidates = await mapWithConcurrency([1, 2], visualConcurrency, (candidateIndex) => generateBaseCandidate(ctx, candidateIndex));
  await checkCancelled(ctx);
  run = await currentRun(ctx);
  let selectedArtifactId = run.selectedBaseArtifactId;
  if (!selectedArtifactId && run.autoContinue) {
    selectedArtifactId = await selectBaseAutomatically(ctx, candidates);
    const selectedUpdate = await ctx.prisma.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { selectedBaseArtifactId: selectedArtifactId } });
    if (selectedUpdate.count !== 1) throw new CodexPetLeaseLostError();
  }
  if (!selectedArtifactId) {
    const reviewReleased = await ctx.prisma.$transaction(async (tx) => {
      const changed = await tx.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { status: "awaiting_base_review", progressStage: "awaiting_base_review", progressPercent: 15, progressMessage: "请选择一个主形象后继续", workerId: null, heartbeatAt: new Date() } });
      if (changed.count !== 1) return false;
      await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "awaiting_base_review" } });
      return true;
    });
    if (!reviewReleased) throw new CodexPetLeaseLostError();
    await emit(ctx, "base.review_required", "awaiting_base_review", 15, "主形象候选已就绪，请选择后继续", { candidateArtifactIds: candidates.map((candidate) => candidate.artifact.id) });
    return { status: "awaiting_base_review", runId: ctx.runId };
  }
  const selected = candidates.find((candidate) => candidate.artifact.id === selectedArtifactId);
  if (!selected) throw new Error("选中的主形象不属于当前运行候选");
  const selectedCommitted = await ctx.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { selectedBaseArtifactId: selectedArtifactId } });
    if (changed.count !== 1) return false;
    const artifactChanged = await tx.codexPetArtifact.updateMany({
      where: {
        id: selectedArtifactId,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        kind: "base_candidate",
        status: "ready",
      },
      data: {
        expiresAt: null,
        metadata: { ...asRecord(selected.artifact.metadata), selected: true } as Prisma.InputJsonValue,
      },
    });
    if (artifactChanged.count !== 1) throw new CodexPetLeaseLostError();
    return true;
  });
  if (!selectedCommitted) throw new CodexPetLeaseLostError();
  await emit(ctx, "stage.completed", "base_generating", 15, "主形象已确认", { selectedArtifactId });

  await stage(ctx, "standard_generating", 16, "正在制作 9 组标准动作");
  let [idle, runningRight] = await mapWithConcurrency([
    { state: "idle" as const, progress: 20 },
    { state: "running-right" as const, progress: 25 },
  ], visualConcurrency, (item) => runStandardRow(ctx, item.state, selected, item.progress));
  let runningLeft: BoardJobResult;
  if (runningRight.mirrorSafe) {
    try {
      runningLeft = await deriveRunningLeft(ctx, runningRight, selected);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MIRROR_NOT_SAFE") throw error;
      runningLeft = await runStandardRow(ctx, "running-left", selected, 30, true, "Do not mirror: preserve asymmetric markings, prop handedness and leftward action explicitly.");
    }
  } else {
    runningLeft = await runStandardRow(ctx, "running-left", selected, 30);
  }
  const remainingStates = ["waving", "jumping", "failed", "waiting", "running", "review"] as const;
  const remaining = new Map<(typeof remainingStates)[number], BoardJobResult>();
  const remainingResults = await mapWithConcurrency(remainingStates, visualConcurrency, (stateName, index) => (
    runStandardRow(ctx, stateName, selected, 35 + index * 5)
  ));
  remainingStates.forEach((stateName, index) => remaining.set(stateName, remainingResults[index]!));
  const frames: PetFramesByState = {
    idle: idle.frames,
    "running-right": runningRight.frames,
    "running-left": runningLeft.frames,
    waving: remaining.get("waving")!.frames,
    jumping: remaining.get("jumping")!.frames,
    failed: remaining.get("failed")!.frames,
    waiting: remaining.get("waiting")!.frames,
    running: remaining.get("running")!.frames,
    review: remaining.get("review")!.frames,
  };
  let standard = await storeStandardAtlas(ctx, frames);
  await emit(ctx, "stage.completed", "standard_generating", 65, "9 组标准动作已完成", { contactArtifactId: standard.contactArtifact.id });

  await stage(ctx, "direction_generating", 65, "正在制作 16 个观察方向");
  const mechanics = await getLookMechanics(ctx, selected);
  const cardinalLayout = await createLayoutGuide({ columns: 2, rows: 2, frameCount: 4, title: "Four cardinal look anchors: up, right, down, left" });
  let cardinals = await runBoardJob(ctx, {
    key: "look-cardinals",
    kind: "look_cardinals",
    dependencies: ["look-mechanics", "standard-atlas"],
    inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
    prompt: buildCardinalPrompt(ctx.identity, mechanics),
    references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(standard.contact, "image/png", "standard-contact.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
    columns: 2,
    rows: 2,
    frameCount: 4,
    progress: 68,
    qaKind: "cardinals",
    qaContext: "四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左",
    qaRepetitions: 3,
  });
  let cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals);
  const lookLayout = await createLayoutGuide({ columns: 4, rows: 2, frameCount: 8, title: "Eight clockwise look directions" });
  let lookA = await runBoardJob(ctx, {
    key: "look-a",
    kind: "look_row",
    dependencies: ["look-cardinals"],
    inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id, cardinalAnchor.artifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics),
    references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(standard.contact, "image/png", "approved-standard-contact.png"), imageInput(cardinalAnchor.buffer, cardinalAnchor.artifact.mime, "approved-cardinal-anchor-strip.png"), imageInput(lookLayout, "image/png", "look-layout.png")],
    columns: 4,
    rows: 2,
    frameCount: 8,
    progress: 72,
    qaKind: "directions",
    qaContext: "方向 000 到 157.5 的连续顺时针观察动作",
    animationDurations: petRowSpec("look-a").durations,
  });
  let firstLookGate = await reviewFirstLookRow(ctx, { look: lookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  while (!firstLookGate.pass) {
    if (lookA.job.attempt >= lookA.job.maxAttempts) {
      throw new Error(`方向 000 到 157.5 未通过 row-10 前置门禁：${firstLookGate.failures.join("；") || "方向语义或连续性失败"}`);
    }
    await emit(ctx, "run.repairing", "repairing", 74, "正在修复第一组观察方向，第二组尚未启动", {
      attempt: lookA.job.attempt,
      failures: firstLookGate.failures,
    }, lookA.job.key);
    lookA = await runBoardJob(ctx, {
      key: "look-a",
      kind: "look_row",
      dependencies: ["look-cardinals"],
      inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id, cardinalAnchor.artifact.id],
      prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics),
      references: [imageInput(selected.buffer, selected.artifact.mime, "approved-canonical-base.png"), imageInput(standard.contact, "image/png", "approved-standard-contact.png"), imageInput(cardinalAnchor.buffer, cardinalAnchor.artifact.mime, "approved-cardinal-anchor-strip.png"), imageInput(lookLayout, "image/png", "look-layout.png")],
      columns: 4,
      rows: 2,
      frameCount: 8,
      progress: 74,
      qaKind: "directions",
      qaContext: "修复方向 000 到 157.5 的完整连续动作组",
      animationDurations: petRowSpec("look-a").durations,
      force: true,
      repairHint: firstLookGate.repairPrompt,
    });
    firstLookGate = await reviewFirstLookRow(ctx, { look: lookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  }
  await emit(ctx, "stage.completed", "direction_generating", 74, "第一组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 9,
    continuityWarnings: firstLookGate.continuity.warnings.map((warning) => warning.message),
  }, lookA.job.key);
  let lookB = await runBoardJob(ctx, {
    key: "look-b",
    kind: "look_row",
    dependencies: ["look-a"],
    inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id, cardinalAnchor.artifact.id, lookA.boardArtifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics),
    references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(standard.contact, "image/png", "approved-standard-contact.png"), imageInput(cardinalAnchor.buffer, cardinalAnchor.artifact.mime, "approved-cardinal-anchor-strip.png"), imageInput(lookA.board, lookA.boardArtifact.mime, "completed-look-a.png"), imageInput(lookLayout, "image/png", "look-layout.png")],
    columns: 4,
    rows: 2,
    frameCount: 8,
    progress: 76,
    qaKind: "directions",
    qaContext: "方向 180 到 337.5 连续顺时针观察动作，并与 157.5/000 边界连续",
    animationDurations: petRowSpec("look-b").durations,
  });
  let secondLookGate = await reviewSecondLookRow(ctx, { look: lookB, previousLook: lookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  while (!secondLookGate.pass) {
    if (lookB.job.attempt >= lookB.job.maxAttempts) {
      throw new Error(`方向 180 到 337.5 未通过 row-10 前置门禁：${secondLookGate.failures.join("；") || "方向语义或连续性失败"}`);
    }
    await emit(ctx, "run.repairing", "repairing", 78, "正在修复第二组观察方向，最终组装尚未启动", {
      attempt: lookB.job.attempt,
      failures: secondLookGate.failures,
    }, lookB.job.key);
    lookB = await runBoardJob(ctx, {
      key: "look-b", kind: "look_row", dependencies: ["look-a"], inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id, cardinalAnchor.artifact.id, lookA.boardArtifact.id],
      prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics),
      references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(standard.contact, "image/png", "approved-standard-contact.png"), imageInput(cardinalAnchor.buffer, cardinalAnchor.artifact.mime, "approved-cardinal-anchor-strip.png"), imageInput(lookA.board, lookA.boardArtifact.mime, "completed-look-a.png"), imageInput(lookLayout, "image/png", "look-layout.png")],
      columns: 4, rows: 2, frameCount: 8, progress: 78, qaKind: "directions", qaContext: "修复方向 180 到 337.5 的完整连续动作组", animationDurations: petRowSpec("look-b").durations, force: true, repairHint: secondLookGate.repairPrompt,
    });
    secondLookGate = await reviewSecondLookRow(ctx, { look: lookB, previousLook: lookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  }
  await emit(ctx, "stage.completed", "direction_generating", 79, "第二组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 10,
    continuityWarnings: secondLookGate.continuity.warnings.map((warning) => warning.message),
  }, lookB.job.key);
  await emit(ctx, "stage.completed", "direction_generating", 80, "16 个观察方向已完成", {});

  await stage(ctx, "validating", 80, "正在组装图集并执行最终质量检查");
  let finalAtlas: Buffer = Buffer.alloc(0);
  let contactSheet: Buffer = Buffer.alloc(0);
  let directionSheet: Buffer = Buffer.alloc(0);
  let blindSheet: Buffer = Buffer.alloc(0);
  let blindValidation: BlindDirectionValidation | null = null;
  let semantics: readonly DirectionSemanticVerdict[] = [];
  let validation: Awaited<ReturnType<typeof validatePetAtlas>> | null = null;
  let despill: Awaited<ReturnType<typeof despillChromaEdges>>["report"] | null = null;
  let continuity: Awaited<ReturnType<typeof measureDirectionContinuity>> | null = null;
  let directionRegistration: {
    readonly ok: boolean;
    readonly sharedScale: number;
    readonly sourceBoardSizes: readonly { readonly width: number; readonly height: number }[];
    readonly diagnosticsByBoard: readonly (readonly Record<string, unknown>[])[];
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  } | null = null;
  let finalQa: PetVisualQaVerdict | null = null;
  const finalRepairHistory: Array<{ attempt: number; rows: readonly string[]; failures: readonly string[] }> = [];

  // Rebuild both direction rows as complete groups whenever a direction gate
  // or final visual QA requests repair.  Re-running both rows keeps the seam
  // and the 000/360 wrap coherent; no individual direction frame is patched.
  const regenerateDirectionRows = async (repairHint: string): Promise<void> => {
    let hint = repairHint;
    for (;;) {
      lookA = await runBoardJob(ctx, {
        key: "look-a", kind: "look_row", dependencies: ["look-cardinals"], inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id, cardinalAnchor.artifact.id],
        prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics), references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(standard.contact, "image/png", "approved-standard-contact.png"), imageInput(cardinalAnchor.buffer, cardinalAnchor.artifact.mime, "approved-cardinal-anchor-strip.png"), imageInput(lookLayout, "image/png", "look-layout.png")],
        columns: 4, rows: 2, frameCount: 8, progress: 84, qaKind: "directions", qaContext: "修复方向 000 到 157.5 的完整连续动作组", animationDurations: petRowSpec("look-a").durations, force: true, repairHint: hint,
      });
      firstLookGate = await reviewFirstLookRow(ctx, { look: lookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
      if (firstLookGate.pass) break;
      if (lookA.job.attempt >= lookA.job.maxAttempts) throw new Error(`修复后的第一组观察方向未通过前置门禁：${firstLookGate.failures.join("；") || "方向语义或连续性失败"}`);
      hint = firstLookGate.repairPrompt;
    }
    for (;;) {
      lookB = await runBoardJob(ctx, {
        key: "look-b", kind: "look_row", dependencies: ["look-a"], inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id, cardinalAnchor.artifact.id, lookA.boardArtifact.id],
        prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics), references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(standard.contact, "image/png", "approved-standard-contact.png"), imageInput(cardinalAnchor.buffer, cardinalAnchor.artifact.mime, "approved-cardinal-anchor-strip.png"), imageInput(lookA.board, lookA.boardArtifact.mime, "completed-look-a.png"), imageInput(lookLayout, "image/png", "look-layout.png")],
        columns: 4, rows: 2, frameCount: 8, progress: 84, qaKind: "directions", qaContext: "修复方向 180 到 337.5 的完整连续动作组", animationDurations: petRowSpec("look-b").durations, force: true, repairHint: hint,
      });
      secondLookGate = await reviewSecondLookRow(ctx, { look: lookB, previousLook: lookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
      if (secondLookGate.pass) break;
      if (lookB.job.attempt >= lookB.job.maxAttempts) throw new Error(`修复后的第二组观察方向未通过前置门禁：${secondLookGate.failures.join("；") || "方向语义或连续性失败"}`);
      hint = secondLookGate.repairPrompt;
    }
  };

  for (let directionAttempt = 1; directionAttempt <= 3; directionAttempt += 1) {
    const registered = await extractFullPoseBoardsWithSharedRegistration([
      { input: lookA.board, columns: 4, rows: 2, frameCount: 8 },
      { input: lookB.board, columns: 4, rows: 2, frameCount: 8 },
    ], { chromaKey: ctx.identity.chromaKey });
    directionRegistration = {
      ok: registered.ok,
      sharedScale: registered.sharedScale,
      sourceBoardSizes: registered.sourceBoardSizes,
      diagnosticsByBoard: registered.diagnosticsByBoard.map((row) => row.map((item) => ({
        index: item.index,
        sourceBounds: item.sourceBounds,
        normalizedBounds: item.normalizedBounds,
        opaquePixels: item.opaquePixels,
        componentCount: item.componentCount,
        internalTransparentPixels: item.internalTransparentPixels,
        errors: item.errors,
        warnings: item.warnings,
      }))),
      errors: registered.errors,
      warnings: registered.warnings,
    };
    await putJsonArtifact(ctx, {
      jobId: lookB.job.id,
      kind: "qa_report",
      name: `16 方向共享缩放与基线注册 · 第 ${directionAttempt} 次`,
      value: directionRegistration,
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    if (!registered.ok) {
      if (directionAttempt >= 3) {
        throw new Error(`16 个观察方向共享注册经两轮自动修复后仍未通过：${registered.errors.join("；")}`);
      }
      const repairHint = registered.errors.join("; ") || "keep all 16 direction poses inside their cells at one consistent scale and baseline";
      await emit(ctx, "run.repairing", "repairing", 82, `方向共享注册自动修复 ${directionAttempt}/2`, { failures: registered.errors });
      await regenerateDirectionRows(repairHint);
      continue;
    }
    frames["look-a"] = registered.framesByBoard[0]!;
    frames["look-b"] = registered.framesByBoard[1]!;
    const assembled = await assemblePetAtlas(frames, "png");
    const cleaned = await despillChromaEdges(assembled, ctx.identity.chromaKey);
    finalAtlas = cleaned.image;
    despill = cleaned.report;
    validation = await validatePetAtlas(finalAtlas, ctx.identity.chromaKey);
    if (!despill.ok || !validation.ok) throw new Error(`最终图集结构检查失败：${[...validation.errors, ...(despill.ok ? [] : [`残留色键像素 ${despill.remainingOpaqueKeyPixels}`])].join("；")}`);
    continuity = await measureDirectionContinuity(finalAtlas);
    if (!continuity.ok) throw new Error(`观察方向连续性结构检查失败：${continuity.errors.join("；")}`);
    contactSheet = await createAtlasContactSheet(finalAtlas);
    directionSheet = await createDirectionQaSheet(finalAtlas);
    const blind = await createDirectionBlindQaSheet(finalAtlas);
    blindSheet = blind.image;
    [blindValidation, semantics] = await Promise.all([
      ctx.blindQa({ sheet: blind.image, answerKey: blind.answerKey, env: ctx.env, signal: ctx.signal }),
      ctx.directionSemantics({ sheet: directionSheet, expectedDirections: LOOK_DIRECTIONS, env: ctx.env, signal: ctx.signal }),
    ]);
    const semanticFailures = semantics.filter((item) => item.verdict === "fail");
    if (!(blindValidation.ok && semanticFailures.length === 0)) {
      if (directionAttempt >= 3) {
        throw new Error(`方向质检经两轮自动修复后仍未通过：${[...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}:${item.reason}`)].join("；")}`);
      }
      const repairHint = [...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}: ${item.reason}`)].join("; ");
      await emit(ctx, "run.repairing", "repairing", 84, `方向动作自动修复 ${directionAttempt}/2`, { failures: repairHint });
      await regenerateDirectionRows(repairHint);
      continue;
    }

    // The final independent reviewer is part of the bounded repair loop. It
    // receives playable previews for all nine rows and returns complete row
    // scopes, allowing us to regenerate an action group before packaging.
    const continuityWarnings = continuity!.warnings.map((item) => item.message);
    const motionPreviews = await Promise.all(PET_ROW_SPECS.slice(0, 9).map((spec) => (
      createAnimatedWebpPreview(frames[spec.state]!, spec.durations)
    )));
    finalQa = await ctx.qa({
      images: [
        { buffer: selected.buffer, mime: selected.artifact.mime },
        { buffer: standard.contact, mime: "image/png" },
        { buffer: contactSheet, mime: "image/png" },
        { buffer: directionSheet, mime: "image/png" },
        ...motionPreviews.map((preview) => ({ buffer: preview.image, mime: preview.mime })),
      ],
      prompt: buildVisualQaPrompt(
        "final",
        `All nine standard rows and the complete labeled 16-direction loop; deterministic validation passed. `
        + `The first image is the canonical identity, followed by standard/final/direction sheets and nine animated WebP previews in row order. Inspect actual playback for cadence, vertical travel, inert loops, wrong facing, reversal, size popping and baseline jumps. `
        + `If any action group is defective, list its complete row name in repairRows; never request a single-frame patch. `
        + `Continuity metrics are review evidence only: ${continuityWarnings.slice(0, 20).join(" | ") || "no metric warnings"}`,
      ),
      env: ctx.env,
      signal: ctx.signal,
    });
    if (finalQa.pass) break;
    if (directionAttempt >= 3) {
      throw new Error(`最终独立视觉质检经两轮自动修复后仍未通过：${finalQa.failures.join("；") || "角色一致性或动作连续性失败"}`);
    }
    const repairRows = repairRowsFromFinalQa(finalQa);
    finalRepairHistory.push({ attempt: directionAttempt, rows: repairRows, failures: finalQa.failures });
    const repairHint = finalQa.repairPrompt || finalQa.failures.join("；") || "修复指定动作组的身份、动作语义、节奏与连续性";
    await emit(ctx, "run.repairing", "repairing", 88, `最终视觉质检动作组修复 ${directionAttempt}/2`, { rows: repairRows, failures: finalQa.failures });

    const standardRowsSet = new Set(repairRows.filter((row): row is Exclude<FinalRepairRow, "look-a" | "look-b"> => row !== "look-a" && row !== "look-b"));
    // The two travel rows form one semantic pair.  If the right-facing source
    // is repaired, never leave a stale mirrored/independently-generated left
    // row beside it; regenerate the complete left group in the same repair
    // pass so cadence and asymmetric props remain synchronized.
    if (standardRowsSet.has("running-right")) standardRowsSet.add("running-left");
    const standardRows = [...standardRowsSet];
    // Horizontal locomotion is a coupled pair: repairing one side must not
    // leave a stale mirrored/independently-generated counterpart in the final
    // atlas.  Expand the requested scope to both complete rows.
    if (standardRows.includes("running-right") && !standardRows.includes("running-left")) standardRows.push("running-left");
    if (standardRows.includes("running-left") && !standardRows.includes("running-right")) standardRows.push("running-right");
    if (standardRows.length > 0) {
      const progressByState: Record<string, number> = { idle: 20, "running-right": 25, "running-left": 30, waving: 35, jumping: 40, failed: 45, waiting: 50, running: 55, review: 60 };
      const repaired = await mapWithConcurrency(standardRows, visualConcurrency, (state) => (
        runStandardRow(ctx, state, selected, progressByState[state] ?? 64, true, repairHint)
      ));
      repaired.forEach((result, index) => {
        const state = standardRows[index]!;
        if (state === "idle") idle = result;
        else if (state === "running-right") runningRight = result;
        else runningLeft = state === "running-left" ? result : runningLeft;
        if (state !== "idle" && state !== "running-right" && state !== "running-left") remaining.set(state, result);
        frames[state] = result.frames;
      });
      standard = await storeStandardAtlas(ctx, frames, true);

      // Direction references include the approved standard contact; refresh
      // the cardinal anchors as well whenever standard action art changes.
      cardinals = await runBoardJob(ctx, {
        key: "look-cardinals", kind: "look_cardinals", dependencies: ["look-mechanics", "standard-atlas"], inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
        prompt: buildCardinalPrompt(ctx.identity, mechanics), references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(standard.contact, "image/png", "standard-contact.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
        columns: 2, rows: 2, frameCount: 4, progress: 83, qaKind: "cardinals", qaContext: "修复后四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左", qaRepetitions: 3, force: true, repairHint,
      });
      cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals, true);
    }
    await regenerateDirectionRows(repairHint);
  }
  if (!validation || !despill || !blindValidation || !continuity || !directionRegistration?.ok || !finalQa?.pass) throw new Error("最终验证没有生成完整报告");
  const continuityWarnings = continuity.warnings.map((item) => item.message);
  await emit(ctx, "stage.completed", "validating", 94, "最终结构、方向盲测与视觉质检已通过", { warnings: [...validation.warnings, ...continuityWarnings, ...blindValidation.warnings, ...semantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`)] });

  await stage(ctx, "packaging", 94, "正在生成 Codex 安装包");
  const petId = `${ctx.identity.name}-${createHash("sha256").update(ctx.project.id).digest("hex").slice(0, 10)}`;
  const packaged = await createCodexPetPackage({ id: petId, displayName: ctx.identity.name, description: ctx.identity.description, spritesheet: finalAtlas });
  // Re-open the exact ZIP bytes that will be persisted.  This closes the
  // validation gap between the pre-package PNG checks and the WebP/ZIP bytes
  // consumed by Codex, and makes a malformed package a normal refundable run
  // failure instead of a deliverable that only fails at install time.
  const inspectedPackage = await inspectCodexPetZip(packaged.zip);
  if (inspectedPackage.manifest.spriteVersionNumber !== 2 || inspectedPackage.manifest.spritesheetPath !== "spritesheet.webp") {
    throw new Error("Codex v2 安装包结构验证失败");
  }
  const packagedValidation = await validatePetAtlas(packaged.spritesheet, ctx.identity.chromaKey);
  if (!packagedValidation.ok) {
    throw new Error(`Codex v2 WebP 图集验证失败：${packagedValidation.errors.join("；")}`);
  }
  const report = {
    ok: true,
    spriteVersionNumber: 2,
    requestedModel: "gpt-image-2",
    chromaKey: ctx.identity.chromaKey,
    cardinalAnchor: {
      artifactId: cardinalAnchor.artifact.id,
      sourceBoardArtifactId: cardinals.boardArtifact.id,
      directions: ["000", "090", "180", "270"],
      evidence: asRecord(cardinalAnchor.artifact.metadata).cardinalEvidence,
    },
    deterministic: validation,
    standardAtlasValidation: standard.validation,
    packagedSpritesheet: packagedValidation,
    chromaDespill: despill,
    directionRegistration,
    directionContinuity: continuity,
    row9PreGenerationGate: {
      passed: firstLookGate.pass,
      deterministicContinuity: firstLookGate.continuity,
    },
    row10PreGenerationGate: {
      passed: secondLookGate.pass,
      deterministicContinuity: secondLookGate.continuity,
      visual: secondLookGate.visual,
      failures: secondLookGate.failures,
    },
    finalRepairHistory,
    blindDirectionValidation: blindValidation,
    directionSemantics: semantics,
    finalVisualQa: finalQa,
    acceptableWarnings: [...validation.warnings, ...continuityWarnings, ...blindValidation.warnings, ...semantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`)],
  };
  const [spritesheetArtifact, packageArtifact, previewArtifact, directionArtifact, blindArtifact, qaArtifact] = await Promise.all([
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, kind: "spritesheet", name: "Codex v2 spritesheet.webp", buffer: packaged.spritesheet, mime: "image/webp", metadata: { petId: packaged.petId, spriteVersionNumber: 2, width: 1536, height: 2288 }, width: 1536, height: 2288, expiresAt: null }),
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, kind: "package", name: `${packaged.petId}.zip`, buffer: packaged.zip, mime: "application/zip", metadata: { petId: packaged.petId, spriteVersionNumber: 2 }, expiresAt: null }),
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, kind: "preview", name: "最终 Contact Sheet", buffer: contactSheet, mime: "image/png", expiresAt: null }),
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, kind: "direction_qa", name: "16 方向标注质检图", buffer: directionSheet, mime: "image/png", expiresAt: null }),
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, kind: "direction_blind_qa", name: "方向盲测图", buffer: blindSheet, mime: "image/png", expiresAt: null }),
    putJsonArtifact(ctx, { kind: "validation_report", name: "Codex v2 最终验证报告", value: report, expiresAt: null }),
  ]);
  const provider = await summarizeProviderUsage(ctx);
  const packagingUpdate = await ctx.prisma.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: "packaging", cancelRequested: false }, data: {
    spritesheetArtifactId: spritesheetArtifact.id,
    packageArtifactId: packageArtifact.id,
    previewArtifactId: previewArtifact.id,
    validationReport: { ...report, petId: packaged.petId, artifacts: { directionArtifactId: directionArtifact.id, blindArtifactId: blindArtifact.id, qaArtifactId: qaArtifact.id } } as unknown as Prisma.InputJsonValue,
    actualModels: provider.actualModels,
    usage: provider.usage as Prisma.InputJsonValue,
    progressPercent: 98,
    progressMessage: "安装包已生成，正在归档到 AI 产物知识库",
  } });
  if (packagingUpdate.count !== 1) throw new CodexPetLeaseLostError();
  await emit(ctx, "package.ready", "packaging", 98, "Codex v2 安装包已生成", { spritesheetArtifactId: spritesheetArtifact.id, packageArtifactId: packageArtifact.id, previewArtifactId: previewArtifact.id });

  await stage(ctx, "archiving", 98, "正在归档到 AI 产物知识库");
  return completeKnowledgeArchive(ctx);
}

export async function executeCodexPetRun(input: { runId: string; deps: CodexPetRunnerDeps }): Promise<CodexPetExecutionResult> {
  const { deps } = input;
  const env = deps.env ?? process.env;
  const initialRun = await deps.prisma.codexPetRun.findUnique({ where: { id: input.runId }, include: { project: true } });
  if (!initialRun) throw new Error("Codex pet run not found");
  if (initialRun.project.id !== initialRun.projectId || initialRun.project.userId !== initialRun.userId) {
    throw new Error("Codex pet run ownership mismatch");
  }
  // BullMQ delivery is at-least-once and older retained failed jobs may be
  // observed during an upgrade. Terminal database state is authoritative: a
  // failed/refunded or API-cancelled run must never regenerate artifacts,
  // emit another terminal event, or attempt another refund.
  if (initialRun.status === "ready" || initialRun.status === "failed" || initialRun.status === "cancelled") {
    return { status: initialRun.status, runId: initialRun.id };
  }
  // Waiting for an explicit user choice is a durable pause, not runnable
  // work. A duplicate Bull delivery (for example an old retained/stalled job)
  // must not claim the run and replay base generation while the workbench is
  // showing candidates. Auto-selection and explicit selection routes first
  // move the row back to a runnable stage, so they are unaffected.
  if (initialRun.status === "awaiting_base_review"
    && !initialRun.selectedBaseArtifactId
    && !initialRun.autoContinue
    && !initialRun.cancelRequested) {
    return { status: "awaiting_base_review", runId: initialRun.id };
  }
  // Queue delivery must never start visual work before the external package
  // charge is durably confirmed and the activation transaction has committed.
  if (initialRun.billingChargeStatus !== "charged" || !initialRun.billingActivatedAt) {
    throw new Error("Codex pet run billing is not activated");
  }
  // A caller that does not supply a worker identity is generally a direct
  // invocation (tests, maintenance, or a one-off repair). Give each such
  // invocation a unique lease token so two concurrent calls in one process
  // still obey the same CAS rule. Queue workers supply their own unique token
  // and use it for the heartbeat below.
  const workerId = deps.workerId ?? `${WORKER_ID}:${randomUUID().slice(0, 12)}`;
  const claimed = await claimRunLease(deps.prisma, input.runId, workerId, env, initialRun.projectId, initialRun.userId);
  if (!claimed.claimed) {
    const fresh = claimed.run;
    if (!fresh) throw new Error("Codex pet run not found");
    if (fresh.status === "ready" || fresh.status === "failed" || fresh.status === "cancelled") {
      return { status: fresh.status, runId: fresh.id };
    }
    // Another live worker owns the run. Do not invoke finalizeFailure or
    // cancellation here; doing so would race the owner and could trigger a
    // duplicate refund. The queue/maintenance pass will retry after a stale
    // lease expires if necessary.
    return { status: "busy", runId: fresh.id };
  }
  const run = claimed.run;
  if (!run) throw new Error("Codex pet run disappeared after lease claim");
  const snapshot = asRecord(run.inputSnapshot);
  const referenceAssetIds = Array.isArray(snapshot.referenceAssetIds)
    ? snapshot.referenceAssetIds.filter((value): value is string => typeof value === "string")
    : [...run.project.referenceAssetIds];
  const snapshotString = (key: string, fallback: string) => typeof snapshot[key] === "string" ? snapshot[key] as string : fallback;
  const identity = {
    name: snapshotString("name", run.project.name),
    description: snapshotString("description", run.project.description),
    prompt: snapshotString("prompt", run.project.prompt),
    stylePreset: snapshotString("stylePreset", run.project.stylePreset),
    styleNotes: snapshotString("styleNotes", run.project.styleNotes),
  };
  let loadedReferences: Array<{ buffer: Buffer; mime: string; filename: string }> = [];
  let chromaKey = run.colorKey || "#ff00ff";
  try {
    const referenceAssets = referenceAssetIds.length
      ? await deps.prisma.imageAsset.findMany({ where: { userId: run.userId, id: { in: referenceAssetIds } } })
      : [];
    if (referenceAssets.length !== referenceAssetIds.length) throw new Error("参考图不存在或无权使用");
    loadedReferences = await Promise.all(referenceAssetIds.map(async (id) => {
      const asset = referenceAssets.find((candidate) => candidate.id === id);
      if (!asset) throw new Error("参考图不存在或无权使用");
      const loaded = await deps.loadReferenceAsset(asset);
      return { ...loaded, filename: `${asset.id}.${loaded.mime.includes("webp") ? "webp" : "png"}` };
    }));
    chromaKey = run.colorKey || (loadedReferences.length
      ? await chooseChromaKey(loadedReferences.map((reference) => reference.buffer))
      : "#ff00ff");
    if (!run.colorKey) {
      const colorKeyClaim = await deps.prisma.codexPetRun.updateMany({ where: { id: run.id, projectId: run.project.id, userId: run.userId, workerId }, data: { colorKey: chromaKey, heartbeatAt: new Date() } });
      if (colorKeyClaim.count !== 1) throw new CodexPetLeaseLostError();
    }
  } catch (error) {
    if (!(error instanceof CodexPetLeaseLostError)) {
      await finalizeClaimedSetupFailure({ prisma: deps.prisma, appendEvent: deps.appendEvent, billing: deps.billing, project: run.project, runId: run.id, workerId, error }).catch(() => undefined);
    }
    throw error;
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) controller.abort(deps.signal.reason);
  else deps.signal?.addEventListener("abort", abortFromParent, { once: true });
  let checking = false;
  const monitor = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void deps.prisma.codexPetRun.findFirst({ where: { id: run.id, projectId: run.project.id, userId: run.userId }, select: { cancelRequested: true, status: true, workerId: true } })
      .then((fresh) => {
        if (!fresh || fresh.cancelRequested || fresh.status === "cancelled") controller.abort(new CodexPetCancelledError());
        else if ((CODEX_PET_ACTIVE_STATUSES as readonly string[]).includes(fresh.status) && fresh.workerId !== workerId) controller.abort(new CodexPetLeaseLostError());
      })
      .finally(() => { checking = false; });
  }, 1_000);
  const configuredHeartbeat = Number(env.CODEX_PET_HEARTBEAT_MS);
  const leaseHeartbeatMs = Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0
    ? configuredHeartbeat
    : Math.min(10_000, Math.max(1_000, Math.floor(staleRunMs(env) / 3)));
  const leaseHeartbeat = setInterval(() => {
    void deps.prisma.codexPetRun.updateMany({
      where: {
        id: run.id,
        workerId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        billingChargeStatus: "charged",
        billingActivatedAt: { not: null },
      },
      data: { heartbeatAt: new Date() },
    }).then((updated) => {
      if (updated.count !== 1 && !controller.signal.aborted) controller.abort(new CodexPetLeaseLostError());
    }).catch(() => undefined);
  }, leaseHeartbeatMs);
  const ctx: RunnerContext = {
    ...deps,
    env,
    workerId,
    signal: controller.signal,
    project: run.project,
    runId: run.id,
    referenceAssetIds,
    identity: {
      ...identity,
      chromaKey,
    },
    userReferences: loadedReferences.map((loaded) => imageInput(loaded.buffer, loaded.mime, loaded.filename)),
    generate: deps.visual?.generate ?? generateCodexPetVisual,
    qa: deps.visual?.qa ?? runCodexPetVisualQa,
    qaConsensus: deps.visual?.qaConsensus ?? runCodexPetVisualQaConsensus,
    blindQa: deps.visual?.blindQa ?? runBlindDirectionQa,
    directionSemantics: deps.visual?.directionSemantics ?? runLabeledDirectionSemantics,
    lookMechanics: deps.visual?.lookMechanics ?? generateCodexPetLookMechanics,
  };
  try {
    return await executeRun(ctx);
  } catch (error) {
    if (error instanceof CodexPetArchiveDeferredError) {
      if (await releaseDeferredArchiveLease(ctx, error)) {
        return { status: "archiving", runId: run.id };
      }
      const latest = await deps.prisma.codexPetRun.findFirst({
        where: { id: run.id, projectId: run.project.id, userId: run.userId },
        select: { status: true, cancelRequested: true },
      });
      if (latest?.cancelRequested || latest?.status === "cancelled") {
        await finalizeCancellation(ctx);
        return { status: "cancelled", runId: run.id };
      }
      if (latest?.status === "ready" || latest?.status === "failed") {
        return { status: latest.status, runId: run.id };
      }
      return { status: "busy", runId: run.id };
    }
    if (error instanceof CodexPetLeaseLostError || controller.signal.reason instanceof CodexPetLeaseLostError) {
      const latest = await deps.prisma.codexPetRun.findFirst({ where: { id: run.id, projectId: run.project.id, userId: run.userId }, select: { status: true } });
      if (latest?.status === "ready" || latest?.status === "failed" || latest?.status === "cancelled") {
        return { status: latest.status, runId: run.id };
      }
      return { status: "busy", runId: run.id };
    }
    if (error instanceof CodexPetCancelledError || controller.signal.reason instanceof CodexPetCancelledError) {
      await finalizeCancellation(ctx);
      return { status: "cancelled", runId: run.id };
    }
    // Cancellation may be persisted just after an upstream/QA error but
    // before the monitor tick observes it. Re-read the row so that the
    // cancellation/refund policy wins that race instead of recording a
    // system failure.
    const latestBeforeFailure = await deps.prisma.codexPetRun.findFirst({ where: { id: run.id, projectId: run.project.id, userId: run.userId }, select: { cancelRequested: true, status: true } });
    if (latestBeforeFailure?.cancelRequested || latestBeforeFailure?.status === "cancelled") {
      await finalizeCancellation(ctx);
      return { status: "cancelled", runId: run.id };
    }
    await finalizeFailure(ctx, error);
    throw error;
  } finally {
    clearInterval(monitor);
    clearInterval(leaseHeartbeat);
    deps.signal?.removeEventListener("abort", abortFromParent);
  }
}
