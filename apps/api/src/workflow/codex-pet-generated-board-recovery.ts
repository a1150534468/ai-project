import { Prisma, type CodexPetArtifact, type CodexPetJob, type PrismaClient } from "@prisma/client";
import {
  composeNormalizedPoseBoard,
  createAnimatedWebpPreview,
  extractPoseBoard,
  petRowSpec,
  type ExtractPoseBoardResult,
  type StandardPetState,
} from "@ai-assistant/codex-pet-pipeline";
import { buildVisualQaPrompt } from "./codex-pet-prompts.js";
import {
  CODEX_PET_BOARD_PROMPT_VERSION,
  assertCodexPetVisualQaProvenance,
  type CodexPetArtifactStore,
} from "./codex-pet-runner.js";
import {
  codexPetVisualQaConsensusPasses,
  resolveCodexPetVisualQaModel,
  runCodexPetVisualQaConsensus,
} from "./codex-pet-visual.js";

const RECOVERY_SCHEMA_VERSION = "codex-pet-generated-board-recovery-v1";
const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid`);
  return Number(value);
}

function frameOrder(value: unknown, frameCount: number): readonly number[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)
    || value.length !== frameCount
    || value.some((item) => !Number.isSafeInteger(item))) {
    throw new Error("recovery board frame order is invalid");
  }
  return value.map(Number);
}

function imageModelMatches(requestedModel: string, actualModel: unknown): boolean {
  return actualModel === requestedModel
    || (requestedModel === "gpt-image-2" && actualModel === "gpt-image-2-codex");
}

interface PreparedBoard {
  readonly state: StandardPetState;
  readonly job: CodexPetJob;
  readonly boardArtifact: CodexPetArtifact;
  readonly board: Buffer;
  readonly extracted: ExtractPoseBoardResult;
  readonly normalized: Buffer;
  readonly preview: Buffer;
}

export interface CodexPetGeneratedBoardRecoveryInput {
  readonly prisma: PrismaClient;
  readonly artifacts: CodexPetArtifactStore;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly boards: readonly {
    readonly state: StandardPetState;
    readonly artifactId: string;
  }[];
  readonly qaConsensus?: typeof runCodexPetVisualQaConsensus;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CodexPetGeneratedBoardRecoveryResult {
  readonly runId: string;
  readonly resumed: boolean;
  readonly recoveredJobKeys: readonly string[];
  readonly preservedImageGenerationCallCount: number;
  readonly qaArtifactId: string | null;
}

/**
 * Reprocess already-paid provider outputs after a deterministic extractor fix.
 * This path never generates an image, changes billing, or creates a new run.
 */
export async function recoverCodexPetGeneratedBoards(
  input: CodexPetGeneratedBoardRecoveryInput,
): Promise<CodexPetGeneratedBoardRecoveryResult> {
  if (input.boards.length === 0) throw new Error("generated-board recovery requires at least one board");
  const requestedJobKeys = input.boards.map((board) => `row-${board.state}`);
  if (new Set(requestedJobKeys).size !== requestedJobKeys.length
    || new Set(input.boards.map((board) => board.artifactId)).size !== input.boards.length) {
    throw new Error("generated-board recovery entries must be unique");
  }

  const run = await input.prisma.codexPetRun.findFirst({
    where: { id: input.runId, projectId: input.projectId, userId: input.userId },
    include: { project: true, jobs: true },
  });
  if (!run || run.project.id !== input.projectId || run.project.userId !== input.userId) {
    throw new Error("generated-board recovery ownership mismatch");
  }
  const jobsByKey = new Map(run.jobs.map((job) => [job.key, job]));
  const alreadyRecovered = input.boards.every((board) => {
    const job = jobsByKey.get(`row-${board.state}`);
    return job?.status === "completed"
      && record(job.output).recoveredFromBoardArtifactId === board.artifactId;
  });
  if (alreadyRecovered) {
    const firstOutput = record(jobsByKey.get(requestedJobKeys[0]!)?.output);
    return {
      runId: run.id,
      resumed: false,
      recoveredJobKeys: requestedJobKeys,
      preservedImageGenerationCallCount: run.imageGenerationCallCount,
      qaArtifactId: typeof firstOutput.recoveryQaArtifactId === "string" ? firstOutput.recoveryQaArtifactId : null,
    };
  }

  const snapshot = record(run.inputSnapshot);
  const continuation = record(snapshot.failedContinuation);
  if (run.status !== "failed"
    || run.billingChargeStatus !== "charged"
    || run.billingRefundStatus !== "refunded"
    || !run.billingRefundedAt
    || run.workerId
    || run.cancelRequested
    || run.project.latestRunId !== run.id
    || run.project.status !== "failed"
    || run.project.deletedAt
    || continuation.schemaVersion !== "codex-pet-failed-continuation-v1"
    || continuation.targetPromptVersion !== CODEX_PET_BOARD_PROMPT_VERSION) {
    throw new Error("generated-board recovery requires the current failed continuation with no active lease");
  }
  if (!run.selectedBaseArtifactId) throw new Error("generated-board recovery lacks a selected base");

  const [canonicalArtifact, identityJob, boardArtifacts] = await Promise.all([
    input.prisma.codexPetArtifact.findFirst({
      where: {
        id: run.selectedBaseArtifactId,
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        kind: "base_candidate",
        status: "ready",
      },
    }),
    input.prisma.codexPetJob.findFirst({
      where: { runId: run.id, projectId: run.projectId, userId: run.userId, key: "identity-guide", status: "completed" },
    }),
    input.prisma.codexPetArtifact.findMany({
      where: {
        id: { in: input.boards.map((board) => board.artifactId) },
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        kind: "pose_board",
        status: "ready",
      },
    }),
  ]);
  if (!canonicalArtifact || !identityJob) throw new Error("generated-board recovery lacks canonical identity checkpoints");
  const canonicalGuide = typeof record(identityJob.output).guide === "string"
    ? String(record(identityJob.output).guide).trim()
    : "";
  if (!canonicalGuide) throw new Error("generated-board recovery lacks the canonical identity guide");
  if (boardArtifacts.length !== input.boards.length) throw new Error("generated-board recovery artifact is missing");

  const prepared: PreparedBoard[] = [];
  for (const request of input.boards) {
    const key = `row-${request.state}`;
    const job = jobsByKey.get(key);
    const artifact = boardArtifacts.find((candidate) => candidate.id === request.artifactId);
    if (!job || !artifact || artifact.jobId !== job.id || !["failed", "cancelled"].includes(job.status)) {
      throw new Error(`generated-board recovery job is not recoverable: ${key}`);
    }
    const jobInput = record(job.input);
    const spec = petRowSpec(request.state);
    if (jobInput.promptVersion !== CODEX_PET_BOARD_PROMPT_VERSION
      || integer(jobInput.columns, `${key} columns`) !== spec.boardColumns
      || integer(jobInput.rows, `${key} rows`) !== spec.boardRows
      || integer(jobInput.frameCount, `${key} frameCount`) !== spec.frameCount) {
      throw new Error(`generated-board recovery input contract changed: ${key}`);
    }
    const artifactMetadata = record(artifact.metadata);
    if (artifactMetadata.jobKey !== key
      || !imageModelMatches(run.requestedModel, artifactMetadata.actualModel)) {
      throw new Error(`generated-board recovery provider provenance mismatch: ${key}`);
    }
    const board = await input.artifacts.load(artifact);
    const extracted = await extractPoseBoard(board, {
      columns: spec.boardColumns,
      rows: spec.boardRows,
      frameCount: spec.frameCount,
      frameOrder: frameOrder(jobInput.frameOrder, spec.frameCount),
      chromaKey: run.colorKey || "#ff00ff",
      requireUnusedSlotsEmpty: true,
      allowVerticalTravel: request.state === "jumping",
      requireJumpingArc: request.state === "jumping",
      maxHeightRatio: request.state === "jumping" || request.state === "failed" ? 1.8 : undefined,
    });
    if (!extracted.ok) {
      throw new Error(`${key} still fails deterministic recovery: ${extracted.errors.join("; ")}`);
    }
    prepared.push({
      state: request.state,
      job,
      boardArtifact: artifact,
      board,
      extracted,
      normalized: await composeNormalizedPoseBoard(extracted.frames, {
        columns: spec.boardColumns,
        rows: spec.boardRows,
        chromaKey: run.colorKey || "#ff00ff",
      }),
      preview: (await createAnimatedWebpPreview(extracted.frames, spec.durations)).image,
    });
  }

  const env = { ...(input.env ?? process.env) };
  const visualQaModel = resolveCodexPetVisualQaModel(env, run.visualQaModel);
  env.PET_VISUAL_QA_MODEL = visualQaModel;
  // Recovery is specifically the quota-preserving path. A gateway failure
  // must return control to the operator instead of multiplying model calls.
  env.CODEX_PET_VISUAL_MAX_ATTEMPTS = "1";
  const canonical = await input.artifacts.load(canonicalArtifact);
  const qaImages = [
    { buffer: canonical, mime: canonicalArtifact.mime },
    ...prepared.map((board) => ({ buffer: board.normalized, mime: "image/png" })),
  ];
  const imageMap = prepared.map((board, index) => (
    `${board.state}: image ${index + 2} is the complete normalized chronological cycle`
  )).join("; ");
  const qa = await (input.qaConsensus ?? runCodexPetVisualQaConsensus)({
    images: qaImages,
    prompt: buildVisualQaPrompt(
      "row",
      `Combined recovery review of already-generated standard rows. Image 1 is the canonical identity. ${imageMap}. `
        + "Read every cycle in row-major order. Every listed row must independently preserve identity, contain the exact visible pose count, stay unclipped and connected, and have coherent timing. "
        + "idle must show only calm breathing, blinking or tiny body motion, never waving, travel or task work. "
        + "running-right must face and travel screen-right with a visibly alternating gait and no detached effects. "
        + "The normalized images are the production cells after deterministic removal of detached generation residue; judge them, not discarded source-board guides. "
        + "Set pass true only if every listed row passes. Set mirrorSafe solely from whether the running-right row can be mirrored without changing markings, handedness or meaning.",
      canonicalGuide,
    ),
    env,
    repetitions: 1,
  });
  const qaProvenance = assertCodexPetVisualQaProvenance(qa.modelProvenance, visualQaModel, "generated-board-recovery");
  if (!codexPetVisualQaConsensusPasses(qa)) {
    throw new Error(`generated-board recovery visual QA failed: ${qa.failures.join("; ") || "combined row review failed"}`);
  }

  const expiresAt = new Date(Date.now() + INTERMEDIATE_TTL_MS);
  const qaArtifact = await input.artifacts.put({
    userId: run.userId,
    projectId: run.projectId,
    runId: run.id,
    kind: "qa_report",
    name: "已生成动作板联合恢复质检",
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      boardArtifacts: prepared.map((board) => ({ state: board.state, artifactId: board.boardArtifact.id })),
      deterministic: prepared.map((board) => ({
        state: board.state,
        diagnostics: board.extracted.diagnostics,
        geometry: board.extracted.geometry,
        errors: board.extracted.errors,
        warnings: board.extracted.warnings,
      })),
      visual: qa,
    }, null, 2)),
    mime: "application/json",
    metadata: { visualQa: qaProvenance },
    expiresAt,
  });

  const persistedBoards: Array<{
    readonly prepared: PreparedBoard;
    readonly frameArtifacts: readonly CodexPetArtifact[];
    readonly previewArtifact: CodexPetArtifact;
  }> = [];
  const generatedArtifactIds = [qaArtifact.id];
  try {
    for (const board of prepared) {
      const frameArtifacts: CodexPetArtifact[] = [];
      for (let index = 0; index < board.extracted.frames.length; index += 1) {
        frameArtifacts.push(await input.artifacts.put({
          userId: run.userId,
          projectId: run.projectId,
          runId: run.id,
          jobId: board.job.id,
          kind: "frame",
          name: `${board.state} · frame ${String(index).padStart(2, "0")}`,
          buffer: board.extracted.frames[index]!,
          mime: "image/png",
          metadata: {
            jobKey: board.job.key,
            index,
            diagnostics: board.extracted.diagnostics[index],
            recoveredFromBoardArtifactId: board.boardArtifact.id,
          },
          expiresAt,
        }));
      }
      const previewArtifact = await input.artifacts.put({
        userId: run.userId,
        projectId: run.projectId,
        runId: run.id,
        jobId: board.job.id,
        kind: "animation_preview",
        name: `${board.state} · 动画预览.webp`,
        buffer: board.preview,
        mime: "image/webp",
        metadata: {
          jobKey: board.job.key,
          recoveredFromBoardArtifactId: board.boardArtifact.id,
          frameCount: board.extracted.frames.length,
          durations: petRowSpec(board.state).durations,
          loop: true,
        },
        expiresAt: null,
      });
      generatedArtifactIds.push(...frameArtifacts.map((artifact) => artifact.id), previewArtifact.id);
      persistedBoards.push({ prepared: board, frameArtifacts, previewArtifact });
    }

    const now = new Date();
    await input.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', run.id);
      const freshRun = await tx.codexPetRun.findFirst({
        where: { id: run.id, projectId: run.projectId, userId: run.userId },
        include: { project: true },
      });
      if (!freshRun
        || freshRun.status !== "failed"
        || freshRun.workerId
        || freshRun.cancelRequested
        || freshRun.imageGenerationCallCount !== run.imageGenerationCallCount
        || freshRun.project.latestRunId !== freshRun.id
        || freshRun.project.status !== "failed") {
        throw new Error("generated-board recovery state changed during validation");
      }
      for (const persisted of persistedBoards) {
        const board = persisted.prepared;
        const changed = await tx.codexPetJob.updateMany({
          where: {
            id: board.job.id,
            runId: run.id,
            projectId: run.projectId,
            userId: run.userId,
            status: { in: ["failed", "cancelled"] },
          },
          data: {
            status: "completed",
            outputArtifactIds: persisted.frameArtifacts.map((artifact) => artifact.id),
            output: {
              boardArtifactId: board.boardArtifact.id,
              animationPreviewArtifactId: persisted.previewArtifact.id,
              mirrorSafe: board.state === "running-right" && qa.mirrorSafe,
              qa: { score: qa.score, warnings: qa.warnings },
              deterministic: {
                geometry: board.extracted.geometry,
                jumpingArc: board.extracted.jumpingArc,
                chromaCoverage: board.extracted.diagnostics.map((diagnostic) => diagnostic.chromaCoverage),
              },
              recoveredFromBoardArtifactId: board.boardArtifact.id,
              recoveryQaArtifactId: qaArtifact.id,
              recoverySchemaVersion: RECOVERY_SCHEMA_VERSION,
            } as unknown as Prisma.InputJsonObject,
            providerMetadata: {
              ...record(board.job.providerMetadata),
              visualQa: qaProvenance,
            } as unknown as Prisma.InputJsonObject,
            error: null,
            workerId: null,
            completedAt: now,
          },
        });
        if (changed.count !== 1) throw new Error(`generated-board recovery job state changed: ${board.job.key}`);
      }

      const freshSnapshot = record(freshRun.inputSnapshot);
      const freshContinuation = record(freshSnapshot.failedContinuation);
      const updated = await tx.codexPetRun.update({
        where: { id: freshRun.id },
        data: {
          inputSnapshot: {
            ...freshSnapshot,
            failedContinuation: {
              ...freshContinuation,
              generatedBoardRecovery: {
                schemaVersion: RECOVERY_SCHEMA_VERSION,
                recoveredAt: now.toISOString(),
                qaArtifactId: qaArtifact.id,
                boards: persistedBoards.map(({ prepared: board }) => ({
                  jobKey: board.job.key,
                  boardArtifactId: board.boardArtifact.id,
                })),
              },
            },
          } as Prisma.InputJsonObject,
          status: "standard_generating",
          progressStage: "standard_generating",
          progressPercent: Math.max(25, freshRun.progressPercent),
          progressMessage: "已复用并验证已生成动作板，等待继续制作其余动作",
          completedAt: null,
          heartbeatAt: null,
          workerId: null,
          error: null,
          pendingImageJobKey: null,
          imageGenerationApprovalBudget: 0,
          lastEventSequence: { increment: 1 },
        },
        select: { lastEventSequence: true },
      });
      await tx.codexPetProject.update({
        where: { id: freshRun.projectId },
        data: { status: "standard_generating" },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: freshRun.projectId,
          runId: freshRun.id,
          userId: freshRun.userId,
          sequence: updated.lastEventSequence,
          type: "run.generated_boards_recovered",
          stage: "standard_generating",
          progress: Math.max(25, freshRun.progressPercent),
          message: "已复用已付费动作板，未发起新的生图调用",
          payload: {
            schemaVersion: RECOVERY_SCHEMA_VERSION,
            recoveredJobKeys: requestedJobKeys,
            boardArtifactIds: input.boards.map((board) => board.artifactId),
            qaArtifactId: qaArtifact.id,
            preservedImageGenerationCallCount: freshRun.imageGenerationCallCount,
          },
        },
      });
    });
  } catch (error) {
    await input.prisma.codexPetArtifact.updateMany({
      where: {
        id: { in: generatedArtifactIds },
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
      },
      data: { status: "superseded", expiresAt },
    }).catch(() => undefined);
    throw error;
  }

  return {
    runId: run.id,
    resumed: true,
    recoveredJobKeys: requestedJobKeys,
    preservedImageGenerationCallCount: run.imageGenerationCallCount,
    qaArtifactId: qaArtifact.id,
  };
}
