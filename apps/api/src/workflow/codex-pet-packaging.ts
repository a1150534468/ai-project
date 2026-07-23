import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Prisma, type CodexPetArtifact, type CodexPetJob, type PrismaClient } from "@prisma/client";
import {
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  inspectCodexPetZip,
  validatePetAtlas,
} from "@ai-assistant/codex-pet-pipeline";
import type { CodexPetArtifactPutInput, CodexPetArtifactStore } from "./codex-pet-runner.js";
import { codexPetValidationPassed } from "./codex-pet-delivery-validation.js";

const FINAL_PACKAGE_JOB_KEY = "final-package";
const FINAL_PACKAGE_JOB_VERSION = 1;
const FINAL_PACKAGE_INPUT_SCHEMA = "codex-pet-final-package-v1";
const FINAL_PACKAGE_MAX_ATTEMPTS = 10;
const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60_000;

const FINAL_ARTIFACT_KEYS = [
  "spritesheet",
  "package",
  "preview",
  "directionQa",
  "directionBlindQa",
  "validationReport",
] as const;

type FinalArtifactKey = (typeof FINAL_ARTIFACT_KEYS)[number];
type CheckpointKey = "sourceAtlas" | FinalArtifactKey;

interface ArtifactCheckpoint {
  readonly artifactId: string;
  readonly checksum: string;
  readonly kind: string;
  readonly sizeBytes: number;
}

interface FinalPackageJobOutput {
  readonly version: typeof FINAL_PACKAGE_JOB_VERSION;
  readonly inputRevision: string;
  readonly petId: string;
  readonly displayName: string;
  readonly description: string;
  readonly report: Record<string, unknown>;
  readonly reportChecksum: string;
  readonly artifacts: Partial<Record<CheckpointKey, ArtifactCheckpoint>>;
}

export interface CodexPetFinalPackageSeed {
  readonly petId: string;
  readonly finalAtlas: Buffer;
  readonly spritesheet: Buffer;
  readonly zip: Buffer;
  readonly contactSheet: Buffer;
  readonly directionSheet: Buffer;
  readonly blindSheet: Buffer;
  readonly report: Record<string, unknown>;
  readonly inputArtifactIds?: readonly string[];
}

export interface CodexPetDurablePackagingInput {
  readonly prisma: PrismaClient;
  readonly artifacts: CodexPetArtifactStore;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workerId: string;
  readonly displayName: string;
  readonly description: string;
  readonly chromaKey: string;
  readonly provider: {
    readonly actualModels: readonly string[];
    readonly usage: Record<string, number>;
  };
  readonly seed?: CodexPetFinalPackageSeed;
}

export interface CodexPetDurablePackagingResult {
  readonly jobId: string;
  readonly recovered: boolean;
  readonly petId: string;
  readonly spritesheetArtifactId: string;
  readonly packageArtifactId: string;
  readonly previewArtifactId: string;
  readonly directionArtifactId: string;
  readonly blindArtifactId: string;
  readonly validationArtifactId: string;
}

export class CodexPetPackagingDeferredError extends Error {
  constructor(
    message: string,
    readonly attempt: number,
    readonly maxAttempts: number,
  ) {
    super(message);
    this.name = "CodexPetPackagingDeferredError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().flatMap((key) => (
      source[key] === undefined ? [] : [[key, canonicalJson(source[key])]]
    )));
  }
  // PostgreSQL jsonb preserves numeric value, not the exact shortest IEEE-754
  // decimal spelling emitted by V8. Prisma can therefore round a 17-digit
  // tail by one ULP on the write/read boundary. Bind reports at 15 significant
  // digits so the durable artifact checksum is stable across that round trip.
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : Number(value.toPrecision(15));
  }
  return value;
}

function reportBytes(report: Record<string, unknown>): Buffer {
  // PostgreSQL jsonb does not preserve insertion order. Canonical keys keep
  // the validation checksum stable across a process/database round trip.
  return Buffer.from(`${JSON.stringify(canonicalJson(report), null, 2)}\n`, "utf8");
}

export function codexPetFinalPackageInputRevision(input: {
  readonly finalAtlas: Buffer;
  readonly report: Record<string, unknown>;
}): { readonly revision: string; readonly finalAtlasChecksum: string; readonly reportChecksum: string } {
  const finalAtlasChecksum = checksum(input.finalAtlas);
  const reportChecksum = checksum(reportBytes(input.report));
  const revision = createHash("sha256").update(JSON.stringify({
    schema: FINAL_PACKAGE_INPUT_SCHEMA,
    finalAtlasChecksum,
    reportChecksum,
  })).digest("hex");
  return { revision, finalAtlasChecksum, reportChecksum };
}

function parseJobOutput(job: CodexPetJob): FinalPackageJobOutput | null {
  const output = asRecord(job.output);
  const report = asRecord(output.report);
  const artifacts = asRecord(output.artifacts);
  if (output.version !== FINAL_PACKAGE_JOB_VERSION
    || typeof output.inputRevision !== "string"
    || typeof output.petId !== "string"
    || typeof output.displayName !== "string"
    || typeof output.description !== "string"
    || typeof output.reportChecksum !== "string"
    || Object.keys(report).length === 0) return null;
  const parsedArtifacts: Partial<Record<CheckpointKey, ArtifactCheckpoint>> = {};
  for (const key of ["sourceAtlas", ...FINAL_ARTIFACT_KEYS] as const) {
    const value = asRecord(artifacts[key]);
    if (typeof value.artifactId === "string"
      && typeof value.checksum === "string"
      && typeof value.kind === "string"
      && typeof value.sizeBytes === "number") {
      parsedArtifacts[key] = {
        artifactId: value.artifactId,
        checksum: value.checksum,
        kind: value.kind,
        sizeBytes: value.sizeBytes,
      };
    }
  }
  return {
    version: FINAL_PACKAGE_JOB_VERSION,
    inputRevision: output.inputRevision,
    petId: output.petId,
    displayName: output.displayName,
    description: output.description,
    report,
    reportChecksum: output.reportChecksum,
    artifacts: parsedArtifacts,
  };
}

function jobInputRevision(job: CodexPetJob): string | null {
  const input = asRecord(job.input);
  return typeof input.inputRevision === "string" ? input.inputRevision : null;
}

async function markArtifactsSuperseded(
  prisma: PrismaClient,
  jobId: string,
  artifactIds?: readonly string[],
): Promise<void> {
  await prisma.codexPetArtifact.updateMany({
    where: {
      jobId,
      status: "ready",
      ...(artifactIds ? { id: { in: [...artifactIds] } } : {}),
    },
    data: {
      status: "superseded",
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    },
  });
}

async function initializeJob(input: CodexPetDurablePackagingInput): Promise<{ job: CodexPetJob; output: FinalPackageJobOutput; recovered: boolean }> {
  if (!input.seed) {
    const job = await input.prisma.codexPetJob.findUnique({
      where: { runId_key: { runId: input.runId, key: FINAL_PACKAGE_JOB_KEY } },
    });
    if (!job || job.projectId !== input.projectId || job.userId !== input.userId) {
      throw new Error("可恢复的最终打包任务不存在");
    }
    const output = parseJobOutput(job);
    if (!output || jobInputRevision(job) !== output.inputRevision) {
      throw new Error("最终打包任务缺少可恢复的输入快照");
    }
    if (checksum(reportBytes(output.report)) !== output.reportChecksum) {
      throw new Error("最终打包验证报告 checksum 不匹配");
    }
    return { job, output, recovered: true };
  }

  const binding = codexPetFinalPackageInputRevision({
    finalAtlas: input.seed.finalAtlas,
    report: input.seed.report,
  });
  let job = await input.prisma.codexPetJob.upsert({
    where: { runId_key: { runId: input.runId, key: FINAL_PACKAGE_JOB_KEY } },
    create: {
      projectId: input.projectId,
      runId: input.runId,
      userId: input.userId,
      key: FINAL_PACKAGE_JOB_KEY,
      kind: "final_package",
      dependencyKeys: ["standard-atlas", "look-a", "look-b"],
      maxAttempts: FINAL_PACKAGE_MAX_ATTEMPTS,
      inputArtifactIds: [...(input.seed.inputArtifactIds ?? [])],
      input: {
        version: FINAL_PACKAGE_JOB_VERSION,
        inputRevision: binding.revision,
        finalAtlasChecksum: binding.finalAtlasChecksum,
        validationReportChecksum: binding.reportChecksum,
      },
      output: {
        version: FINAL_PACKAGE_JOB_VERSION,
        inputRevision: binding.revision,
        petId: input.seed.petId,
        displayName: input.displayName,
        description: input.description,
        report: input.seed.report as Prisma.InputJsonObject,
        reportChecksum: binding.reportChecksum,
        artifacts: {},
      } as Prisma.InputJsonObject,
    },
    update: { maxAttempts: FINAL_PACKAGE_MAX_ATTEMPTS },
  });
  if (job.projectId !== input.projectId || job.userId !== input.userId || job.runId !== input.runId) {
    throw new Error("最终打包任务 ownership 不匹配");
  }
  const existingRevision = jobInputRevision(job);
  if (existingRevision !== binding.revision) {
    await input.prisma.$transaction(async (tx) => {
      await tx.codexPetArtifact.updateMany({
        where: { jobId: job.id, status: "ready" },
        data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
      });
      await tx.codexPetJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          attempt: 0,
          inputArtifactIds: [...(input.seed?.inputArtifactIds ?? [])],
          outputArtifactIds: [],
          input: {
            version: FINAL_PACKAGE_JOB_VERSION,
            inputRevision: binding.revision,
            finalAtlasChecksum: binding.finalAtlasChecksum,
            validationReportChecksum: binding.reportChecksum,
          },
          output: {
            version: FINAL_PACKAGE_JOB_VERSION,
            inputRevision: binding.revision,
            petId: input.seed!.petId,
            displayName: input.displayName,
            description: input.description,
            report: input.seed!.report as Prisma.InputJsonObject,
            reportChecksum: binding.reportChecksum,
            artifacts: {},
          } as Prisma.InputJsonObject,
          error: null,
          workerId: null,
          startedAt: null,
          completedAt: null,
        },
      });
    });
    job = await input.prisma.codexPetJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  const output = parseJobOutput(job);
  if (!output) throw new Error("最终打包任务初始化失败");
  return { job, output, recovered: job.status !== "queued" || Object.keys(output.artifacts).length > 0 };
}

async function claimJob(input: CodexPetDurablePackagingInput, job: CodexPetJob): Promise<CodexPetJob> {
  if (job.status === "completed") return job;
  const attempt = job.status === "running" && job.attempt > 0 ? job.attempt : job.attempt + 1;
  if (attempt > job.maxAttempts) throw new Error("最终打包重试次数已耗尽");
  const claimed = await input.prisma.codexPetJob.updateMany({
    where: {
      id: job.id,
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      status: { in: ["queued", "running"] },
    },
    data: {
      status: "running",
      attempt,
      workerId: input.workerId,
      startedAt: job.startedAt ?? new Date(),
      completedAt: null,
      error: null,
    },
  });
  if (claimed.count !== 1) throw new Error("最终打包任务已被其他 Worker 接管");
  return input.prisma.codexPetJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function enterPackagingStage(input: CodexPetDurablePackagingInput): Promise<void> {
  const changed = await input.prisma.$transaction(async (tx) => {
    const run = await tx.codexPetRun.updateMany({
      where: {
        id: input.runId,
        projectId: input.projectId,
        userId: input.userId,
        workerId: input.workerId,
        status: { in: ["validating", "repairing", "packaging"] },
        cancelRequested: false,
      },
      data: {
        status: "packaging",
        progressStage: "packaging",
        progressPercent: 94,
        progressMessage: "正在生成 Codex 安装包",
        heartbeatAt: new Date(),
        error: null,
      },
    });
    if (run.count !== 1) return false;
    await tx.codexPetProject.updateMany({
      where: { id: input.projectId, userId: input.userId, status: { not: "deleting" } },
      data: { status: "packaging" },
    });
    return true;
  });
  if (!changed) throw new Error("最终打包阶段 lease 已失效");
}

async function verifiedCandidate(
  input: CodexPetDurablePackagingInput,
  artifact: CodexPetArtifact,
  expectedKind: string,
  expectedChecksum?: string,
  accept?: (buffer: Buffer) => Promise<boolean>,
): Promise<{ artifact: CodexPetArtifact; buffer: Buffer } | null> {
  if (artifact.jobId === null
    || artifact.runId !== input.runId
    || artifact.projectId !== input.projectId
    || artifact.userId !== input.userId
    || artifact.kind !== expectedKind
    || artifact.status !== "ready"
    || !artifact.checksum) return null;
  try {
    const buffer = await input.artifacts.load(artifact);
    const actualChecksum = checksum(buffer);
    if (actualChecksum !== artifact.checksum) return null;
    if (expectedChecksum && actualChecksum !== expectedChecksum && !(await accept?.(buffer))) return null;
    if (!expectedChecksum && accept && !(await accept(buffer))) return null;
    return { artifact, buffer };
  } catch {
    return null;
  }
}

async function checkpointArtifact(input: {
  readonly ctx: CodexPetDurablePackagingInput;
  readonly job: CodexPetJob;
  readonly output: FinalPackageJobOutput;
  readonly key: CheckpointKey;
  readonly put: CodexPetArtifactPutInput;
  readonly acceptExisting?: (buffer: Buffer) => Promise<boolean>;
}): Promise<{ artifact: CodexPetArtifact; buffer: Buffer; output: FinalPackageJobOutput }> {
  const expectedChecksum = checksum(input.put.buffer);
  const checkpoint = input.output.artifacts[input.key];
  const candidates = await input.ctx.prisma.codexPetArtifact.findMany({
    where: {
      jobId: input.job.id,
      runId: input.ctx.runId,
      projectId: input.ctx.projectId,
      userId: input.ctx.userId,
      kind: input.put.kind,
      status: "ready",
    },
    orderBy: { createdAt: "asc" },
  });
  if (checkpoint) {
    candidates.sort((left, right) => left.id === checkpoint.artifactId ? -1 : right.id === checkpoint.artifactId ? 1 : 0);
  }
  const recoveryChecksum = input.job.status === "completed" && checkpoint
    ? checkpoint.checksum
    : expectedChecksum;
  let selected: { artifact: CodexPetArtifact; buffer: Buffer } | null = null;
  const invalidIds: string[] = [];
  for (const candidate of candidates) {
    const verified = await verifiedCandidate(
      input.ctx,
      candidate,
      input.put.kind,
      recoveryChecksum,
      input.acceptExisting,
    );
    if (verified && !selected) selected = verified;
    else invalidIds.push(candidate.id);
  }
  if (invalidIds.length) await markArtifactsSuperseded(input.ctx.prisma, input.job.id, invalidIds);
  if (!selected && input.job.status === "completed") {
    throw new Error(`已完成的最终打包 checkpoint ${input.key} 缺失或损坏`);
  }
  if (!selected) {
    const artifact = await input.ctx.artifacts.put({
      ...input.put,
      jobId: input.job.id,
      metadata: {
        ...(input.put.metadata ?? {}),
        finalPackageRevision: input.output.inputRevision,
        finalPackageArtifactKey: input.key,
      },
    });
    selected = await verifiedCandidate(
      input.ctx,
      artifact,
      input.put.kind,
      recoveryChecksum,
      input.acceptExisting,
    );
    if (!selected) throw new Error(`最终打包产物 ${input.key} checksum 校验失败`);
  }
  const nextOutput: FinalPackageJobOutput = {
    ...input.output,
    artifacts: {
      ...input.output.artifacts,
      [input.key]: {
        artifactId: selected.artifact.id,
        checksum: checksum(selected.buffer),
        kind: selected.artifact.kind,
        sizeBytes: selected.buffer.byteLength,
      },
    },
  };
  if (input.job.status === "completed") {
    // Atomic completion normally moves the Run to archiving in the same
    // transaction. This branch tolerates a manually repaired/legacy row at
    // packaging with a fully completed checkpoint without rewriting the Job.
    return { ...selected, output: nextOutput };
  }
  const checkpointed = await input.ctx.prisma.codexPetJob.updateMany({
    where: {
      id: input.job.id,
      runId: input.ctx.runId,
      projectId: input.ctx.projectId,
      userId: input.ctx.userId,
      workerId: input.ctx.workerId,
      status: "running",
    },
    data: { output: nextOutput as unknown as Prisma.InputJsonValue, error: null },
  });
  if (checkpointed.count !== 1) throw new Error("最终打包 checkpoint lease 已失效");
  return { ...selected, output: nextOutput };
}

async function recoverUncheckpointedArtifact(input: {
  readonly ctx: CodexPetDurablePackagingInput;
  readonly job: CodexPetJob;
  readonly output: FinalPackageJobOutput;
  readonly key: CheckpointKey;
  readonly kind: string;
  readonly expectedChecksum?: string;
  readonly accept?: (buffer: Buffer) => Promise<boolean>;
}): Promise<{ artifact: CodexPetArtifact; buffer: Buffer; output: FinalPackageJobOutput } | null> {
  const candidates = await input.ctx.prisma.codexPetArtifact.findMany({
    where: {
      jobId: input.job.id,
      runId: input.ctx.runId,
      projectId: input.ctx.projectId,
      userId: input.ctx.userId,
      kind: input.kind,
      status: "ready",
    },
    orderBy: { createdAt: "asc" },
  });
  let selected: { artifact: CodexPetArtifact; buffer: Buffer } | null = null;
  const rejected: string[] = [];
  for (const candidate of candidates) {
    const verified = await verifiedCandidate(
      input.ctx,
      candidate,
      input.kind,
      input.expectedChecksum,
      input.accept,
    );
    if (verified && !selected) selected = verified;
    else rejected.push(candidate.id);
  }
  if (rejected.length) await markArtifactsSuperseded(input.ctx.prisma, input.job.id, rejected);
  if (!selected) return null;
  const nextOutput: FinalPackageJobOutput = {
    ...input.output,
    artifacts: {
      ...input.output.artifacts,
      [input.key]: {
        artifactId: selected.artifact.id,
        checksum: checksum(selected.buffer),
        kind: selected.artifact.kind,
        sizeBytes: selected.buffer.byteLength,
      },
    },
  };
  if (input.job.status !== "completed") {
    const checkpointed = await input.ctx.prisma.codexPetJob.updateMany({
      where: {
        id: input.job.id,
        runId: input.ctx.runId,
        projectId: input.ctx.projectId,
        userId: input.ctx.userId,
        workerId: input.ctx.workerId,
        status: "running",
      },
      data: { output: nextOutput as unknown as Prisma.InputJsonValue, error: null },
    });
    if (checkpointed.count !== 1) throw new Error("最终打包 orphan checkpoint lease 已失效");
  }
  return { ...selected, output: nextOutput };
}

async function findCheckpointArtifact(
  input: CodexPetDurablePackagingInput,
  job: CodexPetJob,
  output: FinalPackageJobOutput,
  key: CheckpointKey,
): Promise<{ artifact: CodexPetArtifact; buffer: Buffer } | null> {
  const checkpoint = output.artifacts[key];
  if (!checkpoint) return null;
  const artifact = await input.prisma.codexPetArtifact.findFirst({
    where: {
      id: checkpoint.artifactId,
      jobId: job.id,
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      kind: checkpoint.kind,
      status: "ready",
      checksum: checkpoint.checksum,
    },
  });
  return artifact ? verifiedCandidate(input, artifact, checkpoint.kind, checkpoint.checksum) : null;
}

async function markJobDeferred(input: CodexPetDurablePackagingInput, job: CodexPetJob, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : "最终打包暂时失败";
  const terminal = job.attempt >= job.maxAttempts;
  await input.prisma.codexPetJob.updateMany({
    where: { id: job.id, runId: input.runId, projectId: input.projectId, userId: input.userId },
    data: {
      status: terminal ? "failed" : "queued",
      workerId: null,
      error: message.slice(0, 1_000),
      completedAt: terminal ? new Date() : null,
    },
  }).catch(() => undefined);
  if (terminal) throw error;
  throw new CodexPetPackagingDeferredError(message, Math.max(1, job.attempt), job.maxAttempts);
}

export async function persistOrResumeCodexPetFinalPackage(
  input: CodexPetDurablePackagingInput,
): Promise<CodexPetDurablePackagingResult | null> {
  let initialized: Awaited<ReturnType<typeof initializeJob>>;
  try {
    initialized = await initializeJob(input);
  } catch (error) {
    // A legacy run can be left at packaging before this durable Job existed.
    // Returning null lets the runner replay the old graph once and establish
    // the new checkpoint; a run with a corrupt/incomplete new Job must not be
    // silently treated as legacy.
    if (!input.seed) {
      const existing = await input.prisma.codexPetJob.findUnique({
        where: { runId_key: { runId: input.runId, key: FINAL_PACKAGE_JOB_KEY } },
        select: { id: true },
      });
      if (!existing) return null;
    }
    throw error;
  }
  if (!codexPetValidationPassed(initialized.output.report)) {
    throw new Error("最终打包验证报告不满足可选视觉模型交付合同");
  }
  if (!input.seed) {
    const recoverableArtifacts = await input.prisma.codexPetArtifact.count({
      where: {
        jobId: initialized.job.id,
        runId: input.runId,
        projectId: input.projectId,
        userId: input.userId,
        kind: { in: ["package_source_atlas", "spritesheet"] },
        status: "ready",
      },
    });
    // The worker may have failed before the first source write. There are no
    // bytes from which packaging can resume, so let the legacy graph replay
    // once and recreate the validated source rather than exhausting package
    // retries forever.
    if (recoverableArtifacts === 0) return null;
  }
  let job = await claimJob(input, initialized.job);
  let output = initialized.output;
  try {
    await enterPackagingStage(input);

    let source = await findCheckpointArtifact(input, job, output, "sourceAtlas");
    if (!source && !input.seed) {
      const expectedSourceChecksum = asRecord(job.input).finalAtlasChecksum;
      const recovered = await recoverUncheckpointedArtifact({
        ctx: input,
        job,
        output,
        key: "sourceAtlas",
        kind: "package_source_atlas",
        expectedChecksum: typeof expectedSourceChecksum === "string" ? expectedSourceChecksum : undefined,
      });
      if (recovered) {
        source = recovered;
        output = recovered.output;
      }
    }
    if (!source && input.seed) {
      const stored = await checkpointArtifact({
        ctx: input,
        job,
        output,
        key: "sourceAtlas",
        put: {
          userId: input.userId,
          projectId: input.projectId,
          runId: input.runId,
          kind: "package_source_atlas",
          name: "已通过最终质检的 v2 PNG 图集",
          buffer: input.seed.finalAtlas,
          mime: "image/png",
          width: 1536,
          height: 2288,
          expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
        },
      });
      source = stored;
      output = stored.output;
    }

    let existingSpritesheet = await findCheckpointArtifact(input, job, output, "spritesheet");
    if (!existingSpritesheet && !input.seed) {
      const recovered = await recoverUncheckpointedArtifact({
        ctx: input,
        job,
        output,
        key: "spritesheet",
        kind: "spritesheet",
        accept: async (buffer) => (await validatePetAtlas(buffer, input.chromaKey)).ok,
      });
      if (recovered) {
        existingSpritesheet = recovered;
        output = recovered.output;
      }
    }
    const sourceBuffer = source?.buffer ?? existingSpritesheet?.buffer;
    if (!sourceBuffer) throw new Error("最终打包缺少可恢复的已验证图集 checkpoint");

    const rebuilt = input.seed ?? await (async () => {
      const packaged = await createCodexPetPackage({
        id: output.petId,
        displayName: output.displayName,
        description: output.description,
        spritesheet: sourceBuffer,
      });
      const [contactSheet, directionSheet, blind] = await Promise.all([
        createAtlasContactSheet(packaged.spritesheet),
        createDirectionQaSheet(packaged.spritesheet),
        createDirectionBlindQaSheet(packaged.spritesheet),
      ]);
      return {
        petId: output.petId,
        finalAtlas: sourceBuffer,
        spritesheet: packaged.spritesheet,
        zip: packaged.zip,
        contactSheet,
        directionSheet,
        blindSheet: blind.image,
        report: output.report,
      } satisfies CodexPetFinalPackageSeed;
    })();

    const packagedValidation = await validatePetAtlas(rebuilt.spritesheet, input.chromaKey);
    if (!packagedValidation.ok) throw new Error(`Codex v2 WebP 图集验证失败：${packagedValidation.errors.join("；")}`);
    const inspected = await inspectCodexPetZip(rebuilt.zip);
    if (inspected.manifest.id !== output.petId
      || inspected.manifest.spriteVersionNumber !== 2
      || inspected.manifest.spritesheetPath !== "spritesheet.webp") {
      throw new Error("Codex v2 安装包结构验证失败");
    }

    const specs: Array<{
      readonly key: FinalArtifactKey;
      readonly put: CodexPetArtifactPutInput;
      readonly acceptExisting?: (buffer: Buffer) => Promise<boolean>;
    }> = [
      {
        key: "spritesheet",
        put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "spritesheet", name: "Codex v2 spritesheet.webp", buffer: rebuilt.spritesheet, mime: "image/webp", metadata: { petId: output.petId, spriteVersionNumber: 2, width: 1536, height: 2288 }, width: 1536, height: 2288, expiresAt: null },
        acceptExisting: async (buffer) => (await validatePetAtlas(buffer, input.chromaKey)).ok,
      },
      {
        key: "package",
        put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "package", name: `${output.petId}.zip`, buffer: rebuilt.zip, mime: "application/zip", metadata: { petId: output.petId, spriteVersionNumber: 2 }, expiresAt: null },
        acceptExisting: async (buffer) => {
          const value = await inspectCodexPetZip(buffer);
          return value.manifest.id === output.petId && value.manifest.spriteVersionNumber === 2;
        },
      },
      { key: "preview", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "preview", name: "最终 Contact Sheet", buffer: rebuilt.contactSheet, mime: "image/png", expiresAt: null } },
      { key: "directionQa", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "direction_qa", name: "16 方向标注质检图", buffer: rebuilt.directionSheet, mime: "image/png", expiresAt: null } },
      { key: "directionBlindQa", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "direction_blind_qa", name: "方向盲测图", buffer: rebuilt.blindSheet, mime: "image/png", expiresAt: null } },
      { key: "validationReport", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "validation_report", name: "Codex v2 最终验证报告", buffer: reportBytes(output.report), mime: "application/json", expiresAt: null } },
    ];

    const stored = new Map<FinalArtifactKey, { artifact: CodexPetArtifact; buffer: Buffer }>();
    for (const spec of specs) {
      const checkpointed = await checkpointArtifact({
        ctx: input,
        job,
        output,
        key: spec.key,
        put: spec.put,
        acceptExisting: spec.acceptExisting,
      });
      output = checkpointed.output;
      stored.set(spec.key, checkpointed);
    }

    const sprite = stored.get("spritesheet")!;
    const packageArtifact = stored.get("package")!;
    const preview = stored.get("preview")!;
    const direction = stored.get("directionQa")!;
    const blind = stored.get("directionBlindQa")!;
    const validationArtifact = stored.get("validationReport")!;
    if (!(await validatePetAtlas(sprite.buffer, input.chromaKey)).ok) throw new Error("持久化 WebP 图集复验失败");
    const persistedZip = await inspectCodexPetZip(packageArtifact.buffer);
    if (persistedZip.manifest.id !== output.petId || persistedZip.manifest.spriteVersionNumber !== 2) throw new Error("持久化 ZIP 复验失败");
    if (checksum(validationArtifact.buffer) !== output.reportChecksum) throw new Error("持久化验证报告复验失败");

    const finalReport = {
      ...output.report,
      petId: output.petId,
      artifacts: {
        directionArtifactId: direction.artifact.id,
        blindArtifactId: blind.artifact.id,
        qaArtifactId: validationArtifact.artifact.id,
      },
    };
    const completedOutput: FinalPackageJobOutput = {
      ...output,
      artifacts: output.artifacts,
    };
    await input.prisma.$transaction(async (tx) => {
      if (job.status !== "completed") {
        const completedJob = await tx.codexPetJob.updateMany({
          where: {
            id: job.id,
            runId: input.runId,
            projectId: input.projectId,
            userId: input.userId,
            workerId: input.workerId,
            status: "running",
          },
          data: {
            status: "completed",
            output: completedOutput as unknown as Prisma.InputJsonValue,
            outputArtifactIds: FINAL_ARTIFACT_KEYS.map((key) => output.artifacts[key]!.artifactId),
            completedAt: new Date(),
            workerId: null,
            error: null,
          },
        });
        if (completedJob.count !== 1) throw new Error("最终打包 Job 提交时 lease 已失效");
      }
      const completedRun = await tx.codexPetRun.updateMany({
        where: {
          id: input.runId,
          projectId: input.projectId,
          userId: input.userId,
          workerId: input.workerId,
          status: "packaging",
          cancelRequested: false,
        },
        data: {
          status: "archiving",
          progressStage: "archiving",
          progressPercent: 98,
          progressMessage: "安装包已生成，正在归档到 AI 产物知识库",
          spritesheetArtifactId: sprite.artifact.id,
          packageArtifactId: packageArtifact.artifact.id,
          previewArtifactId: preview.artifact.id,
          validationReport: finalReport as unknown as Prisma.InputJsonValue,
          actualModels: [...input.provider.actualModels],
          usage: input.provider.usage as Prisma.InputJsonValue,
          heartbeatAt: new Date(),
          error: null,
        },
      });
      if (completedRun.count !== 1) throw new Error("最终打包 Run 提交时 lease 已失效");
      await tx.codexPetProject.updateMany({
        where: { id: input.projectId, userId: input.userId, status: { not: "deleting" } },
        data: { status: "archiving" },
      });
    });
    job = { ...job, status: "completed" };
    return {
      jobId: job.id,
      recovered: initialized.recovered,
      petId: output.petId,
      spritesheetArtifactId: sprite.artifact.id,
      packageArtifactId: packageArtifact.artifact.id,
      previewArtifactId: preview.artifact.id,
      directionArtifactId: direction.artifact.id,
      blindArtifactId: blind.artifact.id,
      validationArtifactId: validationArtifact.artifact.id,
    };
  } catch (error) {
    return markJobDeferred(input, job, error);
  }
}
