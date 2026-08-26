// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，核心生成循环）。

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  type ExtractPoseBoardResult,
  composeNormalizedPoseBoard,
  createAnimatedWebpPreview,
  extractPoseBoard,
  inspectFrame,
  spliceSourcePoseBoardSlots,
} from "@ai-assistant/codex-pet-pipeline";
import { type CodexPetArtifact, type CodexPetJob, Prisma } from "@prisma/client";
import { CODEX_PET_BOARD_PROMPT_VERSION } from "../codex-pet-board-version.js";
import {
  buildJumpingQaEvidenceContext,
  buildVisualQaPrompt,
  sanitizeCodexPetDirectionRepairPrompt,
} from "../codex-pet-prompts.js";
import {
  completeImageGenerationAttempt,
  consumeImageGenerationApproval,
  prepareImageGenerationDispatch,
  recordImageGenerationAttempt,
} from "./runner-billing.js";
import {
  ensureJob,
  failJobAttempt,
  loadArtifactsInOrder,
  markImageSucceeded,
  persistProviderMetadata,
  putJsonArtifact,
  startJob,
} from "./runner-jobs.js";
import { checkCancelled, currentRun, emit, updateOwnedActiveRun } from "./runner-lease.js";
import { assertCodexPetVisualQaProvenance } from "./runner-provenance.js";
import {
  BOARD_JOB_INPUT_SCHEMA_VERSION,
  type BoardJobResult,
  CodexPetCancelledError,
  CodexPetImageApprovalRequiredError,
  CodexPetLeaseLostError,
  INTERMEDIATE_TTL_MS,
  type RunnerContext,
} from "./runner-types.js";
import {
  asRecord,
  configuredTransportAttempts,
  imageFailureMetadata,
  imageInput,
  providerMetadata,
  safeError,
  sameOrderedStrings,
  visualQaPasses,
} from "./runner-util.js";
import { type PetVisualQaConsensus, codexPetVisualQaConsensusPasses } from "../codex-pet-visual.js";
import { DOUBAO_IMAGE_MODEL, type ImageBinaryInput } from "../../_shared/image-service.js";

export function poseBoardRepairPrompt(
  errors: readonly string[],
  allowAuxiliaryForegroundComponents = false,
): string {
  const hints = new Set<string>();
  for (const error of errors) {
    if (error.includes("source-touches-slot-edge") || error.includes("normalized-frame-outside-safe-margin")) {
      hints.add("Scale down and recenter every complete pose so ears, tail, paws and effects keep at least 15% clear background from every slot boundary.");
    } else if (error.includes("empty-frame")) {
      hints.add("Restore every required pose; no used slot may be empty.");
    } else if (error.includes("multiple-foreground-components")) {
      hints.add(allowAuxiliaryForegroundComponents
        ? "Keep exactly one complete connected character. Preserve only the user-requested short text, action prop or state effect as bounded opaque auxiliary components; remove every unrequested fragment and never add a second character."
        : "Redraw every slot as exactly one complete connected character. Join the head, torso, arms, hands, legs, feet, ears, tail, antennae and props through continuous opaque character pixels with no chroma gaps at any joint. Remove every detached sweat bead, action mark, punctuation shape, droplet, sparkle, dust mark or other floating effect.");
    } else if (error.includes("auxiliary-component-count-exceeded")) {
      hints.add("Keep at most four separate user-requested text/effect/prop components around the one main character.");
    } else if (error.includes("auxiliary-component-too-large") || error.includes("auxiliary-components-too-large")) {
      hints.add("Make every detached requested action element substantially smaller than the main character; never let it read as a second subject.");
    } else if (error.includes("auxiliary-component-too-far")) {
      hints.add("Move every requested text/effect/prop component visually close to the main character while preserving the slot safe margin.");
    } else if (error.includes("auxiliary-component-touches-edge")) {
      hints.add("Move every requested auxiliary component away from all slot edges and keep at least 15% clear chroma background around it.");
    } else if (error.includes("auxiliary-component-resembles-partial-subject")) {
      hints.add("Remove the detached duplicate body fragment. Keep exactly one character plus only clearly non-character requested text, effects or action objects.");
    } else if (error.includes("possible-transparent-holes")) {
      hints.add("Remove accidental holes or sliced seams through the filled character body.");
    } else if (error.startsWith("unused-slot-")) {
      hints.add("Leave every unused final slot completely empty with only the exact chroma background.");
    } else if (error.includes("chroma-coverage")) {
      hints.add("Use the exact requested flat chroma background with no scenery, panels, gradients or alternate background colour.");
    } else if (error.includes("jumping-arc:frame-1-not-grounded") || error.includes("jumping-arc:frame-5-not-grounded")) {
      hints.add("Keep frame 1 as a grounded anticipation and frame 5 as a grounded settle on the same practical foot baseline.");
    } else if (error.includes("jumping-arc:frame-2-rise-too-small") || error.includes("jumping-arc:frame-4-not-airborne-before-settle")) {
      hints.add("Move the whole character visibly upward in frame 2 and keep frame 4 visibly above the ground before frame 5 settles; changing only the legs is not enough.");
    } else if (error.includes("jumping-arc:frame-3-not-unique") || error.includes("jumping-arc:frame-4-descent-from-peak-too-small")) {
      hints.add("Make frame 3 the single unmistakable highest pose, with frame 2 still rising and frame 4 clearly lower while descending.");
    } else if (error.includes("jumping-arc:peak-lift-too-small")) {
      hints.add("Increase the complete character's vertical travel so the frame-3 peak is clearly separated from both grounded endpoints without zooming or changing body scale.");
    }
  }
  return [...hints].join(" ") || errors.join("; ");
}

export const POSE_BOARD_SALVAGE_SCHEMA_VERSION = "codex-pet-pose-board-salvage-v1";

export interface PoseBoardSalvage {
  /** Board bytes holding the best known pixels for every listed slot. */
  readonly board: Buffer;
  /** Row-major physical source slot indexes whose extraction was clean. */
  readonly goodSourceSlots: readonly number[];
  readonly attempt: number;
  readonly boardArtifactId: string | null;
}

/**
 * Which physical source slots of a board came out of deterministic extraction
 * without a single per-frame error.
 *
 * `diagnostics` is indexed chronologically, so a board with a `frameOrder`
 * permutation needs that mapping to name the physical slot. Unused trailing
 * slots have no diagnostics: they are clean exactly when they are empty, which
 * is what `unusedSlotOpaquePixels` measures.
 */
export function poseBoardSlotHealth(
  extracted: ExtractPoseBoardResult,
  input: { readonly columns: number; readonly rows: number; readonly frameCount: number; readonly frameOrder?: readonly number[] },
): { readonly good: readonly number[]; readonly bad: readonly number[] } {
  const frameOrder = input.frameOrder ?? Array.from({ length: input.frameCount }, (_, index) => index);
  const good: number[] = [];
  const bad: number[] = [];
  for (let frameIndex = 0; frameIndex < input.frameCount; frameIndex += 1) {
    const sourceSlot = frameOrder[frameIndex];
    if (sourceSlot === undefined) continue;
    ((extracted.diagnostics[frameIndex]?.errors.length ?? 1) === 0 ? good : bad).push(sourceSlot);
  }
  extracted.unusedSlotOpaquePixels.forEach((opaquePixels, offset) => {
    (opaquePixels > 32 ? bad : good).push(input.frameCount + offset);
  });
  return { good, bad };
}

/**
 * Carry the clean source slots of a rejected board into the next attempt.
 *
 * A board verdict is the conjunction of every cell, so one broken pose throws
 * away seven good paid poses; the `老鼠猫` incident was rescued offline by
 * exactly this reuse. Splicing happens on raw source slots so the following
 * single `extractPoseBoard` pass still owns one shared scale and baseline for
 * every frame (see `spliceSourcePoseBoardSlots`).
 *
 * Only slots the new board would have failed anyway are replaced, so a splice
 * can only turn a certain rejection into a candidate that still has to pass the
 * same deterministic gates and the same visual review.
 */
export function poseBoardSalvageSlots(salvage: PoseBoardSalvage | null, badSlots: readonly number[]): readonly number[] {
  if (!salvage || badSlots.length === 0) return [];
  const donatable = new Set(salvage.goodSourceSlots);
  return badSlots.filter((slot) => donatable.has(slot));
}

/** Keep whichever board covers more clean slots as the next donor. */
export function preferPoseBoardSalvage(previous: PoseBoardSalvage | null, next: PoseBoardSalvage): PoseBoardSalvage {
  if (!previous) return next;
  const covered = new Set(next.goodSourceSlots);
  const previousOnly = previous.goodSourceSlots.filter((slot) => !covered.has(slot));
  return previousOnly.length > 0 && next.goodSourceSlots.length <= previous.goodSourceSlots.length
    ? previous
    : next;
}

export function poseBoardSalvageMetadata(salvage: { readonly goodSourceSlots: readonly number[]; readonly attempt: number }): Record<string, unknown> {
  return {
    schemaVersion: POSE_BOARD_SALVAGE_SCHEMA_VERSION,
    goodSourceSlots: [...salvage.goodSourceSlots],
    attempt: salvage.attempt,
  };
}

/**
 * Recover a salvage donor written by an earlier process.
 *
 * Per-image billing runs one attempt per invocation: the in-memory donor never
 * survives to the approved retry, so the durable board artifact is the only
 * carrier. The donor is scoped to the job's current `inputRevision` because a
 * changed dependency invalidates the old pixels along with the old attempt
 * budget.
 */
export async function loadPoseBoardSalvage(
  ctx: RunnerContext,
  job: CodexPetJob,
  input: { readonly columns: number; readonly rows: number; readonly frameCount: number },
): Promise<PoseBoardSalvage | null> {
  const inputRevision = asRecord(job.input).inputRevision;
  if (typeof inputRevision !== "string") return null;
  const candidates = await ctx.prisma.codexPetArtifact.findMany({
    where: {
      jobId: job.id,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      kind: "pose_board",
      status: "ready",
    },
    orderBy: { createdAt: "desc" },
    take: 4,
  });
  for (const candidate of candidates) {
    const metadata = asRecord(candidate.metadata);
    if (metadata.inputRevision !== inputRevision) continue;
    const salvage = asRecord(metadata.salvage);
    if (salvage.schemaVersion !== POSE_BOARD_SALVAGE_SCHEMA_VERSION) continue;
    const goodSourceSlots = Array.isArray(salvage.goodSourceSlots)
      ? salvage.goodSourceSlots.filter((slot): slot is number => Number.isInteger(slot)
        && slot >= 0
        && slot < input.columns * input.rows)
      : [];
    if (goodSourceSlots.length === 0) continue;
    if (metadata.columns !== input.columns || metadata.rows !== input.rows || metadata.frameCount !== input.frameCount) continue;
    try {
      return {
        board: await ctx.artifacts.load(candidate),
        goodSourceSlots,
        attempt: Number.isInteger(salvage.attempt) ? Number(salvage.attempt) : 0,
        boardArtifactId: candidate.id,
      };
    } catch {
      // An expired or swept object simply means there is nothing to salvage.
      continue;
    }
  }
  return null;
}

/**
 * Seedream image edits tend to preserve and amplify a failed board's split
 * anatomy and broken grid. Repair it from the canonical identity plus the
 * clean layout guide instead of feeding the rejected pixels back to the model.
 */
export function codexPetShouldAttachFailedBoardForRepair(imageModel: string): boolean {
  return imageModel !== DOUBAO_IMAGE_MODEL;
}

export function codexPetRepairGenerationReferences(
  imageModel: string,
  references: readonly ImageBinaryInput[],
  previousFailedBoard: Buffer | null,
): readonly ImageBinaryInput[] {
  if (!previousFailedBoard || !codexPetShouldAttachFailedBoardForRepair(imageModel)) return references;
  return [...references, imageInput(previousFailedBoard, "image/png", "previous-failed-pose-board.png")];
}

export function jumpingQaEvidence(extracted: ExtractPoseBoardResult): string {
  return buildJumpingQaEvidenceContext({
    sharedScale: extracted.sharedScale,
    widthRatio: extracted.geometry.widthRatio,
    heightRatio: extracted.geometry.heightRatio,
    centerSpreadPixels: extracted.geometry.centerSpreadPixels,
    normalizedFrames: extracted.diagnostics.map((diagnostic, index) => ({
      frame: index + 1,
      width: diagnostic.normalizedBounds?.width ?? null,
      height: diagnostic.normalizedBounds?.height ?? null,
    })),
    jumpingFrames: extracted.jumpingArc?.positions.map((position) => ({
      frame: position.frame,
      centerY: position.centerY,
      groundY: position.groundY,
      bodySpan: position.bodySpan,
    })) ?? [],
  });
}

export async function codexPetJumpingTargetHeight(idleFrames: readonly Buffer[]): Promise<number> {
  const heights = (await Promise.all(idleFrames.map((frame, index) => inspectFrame(frame, index))))
    .map((diagnostic) => diagnostic.normalizedBounds?.height)
    .filter((height): height is number => typeof height === "number" && height > 5)
    .sort((left, right) => left - right);
  if (heights.length === 0) throw new Error("Cannot derive jumping scale from empty idle frames");
  const middle = Math.floor(heights.length / 2);
  const medianHeight = heights.length % 2 === 0
    ? (heights[middle - 1]! + heights[middle]!) / 2
    : heights[middle]!;
  return Math.max(1, Math.min(174, Math.floor(medianHeight - 5)));
}

export function isJumpingScaleEvidenceConflict(
  qa: PetVisualQaConsensus,
  extracted: ExtractPoseBoardResult,
): boolean {
  if (!extracted.ok || !extracted.jumpingArc?.ok) return false;
  if ((extracted.geometry.widthRatio ?? Number.POSITIVE_INFINITY) > 1.08) return false;
  if ((extracted.geometry.centerSpreadPixels ?? Number.POSITIVE_INFINITY) > 4) return false;
  if (qa.pass || qa.failures.length === 0) return false;
  const scaleOnly = qa.failures.every((failure) => (
    /zoom|scale|size jump|size pop|squash|stretch|缩放|尺寸|比例|拉伸|挤压/i.test(failure)
  ));
  if (!scaleOnly) return false;
  return qa.verdicts.length > 0 && qa.verdicts.every((verdict) => (
    verdict.identity && verdict.structure && verdict.semantics && verdict.continuity
  ));
}

export async function completedBoardJob(ctx: RunnerContext, job: CodexPetJob): Promise<BoardJobResult | null> {
  if (job.status !== "completed" || job.outputArtifactIds.length === 0) return null;
  const output = asRecord(job.output);
  if (typeof output.boardArtifactId !== "string") return null;
  if (ctx.qualityInspectionEnabled) {
    assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, job.key);
  }
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

export interface BoardJobInputBinding {
  readonly inputArtifactIds: readonly string[];
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
  readonly frameOrder?: readonly number[];
  readonly promptVersion?: string;
  readonly prompt?: string;
  readonly jumpingTargetHeight?: number;
  readonly allowAuxiliaryForegroundComponents?: boolean;
}

/**
 * Board attempts are scoped to their ordered durable inputs, not to a Job key
 * alone. The repair hint is deliberately absent: it changes how the next
 * attempt should improve the same visual task and therefore must consume the
 * next attempt rather than resetting the bounded repair budget.
 */
export function codexPetBoardInputRevision(input: BoardJobInputBinding): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: BOARD_JOB_INPUT_SCHEMA_VERSION,
    promptVersion: input.promptVersion ?? CODEX_PET_BOARD_PROMPT_VERSION,
    promptHash: createHash("sha256").update(input.prompt ?? "").digest("hex"),
    jumpingTargetHeight: input.jumpingTargetHeight ?? null,
    inputArtifactIds: [...input.inputArtifactIds],
    columns: input.columns,
    rows: input.rows,
    frameCount: input.frameCount,
    frameOrder: input.frameOrder ? [...input.frameOrder] : null,
    ...(input.allowAuxiliaryForegroundComponents ? { allowAuxiliaryForegroundComponents: true } : {}),
  })).digest("hex");
}

export function boardJobInputPayload(input: BoardJobInputBinding): Prisma.InputJsonObject {
  return {
    schemaVersion: BOARD_JOB_INPUT_SCHEMA_VERSION,
    promptVersion: input.promptVersion ?? CODEX_PET_BOARD_PROMPT_VERSION,
    promptHash: createHash("sha256").update(input.prompt ?? "").digest("hex"),
    jumpingTargetHeight: input.jumpingTargetHeight ?? null,
    inputRevision: codexPetBoardInputRevision(input),
    inputArtifactIds: [...input.inputArtifactIds],
    columns: input.columns,
    rows: input.rows,
    frameCount: input.frameCount,
    frameOrder: input.frameOrder ? [...input.frameOrder] : null,
    ...(input.allowAuxiliaryForegroundComponents ? { allowAuxiliaryForegroundComponents: true } : {}),
  };
}

export function boardOutputArtifactIds(job: CodexPetJob): string[] {
  const output = asRecord(job.output);
  return [...new Set([
    ...job.outputArtifactIds,
    typeof output.boardArtifactId === "string" ? output.boardArtifactId : "",
    typeof output.animationPreviewArtifactId === "string" ? output.animationPreviewArtifactId : "",
  ].filter(Boolean))];
}

/**
 * Bind a durable board Job to the exact dependency artifact revision before
 * consulting its cached output or choosing the next attempt number.
 *
 * A changed dependency invalidates both the old result and its exhausted
 * attempt budget. The reset is protected by the current active run lease and
 * committed atomically with superseding the previous output artifacts. Jobs
 * written by the pre-revision implementation are backfilled without changing
 * attempts when their ordered artifact ids already match the current input.
 */
export async function bindBoardJobInput(
  ctx: RunnerContext,
  job: CodexPetJob,
  input: BoardJobInputBinding,
): Promise<CodexPetJob> {
  const payload = boardJobInputPayload(input);
  const currentRevision = payload.inputRevision;
  const persistedInput = asRecord(job.input);
  const persistedRevision = typeof persistedInput.inputRevision === "string"
    ? persistedInput.inputRevision
    : null;
  const artifactIdsMatch = sameOrderedStrings(job.inputArtifactIds, input.inputArtifactIds);
  if (persistedRevision === currentRevision && artifactIdsMatch) return job;

  return ctx.prisma.$transaction(async (tx) => {
    // Updating the run row makes the lease check a database CAS and holds its
    // row lock until the Job reset/backfill and artifact invalidation commit.
    await updateOwnedActiveRun(tx, ctx, { heartbeatAt: new Date() });

    const fresh = await tx.codexPetJob.findFirst({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
    });
    if (!fresh) throw new CodexPetLeaseLostError();
    const freshInput = asRecord(fresh.input);
    const freshRevision = typeof freshInput.inputRevision === "string"
      ? freshInput.inputRevision
      : null;
    const freshArtifactIdsMatch = sameOrderedStrings(fresh.inputArtifactIds, input.inputArtifactIds);
    if (freshRevision === currentRevision && freshArtifactIdsMatch) return fresh;

    if (freshRevision === null && freshArtifactIdsMatch) {
      // Legacy completed/running Jobs already bound to these exact artifacts
      // keep their attempt and result. Only add the deterministic revision
      // contract so subsequent dependency changes are detectable.
      return tx.codexPetJob.update({
        where: { id: fresh.id },
        data: {
          input: {
            ...freshInput,
            schemaVersion: BOARD_JOB_INPUT_SCHEMA_VERSION,
            promptVersion: payload.promptVersion,
            inputRevision: currentRevision,
          } as Prisma.InputJsonValue,
        },
      });
    }

    const obsoleteArtifactIds = boardOutputArtifactIds(fresh);
    if (obsoleteArtifactIds.length > 0) {
      await tx.codexPetArtifact.updateMany({
        where: {
          id: { in: obsoleteArtifactIds },
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

    return tx.codexPetJob.update({
      where: { id: fresh.id },
      data: {
        status: "queued",
        attempt: 0,
        input: payload as Prisma.InputJsonValue,
        inputArtifactIds: [...input.inputArtifactIds],
        outputArtifactIds: [],
        output: Prisma.DbNull,
        providerMetadata: Prisma.DbNull,
        error: null,
        workerId: null,
        startedAt: null,
        completedAt: null,
      },
    });
  });
}

export async function runBoardJob(ctx: RunnerContext, input: {
  readonly key: string;
  readonly kind: string;
  readonly dependencies: readonly string[];
  readonly inputArtifactIds: readonly string[];
  readonly prompt: string;
  readonly references: readonly ImageBinaryInput[];
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
  readonly frameOrder?: readonly number[];
  readonly promptVersion?: string;
  readonly jumpingTargetHeight?: number;
  readonly allowAuxiliaryForegroundComponents?: boolean;
  readonly authoritativeActionPrompt?: string;
  readonly progress: number;
  readonly qaKind: "row" | "cardinals" | "directions";
  readonly qaContext: string;
  readonly qaRepetitions?: number;
  readonly workflowStage?: "standard_generating" | "direction_generating" | "validating";
  readonly animationDurations?: readonly number[];
  readonly force?: boolean;
  readonly repairHint?: string;
}): Promise<BoardJobResult> {
  let job = await ensureJob(
    ctx,
    input.key,
    input.kind,
    input.dependencies,
    { columns: input.columns, rows: input.rows, frameCount: input.frameCount },
    ctx.maxBoardAttempts,
  );
  job = await bindBoardJobInput(ctx, job, {
    inputArtifactIds: input.inputArtifactIds,
    columns: input.columns,
    rows: input.rows,
    frameCount: input.frameCount,
    frameOrder: input.frameOrder,
    promptVersion: input.promptVersion,
    prompt: input.prompt,
    jumpingTargetHeight: input.jumpingTargetHeight,
    allowAuxiliaryForegroundComponents: input.allowAuxiliaryForegroundComponents,
  });
  const supersededArtifactIds = input.force ? boardOutputArtifactIds(job) : [];
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
  const normalizeRepairRequirement = (value: string) => input.qaKind === "directions"
    ? value.includes("The following cardinal appearance contract is authoritative and overrides any contradictory wording in a model diagnostic:")
      ? value
      : sanitizeCodexPetDirectionRepairPrompt(value)
    : value.trim();
  const persistedRegistrationFailure = input.qaKind === "directions" && job.attempt > 0
    ? await ctx.prisma.codexPetJob.findUnique({
        where: { runId_key: { runId: ctx.runId, key: `${input.key}-registration` } },
        select: { error: true },
      })
    : null;
  const persistedRegistrationRepair = persistedRegistrationFailure?.error?.trim()
    ? `Keep every complete character inside its cell with at least 20% clear background on all four sides so neutral-frame registration cannot crop or touch an edge. Persisted registration diagnostics: ${persistedRegistrationFailure.error.slice(0, 1200)}`
    : "";
  const initialRepairRequirement = input.repairHint?.trim()
    ? normalizeRepairRequirement(input.repairHint)
    : normalizeRepairRequirement(persistedRegistrationRepair);
  const repairRequirements = initialRepairRequirement ? [initialRepairRequirement] : [];
  let previousFailedBoard: Buffer | null = null;
  // A forced repair deliberately discards the previous art, so it must not
  // splice the superseded pixels back in. Within one process the in-memory
  // donor still accumulates across this loop's attempts.
  let salvage: PoseBoardSalvage | null = input.force
    ? null
    : await loadPoseBoardSalvage(ctx, job, { columns: input.columns, rows: input.rows, frameCount: input.frameCount });
  let lastError = "";
  // A process may die after persisting status=running but before producing a
  // durable board/diagnostic result. A stale-lease replay retries that same
  // numbered attempt; infrastructure interruption must not consume one of the
  // two visual-repair attempts included in the package.
  const firstAttempt = job.status === "running" && job.attempt > 0
    ? job.attempt
    : Math.max(1, job.attempt + 1);
  const workflowStage = input.workflowStage
    ?? (input.qaKind === "row" ? "standard_generating" : "direction_generating");
  const requiresSingleCallApproval = ctx.perImageBilling || (
    ctx.env.CODEX_PET_IMAGE_APPROVAL_GATE !== "0"
    && (input.qaKind === "directions" || workflowStage === "validating")
  );
  for (let attempt = firstAttempt; attempt <= job.maxAttempts; attempt += 1) {
    await checkCancelled(ctx);
    job = await startJob(ctx, job, attempt, input.progress, `${input.qaContext}${attempt > 1 ? `（自动修复 ${attempt - 1}/${job.maxAttempts}）` : ""}`);
    // Establish a durable running job before consuming the one-call budget.
    // If the job transition itself fails, no approval is lost because no
    // provider request could have started. A missing budget still raises the
    // approval-required signal and is converted into an awaiting-review pause
    // by the outer runner without contacting the model.
    if (!ctx.perImageBilling && requiresSingleCallApproval) await consumeImageGenerationApproval(ctx, input.key);
    try {
      const repairReferences = codexPetRepairGenerationReferences(ctx.imageModel, input.references, previousFailedBoard);
      const attachPreviousFailedBoard = repairReferences.length > input.references.length;
      const generated = await ctx.generate({
        prompt: `${input.prompt}${repairRequirements.length > 0
          ? `\n\nRepair the complete pose group. Every numbered requirement is cumulative and mandatory; preserve requirements that already passed:\n${repairRequirements.map((requirement, index) => `${index + 1}. ${requirement}`).join("\n")}`
          : ""}${attachPreviousFailedBoard
          ? "\nAn attached previous failed pose board is diagnostic guidance only. Preserve its already-passing identity, grid clearance, connectivity, scale and baseline while correcting every numbered failure; still redraw the complete coherent group rather than copying broken cells."
          : previousFailedBoard
            ? "\nRedraw the complete pose group from the approved canonical character and clean layout references only. The rejected board is deliberately not attached because its broken anatomy or grid must not be inherited. Preserve the exact requested columns, rows, row-major frame order, scale and baseline while satisfying every numbered repair requirement."
            : ""}`,
        references: repairReferences,
        // Direction boards are normalized to 192x208 cells before assembly.
        // A 1024x688 source still gives each 4x2 cell 256x344 pixels while
        // reducing relay generation time enough to stay inside its one-minute
        // first-response window. Standard action boards retain the larger
        // canvas because their varied silhouettes benefit from the headroom.
        size: input.qaKind === "row" ? "1536x1024" : "1024x688",
        quality: "low",
        env: ctx.env,
        signal: ctx.signal,
        // Per-image billing retries the transport inside the one paid unit; the
        // legacy approval gate keeps its one-shot semantics because there each
        // provider attempt consumes a separate approval.
        maxAttempts: ctx.perImageBilling
          ? configuredTransportAttempts(ctx.env)
          : requiresSingleCallApproval || job.maxAttempts === 1 || ctx.maxBoardAttempts === 1
            ? 1
            : undefined,
        onAttempt: ctx.perImageBilling ? undefined : (providerAttempt) => recordImageGenerationAttempt(ctx, input.key, attempt, providerAttempt),
        onRequestDispatching: ctx.perImageBilling
          ? (transportAttempt) => prepareImageGenerationDispatch(ctx, input.key, attempt, transportAttempt)
          : undefined,
        onRequestSent: ctx.perImageBilling ? (providerAttempt) => recordImageGenerationAttempt(ctx, input.key, attempt, providerAttempt) : undefined,
        onRetry: async (error, transportAttempt) => emit(ctx, "job.retrying", workflowStage, input.progress, "上游生图调用重试中", {
          transportAttempt,
          retryKind: "transport",
          ...(ctx.perImageBilling ? { withinPaidCall: true } : {}),
          ...imageFailureMetadata(error),
        }, input.key),
      });
      await completeImageGenerationAttempt(ctx, input.key, attempt, generated.provider);
      await checkCancelled(ctx);
      const boardMetadata = {
        ...providerMetadata(generated.provider),
        attempt,
        jobKey: input.key,
        promptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
        inputRevision: asRecord(job.input).inputRevision,
        columns: input.columns,
        rows: input.rows,
        frameCount: input.frameCount,
      };
      let boardArtifact = await ctx.artifacts.put({
        userId: ctx.project.userId,
        projectId: ctx.project.id,
        runId: ctx.runId,
        jobId: job.id,
        kind: "pose_board",
        name: `${input.qaContext}姿势板 · 第 ${attempt} 次`,
        buffer: generated.buffer,
        mime: generated.mime,
        metadata: boardMetadata,
        expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
      });
      await persistProviderMetadata(ctx, job, generated.provider);
      const extractOptions = {
        columns: input.columns,
        rows: input.rows,
        frameCount: input.frameCount,
        frameOrder: input.frameOrder,
        chromaKey: ctx.identity.chromaKey,
        requireUnusedSlotsEmpty: true,
        allowVerticalTravel: input.key === "row-jumping",
        jumpingTargetHeight: input.key === "row-jumping" ? input.jumpingTargetHeight : undefined,
        requireJumpingArc: input.key === "row-jumping",
        maxHeightRatio: input.key === "row-jumping" || input.key === "row-failed" ? 1.8 : undefined,
        allowAuxiliaryForegroundComponents: input.allowAuxiliaryForegroundComponents,
      } as const;
      let board = generated.buffer;
      let extracted = await extractPoseBoard(board, extractOptions);
      let salvagedSlots: readonly number[] = [];
      if (!extracted.ok) {
        // Reuse the clean paid cells of an earlier rejected board instead of
        // discarding the whole group over one broken pose. The splice is on raw
        // source slots, so the re-extraction below is still the single owner of
        // the shared scale and baseline for every frame.
        const candidateSlots = poseBoardSalvageSlots(salvage, poseBoardSlotHealth(extracted, input).bad);
        if (candidateSlots.length > 0 && salvage) {
          const splicedBoard = await spliceSourcePoseBoardSlots({
            base: board,
            donor: salvage.board,
            columns: input.columns,
            rows: input.rows,
            slots: candidateSlots,
            chromaKey: ctx.identity.chromaKey,
          });
          const respliced = await extractPoseBoard(splicedBoard, extractOptions);
          // Accept only a strict improvement: one shared scale is recomputed
          // over the merged silhouettes, so a splice can in principle push a
          // previously fitting pose outside the safe margin.
          if (respliced.errors.length < extracted.errors.length) {
            board = splicedBoard;
            extracted = respliced;
            salvagedSlots = candidateSlots;
            boardArtifact = await ctx.artifacts.put({
              userId: ctx.project.userId,
              projectId: ctx.project.id,
              runId: ctx.runId,
              jobId: job.id,
              kind: "pose_board",
              name: `${input.qaContext}姿势板（复用第 ${salvage.attempt} 次合格格位） · 第 ${attempt} 次`,
              buffer: splicedBoard,
              mime: "image/png",
              metadata: {
                ...boardMetadata,
                salvagedFromAttempt: salvage.attempt,
                salvagedFromArtifactId: salvage.boardArtifactId,
                salvagedSourceSlots: [...candidateSlots],
              },
              expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
            });
            await emit(ctx, "validation.warning", workflowStage, input.progress, `${input.qaContext}复用了上一次调用的 ${candidateSlots.length} 个合格格位，未额外付费生图`, {
              retryKind: "salvage",
              salvagedSourceSlots: [...candidateSlots],
              salvagedFromAttempt: salvage.attempt,
              remainingErrors: [...extracted.errors],
            }, input.key);
          }
        }
      }
      let qa: PetVisualQaConsensus = { pass: false, verdicts: [], score: 0, mirrorSafe: false, warnings: extracted.warnings, failures: extracted.errors };
      if (extracted.ok && !ctx.qualityInspectionEnabled) {
        qa = {
          pass: true,
          verdicts: [],
          score: 100,
          mirrorSafe: false,
          warnings: extracted.warnings,
          failures: [],
        };
      }
      if (extracted.ok && ctx.qualityInspectionEnabled) {
        // QA the normalized cells that will actually enter the atlas. The
        // source board's row/column gutters are construction detail owned by
        // deterministic extraction, not animation motion.
        const normalizedBoard = await composeNormalizedPoseBoard(extracted.frames, {
          columns: input.columns,
          rows: input.rows,
          chromaKey: ctx.identity.chromaKey,
        });
        const jumpingEvidence = input.key === "row-jumping"
          ? jumpingQaEvidence(extracted)
          : "";
        const canonicalReference = input.references.find((reference) => reference.filename?.includes("canonical-base"))
          ?? input.references[0];
        const directionEvidence = input.qaKind === "directions"
          ? input.references.filter((reference) => reference.filename?.includes("approved-anchor-storyboard")
            || reference.filename?.includes("trajectory-scaffold")
            || reference.filename === "approved-cardinal-anchor-strip.png"
            || reference.filename === "approved-registered-look-row-9-4x2.png")
          : [];
        const canonicalQaImage = {
          buffer: canonicalReference ? Buffer.from(canonicalReference.b64, "base64") : board,
          mime: canonicalReference?.mime,
        };
        // Direction reviewers must see the complete generated eight-pose row
        // first. In R7 the reviewer fixated on the intentionally sparse
        // two-endpoint storyboard and incorrectly reported six missing poses
        // even though deterministic extraction recovered all eight cells.
        const qaImages = input.qaKind === "directions"
          ? [
              { buffer: normalizedBoard, mime: "image/png" },
              canonicalQaImage,
              ...directionEvidence.map((reference) => ({ buffer: Buffer.from(reference.b64, "base64"), mime: reference.mime })),
            ]
          : [canonicalQaImage, { buffer: normalizedBoard, mime: "image/png" }];
        const directionEvidenceContext = input.qaKind === "directions"
          ? " Image 1 is the complete normalized eight-pose row under review in chronological row-major reading order; inspect all eight of its visible poses before any supporting image. Image 2 is the canonical identity. Image 3 is the intentionally sparse row-major direction scaffold with only approved endpoints placed; its blank slots are not missing output poses. Image 4 is the complete approved 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. When present, Image 5 is the already-approved preceding direction row. Never count poses from Image 3; count and judge the eight poses in Image 1. Compare visible front/back/side appearance against the anchors; never assume 000 is front-facing or 180 is rear-facing."
          : "";
        const visualQa = await ctx.qaConsensus({
          images: qaImages,
          prompt: buildVisualQaPrompt(
            input.qaKind,
            `${input.qaContext}${jumpingEvidence ? `。${jumpingEvidence}` : ""}${extracted.geometry.warnings.length > 0
              ? `。确定性尺寸/基线指标需要复核：${extracted.geometry.warnings.join("；")}`
              : ""}${directionEvidenceContext.replace("row-major anchor storyboard", "row-major direction scaffold")}`,
            ctx.identity.canonicalGuide,
            input.authoritativeActionPrompt,
          ),
          env: ctx.env,
          signal: ctx.signal,
          repetitions: input.qaRepetitions ?? 1,
        });
        assertCodexPetVisualQaProvenance(visualQa.modelProvenance, ctx.visualQaModel, `${input.key}-visual-qa`);
        qa = {
          ...visualQa,
          warnings: [...new Set([...extracted.warnings, ...visualQa.warnings])],
        };
        if (input.key === "row-jumping" && isJumpingScaleEvidenceConflict(qa, extracted)) {
          const adjudication = await ctx.qaConsensus({
            images: qaImages,
            prompt: buildVisualQaPrompt(
              "row",
              `Independent jumping scale adjudication. The initial reviewer passed identity, structure, semantics and continuity but failed only zoom/scale. Inspect the actual five normalized production cells and decide whether rigid identity anchors (head width, ear spacing and torso width) enlarge together. Pose-dependent leg/foot extension and the mandatory vertical arc are not zoom. ${jumpingEvidence}`,
              ctx.identity.canonicalGuide,
            ),
            env: ctx.env,
            signal: ctx.signal,
            repetitions: 3,
          });
          assertCodexPetVisualQaProvenance(adjudication.modelProvenance, ctx.visualQaModel, `${input.key}-jumping-adjudication`);
          await putJsonArtifact(ctx, {
            jobId: job.id,
            kind: "qa_report",
            name: `${input.qaContext}尺度冲突独立裁决 · 第 ${attempt} 次`,
            value: {
              deterministic: {
                sharedScale: extracted.sharedScale,
                geometry: extracted.geometry,
                jumpingArc: extracted.jumpingArc,
                diagnostics: extracted.diagnostics.map((diagnostic) => ({ normalizedBounds: diagnostic.normalizedBounds })),
              },
              initial: visualQa,
              adjudication,
            },
            expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
          });
          if (codexPetVisualQaConsensusPasses(adjudication)) {
            const acceptedWarnings = [
              ...extracted.warnings,
              ...visualQa.warnings,
              ...visualQa.failures.map((failure) => `初审尺度争议：${failure}`),
              ...adjudication.warnings,
            ];
            qa = {
              pass: true,
              // The independent adjudication supersedes this one disputed
              // scale-only gate. Keeping the rejected initial vote in the
              // active consensus would turn a valid 1-of-1 adjudication into
              // a synthetic 1:1 tie and force needless image regeneration.
              verdicts: [...adjudication.verdicts],
              score: adjudication.score,
              mirrorSafe: visualQa.mirrorSafe,
              warnings: [...new Set(acceptedWarnings)],
              failures: [],
              modelProvenance: adjudication.modelProvenance,
            };
            await emit(ctx, "validation.warning", "standard_generating", input.progress, "jumping 尺度初审与确定性数据冲突，已由三次独立裁决通过", {
              initialFailures: visualQa.failures,
              widthRatio: extracted.geometry.widthRatio,
              heightRatio: extracted.geometry.heightRatio,
              centerSpreadPixels: extracted.geometry.centerSpreadPixels,
              adjudicationScore: adjudication.score,
            }, input.key);
          } else {
            qa = {
              ...adjudication,
              verdicts: [...visualQa.verdicts, ...adjudication.verdicts],
              mirrorSafe: visualQa.mirrorSafe,
              warnings: [...new Set([...extracted.warnings, ...visualQa.warnings, ...adjudication.warnings])],
              failures: [...new Set([...visualQa.failures, ...adjudication.failures])],
            };
          }
        }
      }
      if (!extracted.ok || !visualQaPasses(ctx, qa)) {
        lastError = [...extracted.errors, ...qa.failures].join("；") || "视觉质量检查未通过";
        const nextRepairRequirement = extracted.ok
          ? qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt || lastError
          : poseBoardRepairPrompt(extracted.errors, input.allowAuxiliaryForegroundComponents);
        const normalizedRepairRequirement = normalizeRepairRequirement(nextRepairRequirement);
        if (normalizedRepairRequirement && !repairRequirements.includes(normalizedRepairRequirement)) {
          repairRequirements.push(normalizedRepairRequirement);
        }
        previousFailedBoard = board;
        // Record this board's clean cells so the next attempt can splice them
        // back in instead of paying for eight poses to fix one. The donor board
        // must stay loadable, so the pixels live on the artifact and the slot
        // map lives in its metadata.
        const health = poseBoardSlotHealth(extracted, input);
        const candidate: PoseBoardSalvage = {
          board,
          goodSourceSlots: health.good,
          attempt,
          boardArtifactId: boardArtifact.id,
        };
        const nextSalvage = health.good.length > 0 ? preferPoseBoardSalvage(salvage, candidate) : salvage;
        if (nextSalvage === candidate) {
          await ctx.prisma.codexPetArtifact.updateMany({
            where: {
              id: boardArtifact.id,
              runId: ctx.runId,
              projectId: ctx.project.id,
              userId: ctx.project.userId,
            },
            data: {
              metadata: {
                ...asRecord(boardArtifact.metadata),
                salvage: poseBoardSalvageMetadata(candidate),
              } as Prisma.InputJsonValue,
            },
          });
        }
        salvage = nextSalvage;
        await putJsonArtifact(ctx, {
          jobId: job.id,
          kind: "qa_report",
          name: `${input.qaContext}失败诊断 · 第 ${attempt} 次`,
          // Frames are already stored as image artifacts when a board passes
          // and the rejected source board is stored above. Serializing Buffer
          // byte arrays into diagnostic JSON inflated each failed report by
          // several megabytes without adding useful evidence.
          value: {
            deterministic: {
              diagnostics: extracted.diagnostics,
              unusedSlotOpaquePixels: extracted.unusedSlotOpaquePixels,
              chroma: extracted.chroma,
              sourceWidth: extracted.sourceWidth,
              sourceHeight: extracted.sourceHeight,
              sharedScale: extracted.sharedScale,
              geometry: extracted.geometry,
              jumpingArc: extracted.jumpingArc,
              ok: extracted.ok,
              errors: extracted.errors,
              warnings: extracted.warnings,
            },
            visual: qa,
            salvage: {
              appliedSourceSlots: [...salvagedSlots],
              reusableSourceSlots: [...health.good],
              brokenSourceSlots: [...health.bad],
              donorAttempt: salvage?.attempt ?? null,
            },
          },
          expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
        });
        await failJobAttempt(ctx, job, attempt, lastError, input.progress);
        if (requiresSingleCallApproval) {
          throw new CodexPetImageApprovalRequiredError(input.key, `${input.qaContext}未通过检查，需要确认后才能重新生成`);
        }
        if (attempt >= job.maxAttempts) throw new Error(`${input.qaContext}经 ${job.maxAttempts} 次真实调用后仍未通过：${lastError}`);
        continue;
      }
      // Only now has this image passed both deterministic extraction and the
      // visual action/identity gate.  A generated-but-rejected board must not
      // affect the cancellation refund decision.
      const qaProvenance = ctx.qualityInspectionEnabled
        ? assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, input.key)
        : { enabled: false, requestedModel: null, actualModels: [], routes: [] };
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
            jumpingArc: extracted.jumpingArc,
            chromaCoverage: extracted.diagnostics.map((diagnostic) => diagnostic.chromaCoverage),
          },
          salvagedSourceSlots: [...salvagedSlots],
        } as unknown as Prisma.InputJsonValue,
        providerMetadata: {
          ...providerMetadata(generated.provider),
          visualQa: qaProvenance,
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
      return { job, frames: extracted.frames, frameArtifacts, board, boardArtifact, mirrorSafe: qa.mirrorSafe, qa };
    } catch (error) {
      await completeImageGenerationAttempt(ctx, input.key, attempt, undefined, error).catch(() => undefined);
      if (error instanceof CodexPetImageApprovalRequiredError) throw error;
      if (error instanceof CodexPetLeaseLostError || ctx.signal?.reason instanceof CodexPetLeaseLostError) throw new CodexPetLeaseLostError();
      if (error instanceof CodexPetCancelledError || ctx.signal?.aborted) throw new CodexPetCancelledError();
      lastError = safeError(error);
      const latest = await ctx.prisma.codexPetJob.findUnique({ where: { id: job.id } });
      if (latest?.status !== "failed") {
        await failJobAttempt(ctx, job, attempt, lastError, input.progress, true, imageFailureMetadata(error));
      }
      if (requiresSingleCallApproval) {
        throw new CodexPetImageApprovalRequiredError(input.key, `${input.qaContext}调用失败，需要确认后才能再次生成`);
      }
      // Transport retries are already bounded inside generateCodexPetVisual.
      // Infrastructure, moderation and invalid-parameter failures must not be
      // multiplied by the complete-action-group visual repair loop.
      throw error;
    }
  }
  throw new Error(lastError || `${input.qaContext} failed`);
}
