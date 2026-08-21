import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type CodexPetArtifact, type CodexPetJob, type CodexPetProject, type CodexPetRun, type ImageAsset, type PrismaClient } from "@prisma/client";
import {
  LOOK_DIRECTIONS,
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  PET_ROW_SPECS,
  assemblePetAtlas,
  assembleStandardPetAtlas,
  composeCardinalAnchorStrip,
  composeLookBScreenLeftTrajectoryReference,
  composeLookSourceBoardReference,
  composeNormalizedPoseBoard,
  chooseChromaKey,
  createAnimatedWebpPreview,
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  createLayoutGuide,
  createLookAnchorStoryboard,
  createStandardAtlasContactSheet,
  despillChromaEdges,
  extractPoseBoard,
  inspectFrame,
  inspectCodexPetZip,
  measureDirectionContinuity,
  measureDirectionRowContinuity,
  mirrorFramesPreservingOrder,
  parseNeutralDirectionRegistrationManifest,
  petRowSpec,
  spliceSourcePoseBoardSlots,
  registerFirstDirectionRowToNeutral,
  registerSecondDirectionRowWithManifest,
  splitRegisteredDirectionRow,
  validatePetAtlas,
  validateNeutralLockedDirectionFrames,
  validateStandardPetAtlas,
  type DirectionRegistrationCellDiagnostics,
  type ExtractPoseBoardResult,
  type NeutralDirectionGeometryValidation,
  type NeutralDirectionRegistrationManifest,
  type PetFramesByState,
  type PetRowSpec,
} from "@ai-assistant/codex-pet-pipeline";
import {
  DOUBAO_IMAGE_MODEL,
  GPT_IMAGE_MODEL,
  classifyImageGenerationError,
  type ImageBinaryInput,
  type ImageGenerationResult,
} from "./image-service.js";
import {
  CodexPetModelContractError,
  CODEX_PET_MODEL_CONTRACT_VERSION,
  codexPetVisualQaRouteForModel,
  isAllowedCodexPetImageModel,
  isAllowedCodexPetImageProvenance,
  isAllowedCodexPetVisualModel,
} from "./codex-pet-model-contract.js";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CodexPetImageCallAlreadySentError,
  CodexPetImageCallApprovalRequiredError,
  CodexPetImageCallLimitError,
  completeCodexPetImageCall,
  markCodexPetImageCallSent,
  prepareCodexPetImageCallDispatch,
  refundCodexPetFailedExtraCall,
} from "./codex-pet-call-ledger.js";
import { codexPetGptFailedContinuationSnapshot } from "./codex-pet-gpt-continuation.js";
import {
  CODEX_PET_GATE_REPAIR_ROWS,
  codexPetGateFailureSnapshotValue,
  type CodexPetGateRepairRow,
} from "./codex-pet-gate-failure.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import { sanitizeCodexPetDiagnosticText, type CodexPetRunStage } from "./codex-pet-events.js";
import {
  buildBasePetPrompt,
  buildBaseChoiceQaContext,
  buildCardinalPrompt,
  CODEX_PET_CARDINAL_APPEARANCE_CONTRACT,
  buildJumpingQaEvidenceContext,
  buildLookMechanicsPrompt,
  buildLookRowPrompt,
  buildStandardRowPrompt,
  buildVisualQaPrompt,
  normalizeCodexPetActionPrompts,
  sanitizeCodexPetDirectionRepairPrompt,
  type CodexPetActionPrompts,
  type CodexPetVisualIdentity,
} from "./codex-pet-prompts.js";
import {
  generateCodexPetIdentityGuide,
  generateCodexPetLookMechanics,
  generateCodexPetVisual,
  codexPetImageMaxAttempts,
  createSeedreamPoseBoardScaffold,
  selectSeedreamGaitScaffoldVariants,
  codexPetVisualQaConsensusPasses,
  codexPetVisualQaVerdictPasses,
  resolveCodexPetVisualQaModel,
  runBlindDirectionQa,
  runCodexPetVisualQa,
  runCodexPetVisualQaConsensus,
  runLabeledDirectionSemantics,
  type BlindDirectionValidation,
  type CodexPetVisualModelProvenance,
  type DirectionSemanticVerdict,
  type PetVisualQaConsensus,
  type PetVisualQaVerdict,
} from "./codex-pet-visual.js";
import {
  CodexPetPackagingDeferredError,
  persistOrResumeCodexPetFinalPackage,
  type CodexPetDurablePackagingResult,
} from "./codex-pet-packaging.js";

export const CODEX_PET_ACTIVE_STATUSES = [
  "queued", "base_generating", "awaiting_base_review", "standard_generating", "direction_generating",
  "awaiting_direction_review", "validating", "repairing", "packaging", "archiving",
] as const;

export const CODEX_PET_RESOURCE_KEY = "codex_pet_v2_package";
const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60_000;
const WORKER_ID = `codex-pet-${process.pid}-${randomUUID().slice(0, 8)}`;
const DEFAULT_STALE_RUN_MS = 15 * 60_000;
const IDENTITY_GUIDE_VERSION = 2;
const BOARD_JOB_INPUT_SCHEMA_VERSION = "codex-pet-board-input-v3";
export { CODEX_PET_BOARD_PROMPT_VERSION } from "./codex-pet-board-version.js";
import { CODEX_PET_BOARD_PROMPT_VERSION } from "./codex-pet-board-version.js";
export const CODEX_PET_IDLE_BOARD_PROMPT_VERSION = "codex-pet-board-prompt-v9";
const CODEX_PET_RECOVERY_SCHEMA_VERSION = "codex-pet-recovery-v1";

export function codexPetStandardRowPromptVersion(
  state: Exclude<PetRowSpec["state"], "look-a" | "look-b">,
): string {
  return state === "idle" ? CODEX_PET_IDLE_BOARD_PROMPT_VERSION : CODEX_PET_BOARD_PROMPT_VERSION;
}

export function codexPetShouldMirrorRunningLeft(
  mirrorSafe: boolean,
  actionPrompts: CodexPetActionPrompts | undefined,
): boolean {
  return mirrorSafe
    && !actionPrompts?.["running-right"]
    && !actionPrompts?.["running-left"];
}

type StandardActionState = Exclude<PetRowSpec["state"], "look-a" | "look-b">;

function customizedStandardActionStates(
  actionPrompts: CodexPetActionPrompts | undefined,
): readonly StandardActionState[] {
  return PET_ROW_SPECS.slice(0, 9).flatMap((spec) => {
    const state = spec.state as StandardActionState;
    return actionPrompts?.[state]?.trim() ? [state] : [];
  });
}

function standardActionSpecificationSummary(actionPrompts: CodexPetActionPrompts | undefined): string {
  return customizedStandardActionStates(actionPrompts)
    .map((state) => `${state}: ${actionPrompts?.[state]?.trim()}`)
    .join("; ");
}

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

export type CodexPetExecutionStatus = "awaiting_base_review" | "awaiting_direction_review" | "awaiting_regeneration_approval" | "packaging" | "archiving" | "ready" | "failed" | "cancelled" | typeof CODEX_PET_LEGACY_READ_ONLY_STATUS | "busy";
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
    workerId?: string;
  }) => Promise<{ documentId: string }>;
  readonly billing: {
    refundResource(operationId: string): Promise<{ success: boolean }>;
    settleResource?: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  };
  readonly visual?: {
    generate?: typeof generateCodexPetVisual;
    qa?: typeof runCodexPetVisualQa;
    qaConsensus?: typeof runCodexPetVisualQaConsensus;
    blindQa?: typeof runBlindDirectionQa;
    directionSemantics?: typeof runLabeledDirectionSemantics;
    lookMechanics?: typeof generateCodexPetLookMechanics;
    identityGuide?: typeof generateCodexPetIdentityGuide;
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
  readonly imageModel: string;
  readonly visualQaModel: string;
  readonly qualityInspectionEnabled: boolean;
  readonly perImageBilling: boolean;
  readonly perImageCallPoints: number;
  readonly maxBoardAttempts: number;
  readonly identity: CodexPetVisualIdentity;
  readonly referenceAssetIds: readonly string[];
  readonly userReferences: readonly ImageBinaryInput[];
  readonly generate: typeof generateCodexPetVisual;
  readonly qa: typeof runCodexPetVisualQa;
  readonly qaConsensus: typeof runCodexPetVisualQaConsensus;
  readonly blindQa: typeof runBlindDirectionQa;
  readonly directionSemantics: typeof runLabeledDirectionSemantics;
  readonly lookMechanics: typeof generateCodexPetLookMechanics;
  readonly identityGuide: typeof generateCodexPetIdentityGuide;
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

interface RegisteredDirectionRowResult {
  readonly registrationJob: CodexPetJob;
  readonly source: BoardJobResult;
  readonly frames: readonly Buffer[];
  readonly registeredRow: Buffer;
  readonly registeredRowArtifact: CodexPetArtifact | null;
  readonly manifest: NeutralDirectionRegistrationManifest;
  readonly manifestArtifact: CodexPetArtifact | null;
  readonly validation: NeutralDirectionGeometryValidation;
  readonly diagnostics: readonly DirectionRegistrationCellDiagnostics[];
  readonly sourceBoardSize: { readonly width: number; readonly height: number };
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

class CodexPetCancelledError extends Error {
  constructor() {
    super("用户已取消桌宠制作");
    this.name = "CodexPetCancelledError";
  }
}

class CodexPetImageApprovalRequiredError extends Error {
  constructor(
    readonly jobKey: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexPetImageApprovalRequiredError";
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
    return "图片生成服务暂时不可用；本次请求未重试，运行已停止并将按系统失败退款";
  }
  return sanitizeCodexPetDiagnosticText(
    error instanceof Error && error.message ? error.message : "桌宠制作失败",
    1_000,
  );
}

function frozenPerImageCallPoints(snapshot: Record<string, unknown>, run: CodexPetRun): number {
  const snapshotted = snapshot.perImageCallPoints;
  if (typeof snapshotted === "number" && Number.isSafeInteger(snapshotted) && snapshotted > 0) {
    return snapshotted;
  }

  // Rollout-era runs can resume only when their durable reservation proves an
  // integral unit price. Never read mutable billing configuration here.
  if (run.billingReservedUnits > 0
    && run.billingReservedPoints > 0
    && run.billingReservedPoints % run.billingReservedUnits === 0) {
    return run.billingReservedPoints / run.billingReservedUnits;
  }
  throw new Error("Codex pet per-image run is missing a frozen per-call price");
}

function poseBoardRepairPrompt(
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

const POSE_BOARD_SALVAGE_SCHEMA_VERSION = "codex-pet-pose-board-salvage-v1";

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

function jumpingQaEvidence(extracted: ExtractPoseBoardResult): string {
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

function isJumpingScaleEvidenceConflict(
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

/**
 * How many times one *already-paid* image call may be re-sent to the provider.
 *
 * This is the transport axis and it is deliberately independent of the board /
 * quality axis (`maxBoardAttempts`, `job.maxAttempts`), which is pinned to 1
 * under per-image billing because every redraw is a separately charged unit that
 * needs its own user approval. Conflating the two meant a single socket blip
 * parked the run and demanded a paid approval for work the user never chose to
 * redo — the failure shape where `look-cardinals` burned 6 extra calls on 6
 * consecutive socket errors. A transport retry re-enters the same ledger row, so
 * it costs the user nothing.
 *
 * `CODEX_PET_IMAGE_MAX_ATTEMPTS=1` still forces one-shot for acceptance runs.
 */
function configuredTransportAttempts(env: NodeJS.ProcessEnv): number {
  return codexPetImageMaxAttempts(env);
}

// Both call sites of this value dispatch real billed image calls (the two base
// candidates, and the repair fan-out over standard rows). Concurrency > 1 makes
// them compete for the same upstream relay quota, which self-inflicts the 429
// that killed an earlier run. Serial by default; raise it only deliberately.
function configuredVisualConcurrency(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_VISUAL_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? Math.min(3, value) : 1;
}

function configuredArchiveMaxAttempts(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_ARCHIVE_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? Math.min(100, value) : 10;
}

const FINAL_REPAIR_ROWS = CODEX_PET_GATE_REPAIR_ROWS;
type FinalRepairRow = CodexPetGateRepairRow;
type StandardRepairRow = Exclude<FinalRepairRow, "look-a" | "look-b">;

export function codexPetCoupledStandardRepairRows(rows: readonly StandardRepairRow[]): StandardRepairRow[] {
  const coupled = new Set(rows);
  if (coupled.has("running-right")) coupled.add("running-left");
  if (coupled.has("running-left")) coupled.add("running-right");
  // Jump scale is derived from idle, so replacing idle invalidates the
  // previously normalized jumping row even when jumping itself passed QA.
  if (coupled.has("idle")) coupled.add("jumping");
  return [...coupled].sort((left, right) => Number(right === "idle") - Number(left === "idle"));
}

/**
 * A terminal gate rejection that still knows which action groups it blames.
 *
 * The in-process repair loop is bounded, so exhausting it ends the run. Carrying
 * the row scope out to `finalizeFailure` lets the failure be recorded as
 * continuable work instead of an opaque wall: the user can resume the same paid
 * run and redo exactly those rows.
 */
class CodexPetGateFailureError extends Error {
  constructor(
    message: string,
    readonly gate: string,
    readonly rows: readonly FinalRepairRow[],
    readonly failures: readonly string[],
  ) {
    super(message);
    this.name = "CodexPetGateFailureError";
  }
}

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

/**
 * Which complete action groups a deterministic atlas gate implicates.
 *
 * Both atlas validators return `cells[]` keyed by `state`, and continuity's only
 * hard error is `<direction>:empty-direction-cell`, so a structural rejection is
 * row-addressable evidence rather than an unexplained wall. Without this
 * mapping the gates could only throw after all fourteen paid calls, which is
 * exactly how a run reached `failed` holding nine good action groups.
 */
export function repairRowsFromAtlasValidation(
  validation: { readonly cells: readonly { readonly state: string; readonly errors: readonly string[] }[]; readonly errors: readonly string[] },
): FinalRepairRow[] {
  const rows = new Set<FinalRepairRow>();
  for (const cell of validation.cells) {
    if (cell.errors.length === 0) continue;
    const row = FINAL_REPAIR_ROWS.find((candidate) => candidate === cell.state);
    if (row) rows.add(row);
  }
  return [...rows];
}

/**
 * Atlas-wide errors (wrong dimensions, missing alpha, an unattributed chroma
 * pixel count) are assembly or despill defects that regenerating an action group
 * cannot fix. They must stay hard failures instead of burning the repair budget.
 */
export function atlasValidationErrorsWithoutCellScope(
  validation: { readonly cells: readonly { readonly state: string; readonly column: number; readonly errors: readonly string[] }[]; readonly errors: readonly string[] },
): string[] {
  const cellScoped = new Set(validation.cells.flatMap((cell) => (
    cell.errors.map((error) => `${cell.state}[${cell.column}]:${error}`)
  )));
  return validation.errors.filter((error) => !cellScoped.has(error));
}

export function repairRowsFromDirectionContinuity(continuity: { readonly errors: readonly string[] }): FinalRepairRow[] {
  const rows = new Set<FinalRepairRow>();
  for (const error of continuity.errors) {
    const direction = error.split(":")[0] ?? "";
    const index = LOOK_DIRECTIONS.indexOf(direction as (typeof LOOK_DIRECTIONS)[number]);
    if (index < 0) continue;
    rows.add(index < 8 ? "look-a" : "look-b");
  }
  return [...rows];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  parentSignal?: AbortSignal,
): Promise<R[]> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const results = new Array<R>(items.length);
  let cursor = 0;
  const failures: unknown[] = [];
  const runners = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    for (;;) {
      if (controller.signal.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, index, controller.signal);
      } catch (error) {
        if (failures.length === 0) {
          failures.push(error);
          if (!controller.signal.aborted) controller.abort(error);
        }
        return;
      }
    }
  });
  try {
    // A terminal run/refund must not race a sibling that is still unwinding
    // an upstream image request, QA call or artifact write. Abort on the first
    // branch failure, then drain every branch before rethrowing that failure.
    await Promise.allSettled(runners);
  } finally {
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
  if (failures.length > 0) throw failures[0];
  if (controller.signal.aborted) {
    const reason = controller.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new CodexPetCancelledError();
  }
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

function isCodexPetRecoverySnapshot(value: unknown): boolean {
  const snapshot = asRecord(value);
  const recovery = asRecord(snapshot.recovery);
  return recovery.schemaVersion === CODEX_PET_RECOVERY_SCHEMA_VERSION
    && typeof recovery.sourceRunId === "string"
    && recovery.sourceRunId.length > 0
    && typeof recovery.fingerprint === "string"
    && recovery.fingerprint.length > 0;
}

function imageFailureMetadata(error: unknown): Record<string, unknown> {
  const classification = classifyImageGenerationError(error);
  return {
    category: classification.category,
    ...(classification.transportCode
      ? { transportCode: classification.transportCode }
      : {}),
    ...(classification.upstreamRequestId
      ? { upstreamRequestId: classification.upstreamRequestId }
      : {}),
  };
}

function visualQaPasses(ctx: RunnerContext, consensus: PetVisualQaConsensus): boolean {
  return !ctx.qualityInspectionEnabled || codexPetVisualQaConsensusPasses(consensus);
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

async function recordImageGenerationAttempt(
  ctx: RunnerContext,
  jobKey: string,
  logicalAttempt: number,
  providerAttempt: number,
): Promise<void> {
  if (ctx.perImageBilling) {
    const sent = await markCodexPetImageCallSent({
      prisma: ctx.prisma,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      jobKey,
      logicalAttempt,
      requestedModel: ctx.imageModel,
      points: ctx.perImageCallPoints,
    });
    const run = await currentRun(ctx);
    await ctx.appendEvent({
      prisma: ctx.prisma,
      runId: ctx.runId,
      type: "image.call.sent",
      stage: run.progressStage,
      progress: run.progressPercent,
      message: providerAttempt > 1
        ? `第 ${sent.callCount} 次真实生图调用重发（同一次授权内的第 ${providerAttempt} 次传输尝试）`
        : `已发起第 ${sent.callCount} 次真实生图调用`,
      payload: {
        callCount: sent.callCount,
        callKind: sent.callKind,
        operationId: sent.operationId,
        requestedModel: ctx.imageModel,
        providerAttempt,
      },
      jobKey,
    });
    return;
  }
  const updated = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      cancelRequested: false,
    },
    data: {
      imageGenerationCallCount: { increment: 1 },
      heartbeatAt: new Date(),
    },
  });
  if (updated.count !== 1) throw new CodexPetLeaseLostError();
  const run = await currentRun(ctx);
  await ctx.appendEvent({
    prisma: ctx.prisma,
    runId: ctx.runId,
    type: "image.call.started",
    stage: run.progressStage,
    progress: run.progressPercent,
    message: `已发起第 ${run.imageGenerationCallCount} 次真实生图调用`,
    payload: {
      callCount: run.imageGenerationCallCount,
      requestedModel: ctx.imageModel,
      providerAttempt,
    },
    jobKey,
  });
}

async function prepareImageGenerationDispatch(
  ctx: RunnerContext,
  jobKey: string,
  logicalAttempt: number,
  transportAttempt = 1,
): Promise<void> {
  if (!ctx.perImageBilling) return;
  await prepareCodexPetImageCallDispatch({
    prisma: ctx.prisma,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    jobKey,
    logicalAttempt,
    requestedModel: ctx.imageModel,
    points: ctx.perImageCallPoints,
    transportAttempt,
  });
}

async function completeImageGenerationAttempt(
  ctx: RunnerContext,
  jobKey: string,
  logicalAttempt: number,
  result?: ImageGenerationResult,
  error?: unknown,
): Promise<void> {
  if (!ctx.perImageBilling) return;
  const failure = error === undefined ? null : classifyImageGenerationError(error);
  await completeCodexPetImageCall({
    prisma: ctx.prisma,
    runId: ctx.runId,
    jobKey,
    logicalAttempt,
    actualModel: result?.actualModel,
    upstreamRequestId: result?.upstreamRequestId ?? failure?.upstreamRequestId,
    error,
  });
  if (!failure) return;
  // Extra calls are charged independently at approval time, so a provider
  // failure has already taken the user's points for an image they never got.
  // Best-effort on purpose: the refund receipt lives on the ledger row, so a
  // billing outage here leaves a retryable record instead of failing the run.
  const refunded = await refundCodexPetFailedExtraCall({
    prisma: ctx.prisma,
    billing: ctx.billing,
    runId: ctx.runId,
    jobKey,
    logicalAttempt,
  }).catch(() => false);
  if (!refunded) return;
  const run = await currentRun(ctx);
  await ctx.appendEvent({
    prisma: ctx.prisma,
    runId: ctx.runId,
    type: "image.call.refunded",
    stage: run.progressStage,
    progress: run.progressPercent,
    message: `第 ${logicalAttempt} 次额外生图调用失败，已退回 ${ctx.perImageCallPoints} 积分`,
    payload: { jobKey, logicalAttempt, points: ctx.perImageCallPoints },
    jobKey,
  }).catch(() => undefined);
}

async function consumeImageGenerationApproval(ctx: RunnerContext, jobKey: string): Promise<void> {
  const consumed = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
      imageGenerationApprovalBudget: { gt: 0 },
      cancelRequested: false,
    },
    data: {
      imageGenerationApprovalBudget: { decrement: 1 },
      pendingImageJobKey: null,
      heartbeatAt: new Date(),
    },
  });
  if (consumed.count !== 1) {
    throw new CodexPetImageApprovalRequiredError(jobKey, `${jobKey} 需要用户明确批准下一次真实生图调用`);
  }
}

async function pauseForImageApproval(ctx: RunnerContext, error: CodexPetImageApprovalRequiredError): Promise<void> {
  const message = `${error.message}；当前不会自动重试或生成下一张图`;
  const status = ctx.perImageBilling ? "awaiting_regeneration_approval" : "awaiting_direction_review";
  await ctx.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', ctx.runId);
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        cancelRequested: false,
      },
      data: {
        status,
        progressStage: status,
        progressMessage: message,
        pendingImageJobKey: error.jobKey,
        imageGenerationApprovalBudget: 0,
        workerId: null,
        heartbeatAt: null,
        error: null,
      },
    });
    if (changed.count !== 1) throw new CodexPetLeaseLostError();
    await tx.codexPetJob.updateMany({
      where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, key: error.jobKey },
      data: { status: "awaiting_approval", workerId: null, completedAt: null, error: message },
    });
    await tx.codexPetProject.updateMany({
      where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
      data: { status },
    });
  });
  await ctx.appendEvent({
    prisma: ctx.prisma,
    runId: ctx.runId,
    type: "image.approval_required",
    stage: status,
    progress: (await currentRun(ctx)).progressPercent,
    message,
    payload: { jobKey: error.jobKey, maxApprovedCalls: 1, callKind: "extra" },
    jobKey: error.jobKey,
  });
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
  zeroChargeRecovery = false,
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
        AND: [
          zeroChargeRecovery
            ? { billingChargeStatus: "not_required", billingPoints: 0 }
            : {
                OR: [
                  { billingChargeStatus: "charged", billingActivatedAt: { not: null } },
                  { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" },
                ],
              },
          {
            OR: [
              { workerId: null },
              { heartbeatAt: null },
              { heartbeatAt: { lt: staleBefore } },
            ],
          },
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
  if (!(CODEX_PET_ACTIVE_STATUSES as readonly string[]).includes(run.status) || run.workerId !== ctx.workerId) {
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

/**
 * Visual repair moves the durable run to `repairing`, while a successful
 * per-job event does not own the surrounding workflow stage. Reconcile only
 * after the complete parallel batch/gate has passed. Progress is deliberately
 * a high-water mark because final QA may replay a 20% row from 88%.
 */
async function resumeStageIfRepairing(
  ctx: RunnerContext,
  status: Extract<CodexPetRunStage, "standard_generating" | "direction_generating" | "validating">,
  progress: number,
  message: string,
): Promise<boolean> {
  const restored = await ctx.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', ctx.runId);
    const current = await tx.codexPetRun.findFirst({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "repairing",
        cancelRequested: false,
      },
      select: { progressPercent: true },
    });
    if (!current) return null;
    const effectiveProgress = Math.max(current.progressPercent, Math.min(99, progress));
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "repairing",
        cancelRequested: false,
      },
      data: {
        status,
        progressStage: status,
        progressPercent: effectiveProgress,
        progressMessage: message,
        heartbeatAt: new Date(),
      },
    });
    if (changed.count !== 1) return null;
    await tx.codexPetProject.updateMany({
      where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
      data: { status },
    });
    return { effectiveProgress };
  });
  if (!restored) return false;
  await emit(ctx, "stage.started", status, restored.effectiveProgress, message, {
    resumedAfterRepair: true,
    resumeStage: status,
  });
  return true;
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
  await emit(ctx, retrying ? "job.retrying" : "job.started", eventStage, progress, message, {
    attempt,
    maxAttempts: job.maxAttempts,
    ...(retrying ? { retryKind: "visual" } : {}),
  }, job.key);
  return updated;
}

async function failJobAttempt(
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

async function reuseGptContinuationBaseCandidate(
  ctx: RunnerContext,
  job: CodexPetJob,
  candidateIndex: number,
): Promise<{ artifact: CodexPetArtifact; buffer: Buffer } | null> {
  if (candidateIndex !== 1 || job.attempt !== 0) return null;
  const run = await currentRun(ctx);
  const continuation = codexPetGptFailedContinuationSnapshot(run.inputSnapshot);
  if (!continuation) return null;

  const existing = await ctx.prisma.codexPetArtifact.findFirst({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      jobId: job.id,
      kind: "base_candidate",
      status: "ready",
    },
  });
  if (existing) {
    const buffer = await ctx.artifacts.load(existing);
    await ctx.prisma.codexPetJob.update({
      where: { id: job.id },
      data: { status: "completed", outputArtifactIds: [existing.id], completedAt: new Date(), workerId: null, error: null },
    });
    return { artifact: existing, buffer };
  }

  const source = await ctx.prisma.codexPetArtifact.findFirst({
    where: {
      id: continuation.sourceBaseArtifactId,
      runId: continuation.sourceRunId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      kind: "base_candidate",
      status: "ready",
    },
  });
  if (!source) throw new Error("GPT failed continuation source base candidate is unavailable");
  const buffer = await ctx.artifacts.load(source);
  const artifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "base_candidate",
    name: "主形象候选 1（复用）",
    buffer,
    mime: source.mime,
    metadata: {
      ...asRecord(source.metadata),
      reusedFrom: {
        runId: continuation.sourceRunId,
        artifactId: continuation.sourceBaseArtifactId,
        providerCallReused: true,
      },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  await ctx.prisma.codexPetJob.update({
    where: { id: job.id },
    data: { status: "completed", outputArtifactIds: [artifact.id], completedAt: new Date(), workerId: null, error: null },
  });
  await emit(ctx, "preview.ready", "base_generating", 8, "主形象候选 1 已从失败运行复用", {
    artifactId: artifact.id,
    sourceRunId: continuation.sourceRunId,
    providerCallReused: true,
  }, job.key);
  await emit(ctx, "job.completed", "base_generating", 8, "主形象候选 1 已复用，未产生模型调用", {
    artifactId: artifact.id,
    sourceRunId: continuation.sourceRunId,
    providerCallReused: true,
  }, job.key);
  return { artifact, buffer };
}

async function generateBaseCandidate(ctx: RunnerContext, candidateIndex: number): Promise<{ artifact: CodexPetArtifact; buffer: Buffer }> {
  const key = `base-candidate-${candidateIndex}`;
  let job = await ensureJob(
    ctx,
    key,
    "base_candidate",
    [],
    { candidateIndex, referenceAssetIds: ctx.referenceAssetIds },
    ctx.maxBoardAttempts,
  );
  if (job.status === "completed" && job.outputArtifactIds.length === 1) {
    const loaded = await loadArtifactsInOrder(ctx, job.outputArtifactIds);
    return { artifact: loaded.artifacts[0]!, buffer: loaded.buffers[0]! };
  }
  const reused = await reuseGptContinuationBaseCandidate(ctx, job, candidateIndex);
  if (reused) return reused;
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
      // Transport retries stay inside this one charged unit; only a quality
      // redraw costs another approval.
      maxAttempts: ctx.perImageBilling ? configuredTransportAttempts(ctx.env) : undefined,
      onAttempt: ctx.perImageBilling ? undefined : (providerAttempt) => recordImageGenerationAttempt(ctx, key, attempt, providerAttempt),
      onRequestDispatching: ctx.perImageBilling
        ? (transportAttempt) => prepareImageGenerationDispatch(ctx, key, attempt, transportAttempt)
        : undefined,
      onRequestSent: ctx.perImageBilling ? (providerAttempt) => recordImageGenerationAttempt(ctx, key, attempt, providerAttempt) : undefined,
      onRetry: async (error, transportAttempt) => emit(ctx, "job.retrying", "base_generating", 8, "生图服务暂时不可用，正在重试", {
        transportAttempt,
        retryKind: "transport",
        ...(ctx.perImageBilling ? { withinPaidCall: true } : {}),
        ...imageFailureMetadata(error),
      }, key),
    });
    await completeImageGenerationAttempt(ctx, key, attempt, generated.provider);
    await checkCancelled(ctx);
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
    await completeImageGenerationAttempt(ctx, key, attempt, undefined, error).catch(() => undefined);
    const failure = classifyImageGenerationError(error);
    await failJobAttempt(ctx, job, attempt, safeError(error), 10, true, imageFailureMetadata(error));
    if (ctx.perImageBilling && failure.category === "rate_limit") {
      throw new CodexPetImageApprovalRequiredError(
        key,
        `上游并发额度暂不可用，${key} 已暂停；需要单次授权后重试`,
      );
    }
    throw error;
  }
}

async function selectBaseAutomatically(ctx: RunnerContext, candidates: readonly { artifact: CodexPetArtifact; buffer: Buffer }[]): Promise<string> {
  if (!ctx.qualityInspectionEnabled) throw new Error("AI quality inspection is disabled; base selection must be manual");
  const job = await ensureJob(ctx, "base-selection", "visual_qa", ["base-candidate-1", "base-candidate-2"]);
  const output = asRecord(job.output);
  if (job.status === "completed" && typeof output.selectedArtifactId === "string") {
    assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, "base-selection");
    return output.selectedArtifactId;
  }
  const verdicts = await Promise.all(candidates.map((candidate, index) => ctx.qa({
    images: [
      { buffer: candidate.buffer, mime: candidate.artifact.mime },
      ...ctx.userReferences.slice(0, 3).map((reference) => ({ buffer: Buffer.from(reference.b64, "base64"), mime: reference.mime })),
    ],
    prompt: buildVisualQaPrompt("base-choice", buildBaseChoiceQaContext(index + 1)),
    env: ctx.env,
    signal: ctx.signal,
  })));
  await checkCancelled(ctx);
  const baseQaProvenance = verdicts.map((verdict, index) => (
    assertCodexPetVisualQaProvenance(verdict.modelProvenance, ctx.visualQaModel, `base-selection-candidate-${index + 1}`)
  ));
  const eligible = codexPetVisualQaVerdictPasses;
  // Never silently pick a visually rejected candidate.  Continuing with the
  // highest numeric score would produce a run whose canonical identity was
  // explicitly rejected by every reviewer.  The caller treats this as a
  // terminal workflow error (and therefore refunds the package).
  if (verdicts.length === 0 || verdicts.every((verdict) => !eligible(verdict))) {
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
    if (!eligible(verdict)) return best;
    if (best < 0) return index;
    const bestVerdict = verdicts[best]!;
    return verdict.score > bestVerdict.score ? index : best;
  }, -1);
  if (selectedIndex < 0) throw new Error("两个主形象候选均未通过视觉质检");
  const selectedArtifactId = candidates[selectedIndex]!.artifact.id;
  const qaArtifact = await putJsonArtifact(ctx, { jobId: job.id, kind: "qa_report", name: "主形象自动选择报告", value: { selectedArtifactId, verdicts } });
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { selectedArtifactId, qaArtifactId: qaArtifact.id } as Prisma.InputJsonValue,
    outputArtifactIds: [qaArtifact.id],
    providerMetadata: {
      visualQa: {
        requestedModel: ctx.visualQaModel,
        actualModels: [...new Set(baseQaProvenance.flatMap((value) => value.actualModels))],
        routes: [...new Set(baseQaProvenance.flatMap((value) => value.routes))],
      },
    } as Prisma.InputJsonValue,
    completedAt: new Date(),
  } });
  return selectedArtifactId;
}

async function ensurePersistedBaseSelection(ctx: RunnerContext, selectedArtifactId: string): Promise<void> {
  const job = await ensureJob(ctx, "base-selection", "visual_qa", ["base-candidate-1", "base-candidate-2"]);
  const output = asRecord(job.output);
  if (job.status === "completed") {
    if (output.selectedArtifactId !== selectedArtifactId) throw new Error("Persisted base selection does not match the approved artifact");
    return;
  }
  // Automatic selection already completes this job with a QA report. Manual
  // selection is committed by the route, so the runner records the same
  // durable graph node without inventing another visual review.
  const changed = await ctx.prisma.codexPetJob.updateMany({
    where: {
      id: job.id,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: { not: "completed" },
    },
    data: {
      status: "completed",
      attempt: Math.max(1, job.attempt),
      inputArtifactIds: [selectedArtifactId],
      output: { selectedArtifactId, selectionMode: "manual" } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    },
  });
  if (changed.count !== 1) throw new CodexPetLeaseLostError();
}

async function getIdentityGuide(
  ctx: RunnerContext,
  canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer },
): Promise<string> {
  const compact = (value: string, limit: number) => value.replace(/\s+/g, " ").trim().slice(0, limit);
  const characterBrief = [
    `名称：${compact(ctx.identity.name, 60)}`,
    ctx.identity.description ? `描述：${compact(ctx.identity.description, 240)}` : "",
    ctx.identity.prompt ? `角色设定：${compact(ctx.identity.prompt, 640)}` : "",
    `风格：${compact(ctx.identity.stylePreset, 60)}`,
    ctx.identity.styleNotes ? `风格补充：${compact(ctx.identity.styleNotes, 180)}` : "",
  ].filter(Boolean).join("；").slice(0, 1200);
  const supportingReferenceAssetIds = ctx.referenceAssetIds.slice(0, 3);
  const characterBriefHash = createHash("sha256").update(characterBrief).digest("hex");
  const guideBinding = {
    version: IDENTITY_GUIDE_VERSION,
    selectedBaseArtifactId: canonical.artifact.id,
    supportingReferenceAssetIds,
    characterBriefHash,
  };
  let job = await ensureJob(ctx, "identity-guide", "identity_guide", ["base-selection"], {
    ...guideBinding,
  });
  const persistedOutput = asRecord(job.output);
  if (!ctx.qualityInspectionEnabled) {
    const guide = [
      "Use the approved canonical base image as the only identity source.",
      "Preserve silhouette, head-body ratio, face placement, palette, accessories and material.",
      "Keep feet anchored to the slot baseline; do not rotate the whole character or invent extra limbs, heads, text or background.",
    ].join(" ");
    if (job.status === "completed" && persistedOutput.mode === "fixed" && typeof persistedOutput.guide === "string") {
      return persistedOutput.guide;
    }
    job = await startJob(ctx, job, Math.max(1, job.attempt + 1), 16, "已锁定固定身份约束，不调用 AI 质检");
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      inputArtifactIds: [canonical.artifact.id],
      outputArtifactIds: [],
      output: { mode: "fixed", guide, selectedArtifactId: canonical.artifact.id } as Prisma.InputJsonValue,
      providerMetadata: { visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    } });
    return guide;
  }
  const persisted = persistedOutput.guide;
  if (job.status === "completed") {
    const jobInput = asRecord(job.input);
    const persistedReferenceIds = Array.isArray(persistedOutput.supportingReferenceAssetIds)
      ? persistedOutput.supportingReferenceAssetIds.filter((value): value is string => typeof value === "string")
      : [];
    const inputReferenceIds = Array.isArray(jobInput.supportingReferenceAssetIds)
      ? jobInput.supportingReferenceAssetIds.filter((value): value is string => typeof value === "string")
      : [];
    const referencesMatch = (values: readonly string[]) => values.length === supportingReferenceAssetIds.length
      && values.every((value, index) => value === supportingReferenceAssetIds[index]);
    const matchesCanonical = persistedOutput.version === IDENTITY_GUIDE_VERSION
      && persistedOutput.selectedArtifactId === canonical.artifact.id
      && persistedOutput.characterBriefHash === characterBriefHash
      && referencesMatch(persistedReferenceIds)
      && jobInput.version === IDENTITY_GUIDE_VERSION
      && jobInput.selectedBaseArtifactId === canonical.artifact.id
      && jobInput.characterBriefHash === characterBriefHash
      && referencesMatch(inputReferenceIds)
      && job.inputArtifactIds.length === 1
      && job.inputArtifactIds[0] === canonical.artifact.id
      && typeof persisted === "string"
      && Boolean(persisted.trim())
      && persisted.length <= 1600;
    if (matchesCanonical) {
      assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, "identity-guide");
      return persisted.trim();
    }

    // A regenerated/changed base must never inherit anatomy inferred from a
    // different candidate. Reset this internal text job and recompute it from
    // the currently approved, ownership-checked artifact.
    const reset = await ctx.prisma.codexPetJob.updateMany({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: "completed",
      },
      data: {
        status: "queued",
        attempt: 0,
        input: guideBinding as Prisma.InputJsonValue,
        inputArtifactIds: [canonical.artifact.id],
        outputArtifactIds: [],
        output: {} as Prisma.InputJsonValue,
        error: null,
        workerId: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (reset.count !== 1) throw new CodexPetLeaseLostError();
    const resetJob = await ctx.prisma.codexPetJob.findUnique({ where: { id: job.id } });
    if (!resetJob) throw new Error("Identity guide job disappeared while resetting stale output");
    job = resetJob;
  }

  // A queued/running job may predate the anatomy-reference contract. Bind its
  // durable input before invoking the model so crash recovery cannot reuse a
  // guide inferred from a different brief or supporting-reference order.
  job = await ctx.prisma.codexPetJob.update({
    where: { id: job.id },
    data: {
      input: guideBinding as Prisma.InputJsonValue,
      inputArtifactIds: [canonical.artifact.id],
    },
  });

  // Resume a process-interrupted attempt without consuming an automatic retry.
  const firstAttempt = job.status === "running" && job.attempt > 0
    ? job.attempt
    : Math.max(1, job.attempt + 1);
  let lastError = "";
  for (let attempt = firstAttempt; attempt <= job.maxAttempts; attempt += 1) {
    job = await startJob(ctx, job, attempt, 16, "正在分析批准主形象的角色解剖与身份特征");
    let completedGuide: string | null = null;
    try {
      let guideModelProvenance: CodexPetVisualModelProvenance | undefined;
      const generatedGuide = await ctx.identityGuide({
        reference: canonical.buffer,
        mime: canonical.artifact.mime,
        originalReferences: ctx.userReferences,
        characterBrief,
        env: ctx.env,
        signal: ctx.signal,
        onModelProvenance: (provenance) => { guideModelProvenance = provenance; },
      });
      const guide = generatedGuide.replace(/\s+/g, " ").trim().slice(0, 1600);
      if (!guide) throw new Error("角色解剖与身份指南为空");
      const guideProvenance = assertCodexPetVisualQaProvenance(guideModelProvenance, ctx.visualQaModel, "identity-guide");
      await checkCancelled(ctx);
      const completed = await ctx.prisma.codexPetJob.updateMany({
        where: {
          id: job.id,
          runId: ctx.runId,
          projectId: ctx.project.id,
          userId: ctx.project.userId,
          status: "running",
          workerId: ctx.workerId,
        },
        data: {
          status: "completed",
          inputArtifactIds: [canonical.artifact.id],
          outputArtifactIds: [],
          output: {
            version: IDENTITY_GUIDE_VERSION,
            selectedArtifactId: canonical.artifact.id,
            supportingReferenceAssetIds,
            characterBriefHash,
            guide,
            modelProvenance: guideProvenance,
          } as unknown as Prisma.InputJsonValue,
          providerMetadata: {
            visualQa: guideProvenance,
          } as unknown as Prisma.InputJsonValue,
          error: null,
          workerId: null,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) throw new CodexPetLeaseLostError();
      completedGuide = guide;
    } catch (error) {
      if (error instanceof CodexPetLeaseLostError || ctx.signal?.reason instanceof CodexPetLeaseLostError) throw new CodexPetLeaseLostError();
      if (error instanceof CodexPetCancelledError || ctx.signal?.aborted) throw new CodexPetCancelledError();
      lastError = safeError(error);
      await failJobAttempt(ctx, job, attempt, lastError, 16);
      if (error instanceof CodexPetModelContractError) throw error;
      if (attempt >= job.maxAttempts) throw new Error(`角色解剖与身份指南生成失败：${lastError}`);
    }
    if (completedGuide) {
      // The durable job output is authoritative. Event delivery happens after
      // the attempt catch so an event-store failure cannot turn a completed
      // guide back into queued work and invoke the multimodal model twice.
      await emit(ctx, "job.completed", "standard_generating", 16, "角色解剖与身份指南已锁定", {}, job.key).catch(() => undefined);
      return completedGuide;
    }
  }
  throw new Error(`角色解剖与身份指南生成失败：${lastError || "多模态模型未返回结果"}`);
}

async function completedBoardJob(ctx: RunnerContext, job: CodexPetJob): Promise<BoardJobResult | null> {
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

interface BoardJobInputBinding {
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

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function boardJobInputPayload(input: BoardJobInputBinding): Prisma.InputJsonObject {
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

function boardOutputArtifactIds(job: CodexPetJob): string[] {
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
async function bindBoardJobInput(
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
    const lease = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        cancelRequested: false,
      },
      data: { heartbeatAt: new Date() },
    });
    if (lease.count !== 1) throw new CodexPetLeaseLostError();

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
  const normalizedBoard = await composeNormalizedPoseBoard(frames, {
    columns: 4,
    rows: 2,
    chromaKey: ctx.identity.chromaKey,
  });
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
      images: [
        { buffer: canonical.buffer, mime: canonical.artifact.mime },
        { buffer: normalizedBoard, mime: "image/png" },
        { buffer: preview.image, mime: "image/webp" },
      ],
      prompt: buildVisualQaPrompt(
        "row",
        "running-left must face/travel left; the second image is the complete static chronological eight-frame cycle and the third is its animation preview; mirroring must preserve identity, timing and all asymmetric meaning. Images 2 and 3 are pre-despill intermediate assets. Bright magenta/chroma fringe at the alpha boundary is expected here and must never fail mirror suitability: the single deterministic final-atlas despill pass owns chroma cleanup. Judge only facing direction, gait cadence, identity, asymmetric meaning, attachment, clipping and motion continuity.",
        ctx.identity.canonicalGuide,
      ),
      env: ctx.env,
      signal: ctx.signal,
      repetitions: 1,
    });
  } catch (error) {
    await supersedeRejectedMirror().catch(() => undefined);
    await failJobAttempt(ctx, job, 1, safeError(error), 30, true).catch(() => undefined);
    throw error;
  }
  const qaProvenance = assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row-running-left");
  if (!codexPetVisualQaConsensusPasses(qa)) {
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
      providerMetadata: {
        visualQa: qaProvenance,
      } as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
    } });
  });
  return { job, frames, frameArtifacts, board: preview.image, boardArtifact, mirrorSafe: true, qa };
}

function imageInput(buffer: Buffer, mime = "image/png", filename = "reference.png"): ImageBinaryInput {
  return { b64: buffer.toString("base64"), mime, filename };
}

/**
 * GPT Image edits preserves only the first two direction references as
 * independent multipart images and compacts the remaining guidance into one
 * contact sheet. Direction edits keep a deterministic 4×2 direction scaffold
 * first as the primary edit target and canonical identity second. The complete
 * cardinal basis remains in supporting guidance. Standard motion, layout, the
 * registered first row and failed-board diagnostics are useful continuity
 * evidence, but none may outrank the cardinal semantics.
 */
function lookRowReferences(input: {
  readonly row: "look-a" | "look-b";
  readonly anchorStoryboard: Buffer;
  readonly directionArcGuide?: Buffer;
  readonly canonical: { readonly buffer: Buffer; readonly mime: string };
  readonly cardinalAnchor: { readonly buffer: Buffer; readonly mime: string };
  readonly standardContact: Buffer;
  readonly layout: Buffer;
  readonly registeredLookA?: Buffer;
  readonly diagnosticBoard?: Buffer;
}): readonly ImageBinaryInput[] {
  if (input.row === "look-b" && !input.directionArcGuide) {
    throw new Error("look-b requires the deterministic screen-left trajectory scaffold");
  }
  const authoritative = [
    imageInput(
      input.row === "look-b" ? input.directionArcGuide! : input.anchorStoryboard,
      "image/png",
      input.row === "look-b" ? "look-b-screen-left-trajectory-scaffold.png" : "look-a-approved-anchor-storyboard.png",
    ),
    imageInput(input.canonical.buffer, input.canonical.mime, "approved-canonical-base.png"),
  ];
  if (input.row === "look-a") {
    const references = [
      ...authoritative,
      imageInput(input.cardinalAnchor.buffer, input.cardinalAnchor.mime, "approved-cardinal-anchor-strip.png"),
      imageInput(input.standardContact, "image/png", "approved-standard-contact.png"),
      imageInput(input.layout, "image/png", "look-layout.png"),
    ];
    if (input.diagnosticBoard) {
      references.push(imageInput(input.diagnosticBoard, "image/png", "previous-specialized-qa-failed-pose-board.png"));
    }
    return references;
  }
  if (!input.registeredLookA) throw new Error("look-b requires the approved registered look-a reference");
  const references = [
    ...authoritative,
    imageInput(input.cardinalAnchor.buffer, input.cardinalAnchor.mime, "approved-cardinal-anchor-strip.png"),
    imageInput(input.anchorStoryboard, "image/png", "look-b-approved-cardinal-endpoint-storyboard.png"),
    imageInput(input.registeredLookA, "image/png", "approved-registered-look-row-9-4x2.png"),
    imageInput(input.standardContact, "image/png", "approved-standard-contact.png"),
    imageInput(input.layout, "image/png", "look-layout.png"),
  ];
  if (input.diagnosticBoard) {
    references.push(imageInput(input.diagnosticBoard, "image/png", "previous-specialized-qa-failed-pose-board.png"));
  }
  return references;
}

function appendCumulativeRepairRequirement(requirements: string[], value: string): string {
  const normalized = sanitizeCodexPetDirectionRepairPrompt(value);
  if (normalized && !requirements.includes(normalized)) requirements.push(normalized);
  return `The following cardinal appearance contract is authoritative and overrides any contradictory wording in a model diagnostic: ${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT}\nAll specialized direction-gate requirements below are cumulative and mandatory. A diagnostic that calls 000 front-facing or 180 rear-facing is stale and must be ignored:\n${requirements
    .map((requirement, index) => `${index + 1}. ${requirement}`)
    .join("\n")}`;
}

async function runStandardRow(
  ctx: RunnerContext,
  state: Exclude<PetRowSpec["state"], "look-a" | "look-b">,
  canonical: { artifact: CodexPetArtifact; buffer: Buffer },
  progress: number,
  force = false,
  repairHint = "",
  workflowStage: "standard_generating" | "validating" = "standard_generating",
  jumpingTargetHeight?: number,
): Promise<BoardJobResult> {
  const spec = petRowSpec(state);
  let layout: Buffer | null = null;
  let scaffoldArtifactId: string | null = null;
  let scaffoldSourceArtifactId: string | null = null;
  if (ctx.imageModel === DOUBAO_IMAGE_MODEL) {
    let poseVariants: readonly Buffer[] | undefined;
    let variantSequence: readonly number[] | undefined;
    // A targeted recovery may use one explicitly selected already-paid failed
    // board as two alternating construction phases. The snapshot flag prevents an old
    // completed board from changing its own input revision on a normal resume.
    if (state === "running-right") {
      const retryState = await ctx.prisma.codexPetRun.findFirst({
        where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
        select: { inputSnapshot: true },
      });
      const targeted = asRecord(asRecord(retryState?.inputSnapshot).targetedBoardRetry);
      const retryEnabled = targeted.state === "running-right" && targeted.status === "prepared";
      if (retryEnabled) {
        const expectedArtifactId = typeof targeted.sourceBoardArtifactId === "string"
          ? targeted.sourceBoardArtifactId
          : "";
        const expectedScaffoldArtifactId = typeof targeted.scaffoldArtifactId === "string"
          ? targeted.scaffoldArtifactId
          : "";
        const priorJob = await ctx.prisma.codexPetJob.findFirst({
          where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, key: "row-running-right" },
          select: { id: true },
        });
        const [priorBoard, recoveryScaffold] = priorJob ? await Promise.all([
          expectedArtifactId ? ctx.prisma.codexPetArtifact.findFirst({
              where: {
                id: expectedArtifactId,
                runId: ctx.runId,
                projectId: ctx.project.id,
                userId: ctx.project.userId,
                jobId: priorJob.id,
                kind: "pose_board",
                status: "ready",
              },
            }) : null,
          expectedScaffoldArtifactId ? ctx.prisma.codexPetArtifact.findFirst({
            where: {
              id: expectedScaffoldArtifactId,
              runId: ctx.runId,
              projectId: ctx.project.id,
              userId: ctx.project.userId,
              jobId: priorJob.id,
              kind: "pose_board_scaffold",
              status: "ready",
              mime: "image/png",
            },
          }) : null,
        ]) : [null, null];
        if (!priorBoard || priorBoard.id !== expectedArtifactId) {
          throw new Error("受控 running-right 续跑缺少已锁定的失败姿势板");
        }
        scaffoldSourceArtifactId = priorBoard.id;
        if (expectedScaffoldArtifactId) {
          if (!recoveryScaffold) throw new Error("受控 running-right 续跑缺少已锁定的恢复脚手架");
          layout = await ctx.artifacts.load(recoveryScaffold);
          scaffoldArtifactId = recoveryScaffold.id;
        } else {
          const priorBuffer = await ctx.artifacts.load(priorBoard);
          const priorExtracted = await extractPoseBoard(priorBuffer, {
            columns: spec.boardColumns,
            rows: spec.boardRows,
            frameCount: spec.frameCount,
            chromaKey: ctx.identity.chromaKey,
            requireUnusedSlotsEmpty: true,
          });
          if (priorExtracted.ok && priorExtracted.frames.length >= 5) {
            poseVariants = await selectSeedreamGaitScaffoldVariants(priorExtracted.frames);
            variantSequence = [0, 1, 0, 1, 0, 1, 0, 1];
            scaffoldArtifactId = priorBoard.id;
          }
        }
      }
    }
    // A repeated canonical scaffold is useful for the quiet idle row, but it
    // makes Seedream copy one frozen pose into every slot of a dynamic row.
    // Dynamic rows already receive the canonical image separately; omitting
    // the repeated scaffold leaves the action prompt responsible for phase
    // changes instead of supplying six/eight static exemplars to copy.
    if (state === "idle" || poseVariants) {
      layout = await createSeedreamPoseBoardScaffold({
        canonical: canonical.buffer,
        ...(poseVariants ? { poseVariants, variantSequence } : {}),
        chromaKey: ctx.identity.chromaKey,
        columns: spec.boardColumns,
        rows: spec.boardRows,
        frameCount: spec.frameCount,
      });
    }
  } else {
    layout = await createLayoutGuide({ columns: spec.boardColumns, rows: spec.boardRows, frameCount: spec.frameCount, title: `${state} ${spec.frameCount}-pose board` });
  }
  const inputArtifactIds = [...new Set([
    canonical.artifact.id,
    scaffoldSourceArtifactId,
    scaffoldArtifactId,
  ].filter((artifactId): artifactId is string => Boolean(artifactId)))];
  const authoritativeActionPrompt = ctx.identity.actionPrompts?.[state]?.trim();
  return runBoardJob(ctx, {
    key: `row-${state}`,
    kind: "standard_row",
    dependencies: state === "running-left" ? ["row-running-right"] : ["identity-guide"],
    inputArtifactIds,
    prompt: buildStandardRowPrompt(ctx.identity, state),
    promptVersion: codexPetStandardRowPromptVersion(state),
    references: [
      imageInput(canonical.buffer, canonical.artifact.mime, "canonical-base.png"),
      ...(layout ? [imageInput(layout, "image/png", ctx.imageModel === DOUBAO_IMAGE_MODEL ? `${state}-seedream-scaffold.png` : `${state}-layout.png`)] : []),
    ],
    columns: spec.boardColumns,
    rows: spec.boardRows,
    frameCount: spec.frameCount,
    progress,
    qaKind: "row",
    qaContext: `${state} 动作组：身份、${spec.frameCount} 帧结构、动作语义和连续性`,
    workflowStage,
    animationDurations: spec.durations,
    force,
    repairHint,
    jumpingTargetHeight: state === "jumping" ? jumpingTargetHeight : undefined,
    allowAuxiliaryForegroundComponents: Boolean(authoritativeActionPrompt),
    authoritativeActionPrompt,
  });
}

/**
 * A freshly assembled standard atlas failed its deterministic structure gate.
 *
 * The report travels with the error so the caller can regenerate exactly the
 * implicated action groups. At this point in the run no direction row exists
 * yet, so the repair loop lives at the call site rather than here.
 */
class CodexPetStandardAtlasStructureError extends Error {
  constructor(readonly validation: Awaited<ReturnType<typeof validateStandardPetAtlas>>) {
    super(`标准 8×9 图集结构检查失败：${validation.errors.join("；")}`);
    this.name = "CodexPetStandardAtlasStructureError";
  }
}

async function storeStandardAtlas(ctx: RunnerContext, frames: PetFramesByState, force = false): Promise<{
  atlas: Buffer;
  contact: Buffer;
  atlasArtifact: CodexPetArtifact;
  contactArtifact: CodexPetArtifact;
  validation: Awaited<ReturnType<typeof validateStandardPetAtlas>>;
}> {
  const inspectionOptions = {
    allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
  } as const;
  const job = await ensureJob(ctx, "standard-atlas", "deterministic_assembly", PET_ROW_SPECS.slice(0, 9).map((spec) => `row-${spec.state}`));
  const output = asRecord(job.output);
  if (!force && job.status === "completed" && typeof output.atlasArtifactId === "string" && typeof output.contactArtifactId === "string") {
    const [atlasArtifact, contactArtifact] = await Promise.all([
      ctx.prisma.codexPetArtifact.findFirst({ where: { id: output.atlasArtifactId, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } }),
      ctx.prisma.codexPetArtifact.findFirst({ where: { id: output.contactArtifactId, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } }),
    ]);
    if (atlasArtifact && contactArtifact) {
      const [atlas, contact] = await Promise.all([ctx.artifacts.load(atlasArtifact), ctx.artifacts.load(contactArtifact)]);
      const validation = await validateStandardPetAtlas(atlas, inspectionOptions);
      // A recovered atlas that no longer validates carries the same row-scoped
      // evidence as a fresh one, so the caller can repair and force a rebuild
      // instead of failing a run whose rows are mostly good.
      if (!validation.ok) throw new CodexPetStandardAtlasStructureError(validation);
      return { atlas, contact, atlasArtifact, contactArtifact, validation };
    }
  }
  const atlas = await assembleStandardPetAtlas(frames, "webp");
  const validation = await validateStandardPetAtlas(atlas, inspectionOptions);
  if (!validation.ok) throw new CodexPetStandardAtlasStructureError(validation);
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
  const job = await ensureJob(ctx, "look-mechanics", "look_mechanics", ["identity-guide", "standard-atlas"]);
  const output = asRecord(job.output);
  if (!ctx.qualityInspectionEnabled) {
    const mechanics = "Use the approved canonical base. Keep feet on a stable baseline. Turn eyes and head first, let the torso follow slightly, preserve silhouette and scale, and never rotate the whole image or mirror a direction. Each 4x2 board must follow its row-major direction labels exactly.";
    if (job.status === "completed" && output.mode === "fixed" && typeof output.mechanics === "string") return output.mechanics;
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      attempt: Math.max(1, job.attempt + 1),
      output: { mode: "fixed", mechanics } as Prisma.InputJsonValue,
      providerMetadata: { visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    } });
    return mechanics;
  }
  if (job.status === "completed" && typeof output.mechanics === "string") {
    assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, "look-mechanics");
    return output.mechanics;
  }
  let mechanicsModelProvenance: CodexPetVisualModelProvenance | undefined;
  const mechanics = await ctx.lookMechanics({
    prompt: buildLookMechanicsPrompt(ctx.identity),
    reference: canonical.buffer,
    env: ctx.env,
    signal: ctx.signal,
    onModelProvenance: (provenance) => { mechanicsModelProvenance = provenance; },
  });
  const mechanicsProvenance = assertCodexPetVisualQaProvenance(mechanicsModelProvenance, ctx.visualQaModel, "look-mechanics");
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { mechanics, modelProvenance: mechanicsProvenance } as unknown as Prisma.InputJsonValue,
    providerMetadata: {
      visualQa: mechanicsProvenance,
    } as unknown as Prisma.InputJsonValue,
    completedAt: new Date(),
  } });
  return mechanics;
}

function recoveredRegistrationDiagnostics(
  validation: NeutralDirectionGeometryValidation,
): readonly DirectionRegistrationCellDiagnostics[] {
  return validation.frames.map((frame) => ({
    index: frame.index,
    sourceBounds: null,
    sourceGeometry: null,
    normalizedBounds: frame.geometry?.bounds ?? null,
    normalizedGeometry: frame.geometry,
    chromaCoverage: 0,
    edgePixels: frame.edgePixels,
    errors: frame.errors,
    warnings: [...frame.warnings, "recovered-from-registered-artifact"],
  }));
}

function registeredSourceBoardSize(output: Record<string, unknown>, manifest: NeutralDirectionRegistrationManifest): { width: number; height: number } {
  const source = asRecord(output.sourceBoardSize);
  return {
    width: typeof source.width === "number" && Number.isFinite(source.width) ? source.width : manifest.row9Source.width,
    height: typeof source.height === "number" && Number.isFinite(source.height) ? source.height : manifest.row9Source.height,
  };
}

async function completedRegisteredDirectionRow(
  ctx: RunnerContext,
  job: CodexPetJob,
  source: BoardJobResult,
  neutral: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer },
  expectedInputArtifactIds: readonly string[],
  lockedManifestArtifactId?: string,
): Promise<RegisteredDirectionRowResult | null> {
  if (job.status !== "completed" || !sameOrderedStrings(job.inputArtifactIds, expectedInputArtifactIds)) return null;
  const output = asRecord(job.output);
  if (output.sourceBoardArtifactId !== source.boardArtifact.id || output.neutralFrameArtifactId !== neutral.artifact.id
    || typeof output.registeredRowArtifactId !== "string" || typeof output.manifestArtifactId !== "string") return null;
  if (lockedManifestArtifactId && output.manifestArtifactId !== lockedManifestArtifactId) return null;
  const [registeredRowArtifact, manifestArtifact] = await Promise.all([
    ctx.prisma.codexPetArtifact.findFirst({ where: {
      id: output.registeredRowArtifactId,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: "ready",
    } }),
    ctx.prisma.codexPetArtifact.findFirst({ where: {
      id: output.manifestArtifactId,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: "ready",
    } }),
  ]);
  if (!registeredRowArtifact || !manifestArtifact) return null;
  try {
    const [registeredRow, manifestBytes] = await Promise.all([
      ctx.artifacts.load(registeredRowArtifact),
      ctx.artifacts.load(manifestArtifact),
    ]);
    const manifest = parseNeutralDirectionRegistrationManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    const frames = await splitRegisteredDirectionRow(registeredRow);
    const validation = await validateNeutralLockedDirectionFrames(neutral.buffer, frames, manifest.thresholds);
    if (!validation.ok) return null;
    return {
      registrationJob: job,
      source,
      frames,
      registeredRow,
      registeredRowArtifact,
      manifest,
      manifestArtifact,
      validation,
      diagnostics: recoveredRegistrationDiagnostics(validation),
      sourceBoardSize: registeredSourceBoardSize(output, manifest),
      ok: true,
      errors: [],
      warnings: validation.warnings,
    };
  } catch {
    // A missing/corrupt deterministic artifact is cache corruption, not a
    // reason to invoke the image provider. Rebuild it from the durable source
    // board below and preserve the provider attempt budget.
    return null;
  }
}

/**
 * Persist the exact direction cells that QA and final assembly consume.
 * Row 9 creates the immutable neutral registration manifest. Row 10 reuses it
 * verbatim and can never trigger a second fit of the already-approved row 9.
 */
async function registerDirectionRow(
  ctx: RunnerContext,
  input: {
    readonly row: "look-a" | "look-b";
    readonly source: BoardJobResult;
    readonly neutral: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly lockedRow9?: RegisteredDirectionRowResult;
    readonly progress: number;
  },
): Promise<RegisteredDirectionRowResult> {
  if (input.row === "look-b" && (!input.lockedRow9?.registeredRowArtifact || !input.lockedRow9.manifestArtifact)) {
    throw new Error("第二组观察方向缺少已批准的 row-9 注册产物");
  }
  const expectedInputArtifactIds = input.row === "look-a"
    ? [input.source.boardArtifact.id, input.neutral.artifact.id]
    : [
        input.source.boardArtifact.id,
        input.neutral.artifact.id,
        input.lockedRow9!.registeredRowArtifact!.id,
        input.lockedRow9!.manifestArtifact!.id,
      ];
  let job = await ensureJob(
    ctx,
    `${input.row}-registration`,
    "look_direction_registration",
    input.row === "look-a" ? ["look-a", "row-idle"] : ["look-b", "look-a-registration"],
    { row: input.row, schemaVersion: "codex-pet-neutral-direction-registration-v1" },
  );
  const cached = await completedRegisteredDirectionRow(
    ctx,
    job,
    input.source,
    input.neutral,
    expectedInputArtifactIds,
    input.lockedRow9?.manifestArtifact?.id,
  );
  if (cached) return cached;

  await checkCancelled(ctx);
  const obsoleteArtifactIds = [...job.outputArtifactIds];
  if (obsoleteArtifactIds.length > 0) {
    await ctx.prisma.codexPetArtifact.updateMany({
      where: {
        id: { in: obsoleteArtifactIds },
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
      data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
    });
  }
  job = await startJob(
    ctx,
    job,
    Math.max(1, input.source.job.attempt),
    input.progress,
    input.row === "look-a" ? "按已批准 idle 中立帧注册第一组观察方向" : "复用 row-9 固定变换注册第二组观察方向",
  );
  const result = input.row === "look-a"
    ? await registerFirstDirectionRowToNeutral(input.source.board, input.neutral.buffer, {
        chromaKey: ctx.identity.chromaKey,
        frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
      })
    : await registerSecondDirectionRowWithManifest(
        input.source.board,
        input.neutral.buffer,
        input.lockedRow9!.manifest,
        { chromaKey: ctx.identity.chromaKey, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT },
      );
  const reportArtifact = await putJsonArtifact(ctx, {
    jobId: job.id,
    kind: "direction_registration_report",
    name: `${input.row === "look-a" ? "row 9" : "row 10"} 中立帧锁定注册报告 · 第 ${input.source.job.attempt} 次`,
    value: {
      schemaVersion: result.manifest.schemaVersion,
      sourceBoardArtifactId: input.source.boardArtifact.id,
      neutralFrameArtifactId: input.neutral.artifact.id,
      sourceBoardSize: result.sourceBoardSize,
      transform: result.manifest.transform,
      validation: result.validation,
      diagnostics: result.diagnostics,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  if (!result.ok) {
    const rejected = await ctx.prisma.codexPetJob.updateMany({
      where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId },
      data: {
        status: "queued",
        inputArtifactIds: [...expectedInputArtifactIds],
        outputArtifactIds: [reportArtifact.id],
        output: {
          sourceBoardArtifactId: input.source.boardArtifact.id,
          neutralFrameArtifactId: input.neutral.artifact.id,
          reportArtifactId: reportArtifact.id,
          sourceBoardSize: result.sourceBoardSize,
          ok: false,
          errors: result.errors,
        } as Prisma.InputJsonValue,
        error: result.errors.join("；") || "中立帧锁定注册未通过",
        workerId: null,
        completedAt: null,
      },
    });
    if (rejected.count !== 1) throw new CodexPetLeaseLostError();
    return {
      registrationJob: job,
      source: input.source,
      frames: result.frames,
      registeredRow: result.registeredRow,
      registeredRowArtifact: null,
      manifest: result.manifest,
      manifestArtifact: input.lockedRow9?.manifestArtifact ?? null,
      validation: result.validation,
      diagnostics: result.diagnostics,
      sourceBoardSize: result.sourceBoardSize,
      ok: false,
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  const manifestArtifact = input.row === "look-a"
    ? await putJsonArtifact(ctx, {
        jobId: job.id,
        kind: "direction_registration_manifest",
        name: "row 9 中立帧锁定注册 Manifest",
        value: result.manifest,
        expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
      })
    : input.lockedRow9!.manifestArtifact!;
  const registeredRowArtifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "registered_direction_row",
    name: input.row === "look-a" ? "已批准注册 row 9 · 000–157.5" : "固定 row-9 变换注册 row 10 · 180–337.5",
    buffer: result.registeredRow,
    mime: "image/png",
    width: 1536,
    height: 208,
    metadata: {
      row: input.row === "look-a" ? 9 : 10,
      sourceBoardArtifactId: input.source.boardArtifact.id,
      neutralFrameArtifactId: input.neutral.artifact.id,
      manifestArtifactId: manifestArtifact.id,
      schemaVersion: result.manifest.schemaVersion,
      lockedScale: result.manifest.transform.scale,
      target: result.manifest.transform.target,
      validation: {
        medianHeightRatio: result.validation.medianHeightRatio,
        medianWidthRatio: result.validation.medianWidthRatio,
      },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const outputArtifactIds = input.row === "look-a"
    ? [registeredRowArtifact.id, manifestArtifact.id, reportArtifact.id]
    : [registeredRowArtifact.id, reportArtifact.id];
  const completed = await ctx.prisma.codexPetJob.updateMany({
    where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId },
    data: {
      status: "completed",
      inputArtifactIds: [...expectedInputArtifactIds],
      outputArtifactIds,
      output: {
        sourceBoardArtifactId: input.source.boardArtifact.id,
        neutralFrameArtifactId: input.neutral.artifact.id,
        registeredRowArtifactId: registeredRowArtifact.id,
        manifestArtifactId: manifestArtifact.id,
        reportArtifactId: reportArtifact.id,
        sourceBoardSize: result.sourceBoardSize,
        ok: true,
      } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    },
  });
  if (completed.count !== 1) throw new CodexPetLeaseLostError();
  await emit(ctx, "preview.ready", "direction_generating", input.progress,
    input.row === "look-a" ? "第一组观察方向已按中立帧完成固定注册" : "第二组观察方向已复用 row-9 固定注册",
    {
      artifactId: registeredRowArtifact.id,
      manifestArtifactId: manifestArtifact.id,
      lockedScale: result.manifest.transform.scale,
      medianHeightRatio: result.validation.medianHeightRatio,
    }, job.key);
  return {
    registrationJob: { ...job, status: "completed", workerId: null, outputArtifactIds },
    source: input.source,
    frames: result.frames,
    registeredRow: result.registeredRow,
    registeredRowArtifact,
    manifest: result.manifest,
    manifestArtifact,
    validation: result.validation,
    diagnostics: result.diagnostics,
    sourceBoardSize: result.sourceBoardSize,
    ok: true,
    errors: [],
    warnings: result.warnings,
  };
}

function requireApprovedRegisteredRow(result: RegisteredDirectionRowResult, label: string): asserts result is RegisteredDirectionRowResult & {
  readonly registeredRowArtifact: CodexPetArtifact;
  readonly manifestArtifact: CodexPetArtifact;
} {
  if (!result.ok || !result.registeredRowArtifact || !result.manifestArtifact) {
    throw new Error(`${label} 未形成可恢复的注册产物`);
  }
}

async function reviewFirstLookRow(
  ctx: RunnerContext,
  input: {
    readonly look: RegisteredDirectionRowResult;
    readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly standardContact: Buffer;
    readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  },
) {
  const directions = LOOK_DIRECTIONS.slice(0, 8);
  const continuity = await measureDirectionRowContinuity(input.look.frames, directions);
  if (!input.look.ok || !continuity.ok) {
    const failures = [...input.look.errors, ...continuity.errors];
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 000–157.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
      value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, failures },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return {
      pass: false,
      continuity,
      visual: null,
      failures,
      repairPrompt: failures.join("; ") || "repair direction scale, lower-body anchor, baseline, edge clearance or structural cells",
    };
  }
  if (!ctx.qualityInspectionEnabled) {
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 000–157.5 本地注册与连续性检查 · 第 ${input.look.source.job.attempt} 次`,
      value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return { pass: true, continuity, visual: null, failures: [], repairPrompt: "" };
  }
  const preview = await createAnimatedWebpPreview(input.look.frames, petRowSpec("look-a").durations);
  const qa = await ctx.qaConsensus({
    images: [
      { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
      { buffer: input.standardContact, mime: "image/png" },
      { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
      // Keep the complete registered row as a static, inspectable artifact in
      // addition to the animated preview. Some multimodal reviewers inspect
      // only the first animation frame and otherwise cannot verify all eight
      // direction cells or a local reversal.
      { buffer: input.look.registeredRow, mime: "image/png" },
      { buffer: preview.image, mime: preview.mime },
    ],
    prompt: buildVisualQaPrompt(
      "directions",
      `Pre-row-10 gate for the registered row-9 sequence 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5. `
      + `Confirm 000 unmistakably up, 090 unmistakably screen-right, every intermediate stays in its labeled quadrant, and the animated sequence advances clockwise without reversal, registration snap, scale pop or identity drift. `
      + `Image 3 is the authoritative 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. Row-9 cell 1 must match Image 3 top-left's visible front/back appearance, cell 5 must match its top-right, and cell 8 must visibly approach its bottom-left without entering the opposite side. `
      + `Image 4 is the complete static eight-frame registered row in chronological left-to-right order; inspect every cell. Image 5 is its animation preview. `
      + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
      ctx.identity.canonicalGuide,
    ),
    env: ctx.env,
    signal: ctx.signal,
    repetitions: 1,
  });
  assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row9-pre-generation-gate");
  await putJsonArtifact(ctx, {
    jobId: input.look.registrationJob.id,
    kind: "qa_report",
    name: `方向 000–157.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
    value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, visual: qa },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const passed = codexPetVisualQaConsensusPasses(qa);
  return {
    pass: passed,
    continuity,
    visual: qa,
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
    readonly look: RegisteredDirectionRowResult;
    readonly previousLook: RegisteredDirectionRowResult;
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
  if (!ctx.qualityInspectionEnabled && input.look.ok && continuity.ok) {
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 180–337.5 本地注册与连续性检查 · 第 ${input.look.source.job.attempt} 次`,
      value: { row: 10, directions, neutralRegistration: input.look.validation, deterministicContinuity: continuity, visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return { pass: true, continuity, visual: null, failures: [], repairPrompt: "" };
  }
  if (input.look.ok && continuity.ok) {
    qa = await ctx.qaConsensus({
      images: [
        { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
        { buffer: input.standardContact, mime: "image/png" },
        { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
        { buffer: input.previousLook.registeredRow, mime: "image/png" },
        { buffer: input.look.registeredRow, mime: "image/png" },
        { buffer: preview.image, mime: preview.mime },
      ],
      prompt: buildVisualQaPrompt(
        "directions",
        `Independent pre-row-10 gate for registered directions 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5. `
        + `Confirm 180 unmistakably down, 270 unmistakably screen-left, every intermediate remains in its labeled quadrant, and the animated row advances clockwise without reversal, registration snap, scale pop or identity drift. `
        + `Image 3 is the authoritative 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. Image 4 is approved row 9; Image 5 is the complete static row 10 in chronological left-to-right order; Image 6 is its animation preview. Row-10 cell 1 must match Image 3 bottom-left and cell 5 must match Image 3 bottom-right. `
        + `Compare the preceding 157.5 frame from row 9 and the 000 anchor for both row-boundary seams. `
        + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
        ctx.identity.canonicalGuide,
      ),
      env: ctx.env,
      signal: ctx.signal,
      repetitions: 1,
    });
    assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row10-pre-generation-gate");
  }
  const failures = [...input.look.errors, ...continuity.errors, ...qa.failures];
  const repairPrompt = qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt
    || failures.join("; ")
    || "strengthen the complete 180–337.5 direction row and both row-boundary seams";
  await putJsonArtifact(ctx, {
    jobId: input.look.registrationJob.id,
    kind: "qa_report",
    name: `方向 180–337.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
    value: {
      row: 10,
      directions,
      neutralRegistration: input.look.validation,
      deterministicContinuity: continuity,
      visual: qa,
      animationPreview: { frameCount: preview.frameCount, durations: preview.durations },
      previousRowArtifactId: input.previousLook.registeredRowArtifact?.id ?? null,
      cardinalAnchorArtifactId: input.cardinalAnchor.artifact.id,
      row10PreGenerationGate: { passed: input.look.ok && continuity.ok && codexPetVisualQaConsensusPasses(qa), failures },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  return {
    pass: input.look.ok && continuity.ok && codexPetVisualQaConsensusPasses(qa),
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

const REQUIRED_VISUAL_JOB_KEYS = [
  "identity-guide",
  "row-idle",
  "row-running-right",
  "row-running-left",
  "row-waving",
  "row-jumping",
  "row-failed",
  "row-waiting",
  "row-running",
  "row-review",
  "look-mechanics",
  "look-cardinals",
  "look-a",
  "look-b",
] as const;

interface VisualQaProvenanceSummary {
  readonly requestedModel: string;
  readonly actualModels: readonly string[];
  readonly routes: readonly string[];
}

export function assertCodexPetVisualQaProvenance(value: unknown, expectedModel: string, label: string): VisualQaProvenanceSummary {
  const row = asRecord(value);
  const actualModels = [...new Set([
    ...(typeof row.actualModel === "string" ? [row.actualModel.trim()] : []),
    ...(Array.isArray(row.actualModels)
      ? row.actualModels.filter((model): model is string => typeof model === "string").map((model) => model.trim())
      : []),
  ].filter(Boolean))];
  const routes = [...new Set([
    ...(typeof row.route === "string" ? [row.route.trim()] : []),
    ...(Array.isArray(row.routes)
      ? row.routes.filter((route): route is string => typeof route === "string").map((route) => route.trim())
      : []),
  ].filter(Boolean))];
  const expectedRoute = codexPetVisualQaRouteForModel(expectedModel);
  if (row.requestedModel !== expectedModel
    || actualModels.length === 0
    || actualModels.some((model) => !isAllowedCodexPetVisualModel(model) || model !== expectedModel)
    || routes.length === 0
    || routes.some((route) => route !== expectedRoute)) {
    throw new CodexPetModelContractError(`${label} 缺少可信的 ${expectedModel} 模型来源证明`);
  }
  return { requestedModel: expectedModel, actualModels, routes };
}

async function summarizeRequiredVisualJobProvenance(ctx: RunnerContext): Promise<VisualQaProvenanceSummary> {
  const jobs = await ctx.prisma.codexPetJob.findMany({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      key: { in: ["base-selection", ...REQUIRED_VISUAL_JOB_KEYS] },
    },
  });
  const requiredKeys: string[] = [...REQUIRED_VISUAL_JOB_KEYS];
  const baseSelection = jobs.find((job) => job.key === "base-selection");
  if (!baseSelection) throw new Error("主形象选择任务缺失，不能证明可选视觉模型合同");
  if (asRecord(baseSelection.output).selectionMode !== "manual") requiredKeys.push("base-selection");

  const actualModels = new Set<string>();
  const routes = new Set<string>();
  for (const key of requiredKeys) {
    const job = jobs.find((candidate) => candidate.key === key);
    if (!job || job.status !== "completed") throw new Error(`${key} 未完成，不能证明可选视觉模型合同`);
    const visualQa = asRecord(job.providerMetadata).visualQa;
    const provenance = assertCodexPetVisualQaProvenance(visualQa, ctx.visualQaModel, key);
    provenance.actualModels.forEach((model) => actualModels.add(model));
    provenance.routes.forEach((route) => routes.add(route));
  }
  return { requestedModel: ctx.visualQaModel, actualModels: [...actualModels], routes: [...routes] };
}

async function refundRun(ctx: RunnerContext, reason: string): Promise<boolean> {
  if (ctx.perImageBilling) {
    await settlePerImageBilling(ctx, false);
    return true;
  }
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

async function settlePerImageRunBilling(input: {
  readonly prisma: PrismaClient;
  readonly billing: CodexPetRunnerDeps["billing"];
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workerId?: string;
}): Promise<void> {
  const run = await input.prisma.codexPetRun.findFirst({
    where: { id: input.runId, projectId: input.projectId, userId: input.userId },
  });
  if (!run || run.billingMode !== CODEX_PET_PER_IMAGE_BILLING_MODE || run.billingSettlementStatus === "settled") return;
  if (!run.billingOperationId || !run.billingResourceKey || !input.billing.settleResource) {
    throw new Error("Codex pet per-image billing settlement is unavailable");
  }
  if (run.billingSettlementStatus !== "reserved" && run.billingSettlementStatus !== "settle_failed") return;
  // A call that failed at the provider delivered no image, so it is not settled:
  // the completed `老鼠猫`-era run settled 12 units of which 9 had failed, billing
  // the user 1800 points for nothing. `sentAt` still gates the count, so a call
  // that never reached fetch stays free either way.
  const units = await input.prisma.codexPetImageCall.count({
    where: {
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      callKind: "planned",
      sentAt: { not: null },
      status: { not: "failed" },
    },
  });
  const receipt = await input.billing.settleResource({
    operationId: run.billingOperationId,
    resourceKey: run.billingResourceKey,
    units,
  });
  const changed = await input.prisma.codexPetRun.updateMany({
    where: {
      id: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingSettlementStatus: { not: "settled" },
      ...(input.workerId ? { workerId: input.workerId } : {}),
    },
    data: {
      billingSettledUnits: units,
      billingSettledPoints: receipt.settled,
      billingPoints: receipt.settled,
      billingSettlementStatus: "settled",
      billingSettledAt: new Date(),
    },
  });
  if (changed.count !== 1 && input.workerId) throw new CodexPetLeaseLostError();
}

async function settlePerImageBilling(ctx: RunnerContext, requireLease = true): Promise<void> {
  if (!ctx.perImageBilling) return;
  await settlePerImageRunBilling({
    prisma: ctx.prisma,
    billing: ctx.billing,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    ...(requireLease ? { workerId: ctx.workerId } : {}),
  });
}

/**
 * Settling is irreversible: every resume path (worker eligibility, extra-call
 * approval, failed continuation) requires billingSettlementStatus="reserved",
 * so settling a failed run condemns it permanently even when its paid artifacts
 * are intact and the only defect was a fixable bug. A failure therefore must
 * not settle; the worker maintenance sweeper closes the reservation after a
 * grace window if nobody resumed the run.
 *
 * The one exception is a failure that never sent a paid call: there is nothing
 * to resume and nothing was spent, so releasing the hold at once is strictly
 * better for the user than freezing their points for the whole window.
 */
async function settlePerImageBillingOnFailure(ctx: RunnerContext): Promise<"settled" | "deferred"> {
  const sentPlannedCalls = await ctx.prisma.codexPetImageCall.count({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      callKind: "planned",
      sentAt: { not: null },
    },
  });
  if (sentPlannedCalls > 0) return "deferred";
  await settlePerImageBilling(ctx, false);
  return "settled";
}

async function recordPerImageSettlementFailure(ctx: RunnerContext, error: unknown): Promise<void> {
  await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingSettlementStatus: { not: "settled" },
    },
    data: {
      billingSettlementStatus: "settle_failed",
      billingChargeError: safeError(error),
    },
  }).catch(() => undefined);
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
  if (outcome.run?.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
    try {
      // Same rule as settlePerImageBillingOnFailure: only a failure that spent
      // nothing may settle here, because settling closes every resume path.
      const sentPlannedCalls = await input.prisma.codexPetImageCall.count({
        where: {
          runId: input.runId,
          projectId: input.project.id,
          userId: input.project.userId,
          callKind: "planned",
          sentAt: { not: null },
        },
      });
      if (sentPlannedCalls > 0) return;
      await settlePerImageRunBilling({
        prisma: input.prisma,
        billing: input.billing,
        runId: input.runId,
        projectId: input.project.id,
        userId: input.project.userId,
      });
    } catch (billingError) {
      await input.prisma.codexPetRun.updateMany({
        where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: { not: "settled" } },
        data: { billingSettlementStatus: "settle_failed", billingChargeError: safeError(billingError) },
      }).catch(() => undefined);
    }
    return;
  }
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
  const gateFailure = error instanceof CodexPetGateFailureError && error.rows.length > 0 ? error : null;
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
        // A gate that named its rows leaves behind actionable work: persist that
        // scope so 失败续跑 can redo exactly those action groups. Without it the
        // rows are all `completed` at the current prompt version and admission
        // has nothing to reset, which made this failure shape non-continuable.
        ...(gateFailure
          ? {
            inputSnapshot: {
              ...asRecord(current.inputSnapshot),
              gateFailure: codexPetGateFailureSnapshotValue({
                gate: gateFailure.gate,
                rows: gateFailure.rows,
                failures: gateFailure.failures,
                recordedAt: now,
              }),
            } as Prisma.InputJsonObject,
          }
          : {}),
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    const unfinishedJobs: Prisma.CodexPetJobWhereInput = {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: { in: ["queued", "running"] },
    };
    await tx.codexPetJob.updateMany({
      where: {
        ...unfinishedJobs,
        error: null,
      },
      data: {
        error: "同一运行中的其他任务失败，当前任务已停止",
      },
    });
    await tx.codexPetJob.updateMany({
      where: unfinishedJobs,
      data: {
        status: "cancelled",
        completedAt: now,
        workerId: null,
      },
    });
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
    ...(gateFailure ? { gate: gateFailure.gate, repairRows: [...gateFailure.rows] } : {}),
    ...(failure.transportCode ? { transportCode: failure.transportCode } : {}),
    ...(failure.upstreamRequestId ? { upstreamRequestId: failure.upstreamRequestId } : {}),
  }).catch(() => undefined);
  if (ctx.perImageBilling) {
    try {
      const settlementOutcome = await settlePerImageBillingOnFailure(ctx);
      if (settlementOutcome === "deferred") {
        await emit(ctx, "billing.settlement_deferred", "failed", outcome.run?.progressPercent ?? 0,
          "本次失败未结清调用额度，已付费素材仍可在续跑窗口期内复用", {
            reason: "failure_is_resumable",
          }).catch(() => undefined);
      }
    } catch (billingError) {
      await recordPerImageSettlementFailure(ctx, billingError);
    }
    return;
  }
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
  if (ctx.perImageBilling) {
    try {
      await settlePerImageBilling(ctx, false);
    } catch (billingError) {
      await recordPerImageSettlementFailure(ctx, billingError);
    }
    return;
  }
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

function archiveErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Serialize every knowledge-archive Job transition with the owning Run row.
 *
 * A Job-level workerId alone is not a lease: after a stale-run takeover the
 * old process can still finish an in-flight database call. Locking and
 * checking the Run in the same transaction prevents that process from
 * changing the Job after a newer worker owns the Run.
 */
async function withCurrentKnowledgeArchiveLease<T>(
  ctx: RunnerContext,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return ctx.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ readonly id: string }>>`
      SELECT "id"
      FROM "CodexPetRun"
      WHERE "id" = ${ctx.runId}
        AND "projectId" = ${ctx.project.id}
        AND "userId" = ${ctx.project.userId}
        AND "workerId" = ${ctx.workerId}
        AND "status" = 'archiving'
        AND "cancelRequested" = false
      FOR UPDATE
    `;
    if (locked.length !== 1) throw new CodexPetLeaseLostError();
    return operation(tx);
  });
}

async function transitionKnowledgeArchiveJob(
  ctx: RunnerContext,
  job: CodexPetJob,
  data: Prisma.CodexPetJobUpdateManyMutationInput,
): Promise<CodexPetJob> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const changed = await tx.codexPetJob.updateMany({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: job.status,
        workerId: job.workerId,
      },
      data,
    });
    if (changed.count !== 1) throw new CodexPetLeaseLostError();
    const updated = await tx.codexPetJob.findFirst({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
    });
    if (!updated) throw new CodexPetLeaseLostError();
    return updated;
  });
}

async function ensureKnowledgeArchiveJob(
  ctx: RunnerContext,
  maxAttempts: number,
): Promise<CodexPetJob> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const job = await tx.codexPetJob.upsert({
      where: { runId_key: { runId: ctx.runId, key: "knowledge-archive" } },
      create: {
        projectId: ctx.project.id,
        runId: ctx.runId,
        userId: ctx.project.userId,
        key: "knowledge-archive",
        kind: "knowledge_archive",
        dependencyKeys: ["standard-atlas", "look-a", "look-b"],
        maxAttempts,
      },
      update: { maxAttempts },
    });
    if (job.runId !== ctx.runId
      || job.projectId !== ctx.project.id
      || job.userId !== ctx.project.userId) {
      throw new Error("Codex pet knowledge archive job ownership mismatch");
    }
    return job;
  });
}

/**
 * `archiveCodexPetRun` commits the Document and Run link atomically, but the
 * process can die before it checkpoints the Job. In that case the ownership-
 * scoped Run link is the durable result. Reconcile the Job without consuming
 * another attempt or calling the archive routine again.
 */
async function reconcileKnowledgeArchiveJob(
  ctx: RunnerContext,
  job: CodexPetJob,
): Promise<string | null> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const run = await tx.codexPetRun.findFirst({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "archiving",
        cancelRequested: false,
      },
      select: { knowledgeDocumentId: true },
    });
    if (!run) throw new CodexPetLeaseLostError();
    if (!run.knowledgeDocumentId) return null;

    const document = await tx.document.findFirst({
      where: {
        id: run.knowledgeDocumentId,
        sourceModule: "codex_pet",
        sourceId: ctx.runId,
        kb: {
          ownerType: "USER",
          userId: ctx.project.userId,
          systemKey: "AI_ARTIFACTS",
        },
      },
      select: { id: true },
    });
    if (!document) return null;

    const previous = asRecord(job.output);
    if (job.status === "completed"
      && job.workerId === null
      && previous.documentId === document.id) {
      return document.id;
    }
    const changed = await tx.codexPetJob.updateMany({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: job.status,
        workerId: job.workerId,
      },
      data: {
        status: "completed",
        output: { documentId: document.id } as Prisma.InputJsonValue,
        completedAt: new Date(),
        workerId: null,
        error: null,
      },
    });
    if (changed.count !== 1) throw new CodexPetLeaseLostError();
    return document.id;
  });
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
  let job = await ensureKnowledgeArchiveJob(ctx, maxAttempts);

  const reconciledDocumentId = await reconcileKnowledgeArchiveJob(ctx, job);
  if (reconciledDocumentId) return reconciledDocumentId;

  const previous = asRecord(job.output);
  if (job.status === "completed") {
    throw new Error(typeof previous.documentId === "string" && previous.documentId
      ? "知识库归档 checkpoint 与运行关联不一致"
      : "知识库归档 checkpoint 缺少文档 ID");
  }
  if (job.status === "failed" || job.status === "cancelled") {
    throw new Error(job.error || "AI 产物知识库归档任务已终止");
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new Error(`无法从 ${job.status} 状态恢复知识库归档任务`);
  }

  // A process crash can leave a running Job behind while the Run lease is
  // later reclaimed. Resume that exact attempt; only a durably queued retry
  // consumes the next bounded attempt.
  const recoveringRunningAttempt = job.status === "running";
  const attempt = recoveringRunningAttempt ? Math.max(1, job.attempt) : job.attempt + 1;
  if (attempt > job.maxAttempts) throw new Error("AI 产物知识库归档重试次数已耗尽");
  job = await transitionKnowledgeArchiveJob(ctx, job, {
    status: "running",
    attempt,
    workerId: ctx.workerId,
    startedAt: recoveringRunningAttempt ? job.startedAt ?? new Date() : new Date(),
    completedAt: null,
    error: null,
  });
  if (attempt === 1 && !recoveringRunningAttempt) {
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
      workerId: ctx.workerId,
    })).documentId;
    if (!documentId) throw new Error("知识库归档未返回文档 ID");
    job = await transitionKnowledgeArchiveJob(ctx, job, {
      status: "completed",
      output: { documentId } as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
      error: null,
    });
    await emit(ctx, "knowledge.archive_completed", "archiving", 98, "已归档到 AI 产物知识库", {
      knowledgeDocumentId: documentId,
      attempt,
    }, job.key).catch(() => undefined);
    return documentId;
  } catch (error) {
    if (error instanceof CodexPetLeaseLostError || archiveErrorCode(error) === "lease_lost") {
      throw new CodexPetLeaseLostError();
    }
    if (archiveErrorCode(error) === "cancelled") throw new CodexPetCancelledError();
    const terminal = terminalArchiveError(error) || attempt >= job.maxAttempts;
    job = await transitionKnowledgeArchiveJob(ctx, job, {
      status: terminal ? "failed" : "queued",
      workerId: null,
      error: safeError(error),
      completedAt: terminal ? new Date() : null,
    });
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
  await settlePerImageBilling(ctx);
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

async function releaseDeferredPackagingLease(ctx: RunnerContext, error: CodexPetPackagingDeferredError): Promise<boolean> {
  const released = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: "packaging",
      cancelRequested: false,
    },
    data: {
      progressStage: "packaging",
      progressPercent: 94,
      progressMessage: `最终打包暂时失败，等待重试（${error.attempt}/${error.maxAttempts}）`,
      error: error.message,
      workerId: null,
      heartbeatAt: null,
    },
  });
  return released.count === 1;
}

async function deferRecoveryPackaging(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  const released = await ctx.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "packaging",
        billingChargeStatus: "not_required",
        billingPoints: 0,
        cancelRequested: false,
      },
      data: {
        progressStage: "packaging",
        progressPercent: 94,
        progressMessage: "恢复运行正在等待最终打包 checkpoint",
        error: null,
        workerId: null,
        heartbeatAt: null,
      },
    });
    if (changed.count !== 1) return false;
    await tx.codexPetProject.updateMany({
      where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
      data: { status: "packaging" },
    });
    return true;
  });
  if (!released) throw new CodexPetLeaseLostError();
  return { status: "packaging", runId: ctx.runId };
}

async function continueAfterDurablePackaging(
  ctx: RunnerContext,
  packaged: CodexPetDurablePackagingResult,
): Promise<CodexPetExecutionResult> {
  // The Job, all final artifact ids, validation report and archiving stage are
  // already committed atomically. Realtime events are a best-effort view of
  // that database truth and must never downgrade or refund a valid package.
  await emit(ctx, "package.ready", "packaging", 98, "Codex v2 安装包已生成", {
    spritesheetArtifactId: packaged.spritesheetArtifactId,
    packageArtifactId: packaged.packageArtifactId,
    previewArtifactId: packaged.previewArtifactId,
    recovered: packaged.recovered,
  }, "final-package").catch(() => undefined);
  await emit(ctx, "stage.started", "archiving", 98, "正在归档到 AI 产物知识库", {
    finalPackageJobId: packaged.jobId,
  }, "final-package").catch(() => undefined);
  return completeKnowledgeArchive(ctx);
}

async function resumeDurablePackaging(ctx: RunnerContext): Promise<CodexPetExecutionResult | null> {
  const provider = await summarizeProviderUsage(ctx);
  const packaged = await persistOrResumeCodexPetFinalPackage({
    prisma: ctx.prisma,
    artifacts: ctx.artifacts,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    displayName: ctx.identity.name,
    description: ctx.identity.description,
    chromaKey: ctx.identity.chromaKey,
    provider,
  });
  return packaged ? continueAfterDurablePackaging(ctx, packaged) : null;
}

async function executeRun(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  let run = await currentRun(ctx);
  if (run.status === "ready") return { status: "ready", runId: ctx.runId };
  if (run.status === "failed") return { status: "failed", runId: ctx.runId };
  if (run.status === "cancelled" || run.cancelRequested) throw new CodexPetCancelledError();
  if (run.status === "archiving") return completeKnowledgeArchive(ctx);
  if (run.status === "packaging") {
    const recoveryRun = isCodexPetRecoverySnapshot(run.inputSnapshot);
    if (recoveryRun) {
      const finalPackageJob = await ctx.prisma.codexPetJob.findUnique({
        where: { runId_key: { runId: ctx.runId, key: "final-package" } },
        select: { id: true },
      });
      if (!finalPackageJob) return deferRecoveryPackaging(ctx);
      const resumed = await resumeDurablePackaging(ctx);
      return resumed ?? deferRecoveryPackaging(ctx);
    }
    const resumed = await resumeDurablePackaging(ctx);
    if (resumed) return resumed;
    // Legacy packaging rows predate final-package checkpoints. Replay the
    // graph once to establish the new durable source/output manifest.
  }

  await stage(ctx, "base_generating", 5, "正在生成主形象候选");
  const visualConcurrency = configuredVisualConcurrency(ctx.env);
  const candidates = await mapWithConcurrency(
    [1, 2],
    visualConcurrency,
    (candidateIndex, _index, signal) => generateBaseCandidate({ ...ctx, signal }, candidateIndex),
    ctx.signal,
  );
  await checkCancelled(ctx);
  run = await currentRun(ctx);
  let selectedArtifactId = run.selectedBaseArtifactId;
  if (!selectedArtifactId && run.autoContinue && ctx.qualityInspectionEnabled) {
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
  await ensurePersistedBaseSelection(ctx, selectedArtifactId);
  await emit(ctx, "stage.completed", "base_generating", 15, "主形象已确认", { selectedArtifactId });

  // Base generation and base-choice QA intentionally run without a guide:
  // the approved image does not exist yet. From this durable point onward,
  // every generation/QA prompt receives the recovered canonical guide.
  ctx.identity.canonicalGuide = await getIdentityGuide(ctx, selected);

  await stage(ctx, "standard_generating", 16, "正在制作 9 组标准动作");
  // Idle is the cheapest identity/continuity gate for the whole standard
  // stage. Keep it ahead of running-right so a bad canonical micro-loop does
  // not spend a second real image call on a sibling action that will be
  // discarded immediately. The remaining rows start only after both critical
  // gates pass.
  let idle = await runStandardRow(ctx, "idle", selected, 20);
  let jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
  await resumeStageIfRepairing(ctx, "standard_generating", 25, "正在制作 9 组标准动作");
  let runningRight = await runStandardRow(ctx, "running-right", selected, 25);
  await resumeStageIfRepairing(ctx, "standard_generating", 25, "正在制作 9 组标准动作");
  let runningLeft: BoardJobResult;
  if (!ctx.qualityInspectionEnabled) {
    runningLeft = await runStandardRow(ctx, "running-left", selected, 30);
  } else if (codexPetShouldMirrorRunningLeft(runningRight.mirrorSafe, ctx.identity.actionPrompts)) {
    try {
      runningLeft = await deriveRunningLeft(ctx, runningRight, selected);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MIRROR_NOT_SAFE") throw error;
      runningLeft = await runStandardRow(ctx, "running-left", selected, 30, true, "Do not mirror: preserve asymmetric markings, prop handedness and leftward action explicitly.");
    }
  } else {
    runningLeft = await runStandardRow(ctx, "running-left", selected, 30);
  }
  await resumeStageIfRepairing(ctx, "standard_generating", 30, "正在制作 9 组标准动作");
  const remainingStates = ["waving", "jumping", "failed", "waiting", "running", "review"] as const;
  const remaining = new Map<(typeof remainingStates)[number], BoardJobResult>();
  // Keep the rest of the standard graph ordered as well. This prevents five
  // unrelated paid calls from being in flight when one action fails QA, which
  // is especially important for a user-requested single acceptance run.
  const remainingResults: BoardJobResult[] = [];
  for (const [index, stateName] of remainingStates.entries()) {
    remainingResults.push(await runStandardRow(
      ctx,
      stateName,
      selected,
      35 + index * 5,
      false,
      "",
      "standard_generating",
      stateName === "jumping" ? jumpingTargetHeight : undefined,
    ));
  }
  await resumeStageIfRepairing(ctx, "standard_generating", 60, "9 组标准动作已通过逐组检查，正在组装中间图集");
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
  // Assembling the intermediate is the first moment all nine action groups are
  // graded together. A rejection here names its cells, so regenerate only the
  // implicated groups instead of failing a run that already paid for eleven
  // boards; each repair is one extra call that the caller still has to approve
  // under per-image billing.
  const standardAtlasMaxAttempts = 2;
  let assembledStandard: Awaited<ReturnType<typeof storeStandardAtlas>> | null = null;
  for (let standardAttempt = 1; standardAttempt <= standardAtlasMaxAttempts; standardAttempt += 1) {
    try {
      assembledStandard = await storeStandardAtlas(ctx, frames, standardAttempt > 1);
      break;
    } catch (error) {
      if (!(error instanceof CodexPetStandardAtlasStructureError)) throw error;
      const rows = repairRowsFromAtlasValidation(error.validation);
      const unscoped = atlasValidationErrorsWithoutCellScope(error.validation);
      if (unscoped.length > 0 || rows.length === 0) throw error;
      if (standardAttempt >= standardAtlasMaxAttempts) {
        throw new CodexPetGateFailureError(
          error.message,
          "standard-atlas-structure",
          rows,
          [...error.validation.errors],
        );
      }
      const failures = [...error.validation.errors];
      const repairHint = `修复以下动作组的结构缺陷（单元格空白、越界或未用格位不透明）：${failures.slice(0, 20).join("；")}`;
      await emit(ctx, "run.repairing", "repairing", 62, `标准图集结构缺陷动作组修复 ${standardAttempt}/${standardAtlasMaxAttempts - 1}`, { retryKind: "visual", rows, failures });
      const standardRows = codexPetCoupledStandardRepairRows(
        rows.filter((row): row is StandardRepairRow => row !== "look-a" && row !== "look-b"),
      );
      const progressByState: Record<string, number> = { idle: 20, "running-right": 25, "running-left": 30, waving: 35, jumping: 40, failed: 45, waiting: 50, running: 55, review: 60 };
      for (const state of standardRows) {
        const result = await runStandardRow(
          ctx,
          state,
          selected,
          progressByState[state] ?? 60,
          true,
          repairHint,
          "standard_generating",
          state === "jumping" ? jumpingTargetHeight : undefined,
        );
        if (state === "idle") {
          idle = result;
          jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
        }
        else if (state === "running-right") runningRight = result;
        else if (state === "running-left") runningLeft = result;
        else remaining.set(state, result);
        frames[state] = result.frames;
      }
      await resumeStageIfRepairing(ctx, "standard_generating", 62, "标准动作结构修复完成，正在重新组装中间图集");
    }
  }
  if (!assembledStandard) throw new Error("标准 8×9 图集没有生成完整报告");
  let standard = assembledStandard;
  await emit(ctx, "stage.completed", "standard_generating", 65, "9 组标准动作已完成", { contactArtifactId: standard.contactArtifact.id });

  await stage(ctx, "direction_generating", 65, "正在制作 16 个观察方向");
  const mechanics = await getLookMechanics(ctx, selected);
  const cardinalLayout = ctx.imageModel === DOUBAO_IMAGE_MODEL
    ? await createSeedreamPoseBoardScaffold({ canonical: selected.buffer, chromaKey: ctx.identity.chromaKey, columns: 2, rows: 2, frameCount: 4 })
    : await createLayoutGuide({ columns: 2, rows: 2, frameCount: 4, title: "Four cardinal look anchors: up, right, down, left" });
  let cardinals = await runBoardJob(ctx, {
    key: "look-cardinals",
    kind: "look_cardinals",
    dependencies: ["look-mechanics", "standard-atlas"],
    inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
    prompt: buildCardinalPrompt(ctx.identity, mechanics),
    // The canonical character and deterministic 2x2 guide fully define this
    // board. Uploading the large standard contact sheet as a third image adds
    // no cardinal evidence and can push relay edits past its first-response
    // window. Keep the contact artifact in job provenance/dependencies, but
    // do not send it to the model for this request.
    references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
    columns: 2,
    rows: 2,
    frameCount: 4,
    progress: 68,
    qaKind: "cardinals",
    qaContext: "四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左",
    qaRepetitions: 3,
  });
  let cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals);
  await resumeStageIfRepairing(ctx, "direction_generating", 68, "四个观察方向锚点已通过，正在生成第一组方向");
  const lookLayout = ctx.imageModel === DOUBAO_IMAGE_MODEL
    ? await createSeedreamPoseBoardScaffold({ canonical: selected.buffer, chromaKey: ctx.identity.chromaKey, columns: 4, rows: 2, frameCount: 8 })
    : await createLayoutGuide({
        columns: 4,
        rows: 2,
        frameCount: 8,
        title: "Eight clockwise look directions · follow the row-major frame numbers",
        slotLabels: ["1", "2", "3", "4", "5", "6", "7", "8"],
      });
  let lookAAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-a", ctx.identity.chromaKey);
  let lookBAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-b", ctx.identity.chromaKey);
  let lookA = await runBoardJob(ctx, {
    key: "look-a",
    kind: "look_row",
    dependencies: ["look-cardinals"],
    inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, standard.contactArtifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics),
    references: lookRowReferences({
      row: "look-a",
      anchorStoryboard: lookAAnchorStoryboard,
      canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
      cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
      standardContact: standard.contact,
      layout: lookLayout,
    }),
    columns: 4,
    rows: 2,
    frameCount: 8,
    frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    progress: 72,
    qaKind: "directions",
    qaContext: "方向 000 到 157.5 的连续顺时针观察动作",
    animationDurations: petRowSpec("look-a").durations,
  });
  let neutralDirectionFrame = { artifact: idle.frameArtifacts[0]!, buffer: idle.frames[0]! };
  let registeredLookA = await registerDirectionRow(ctx, {
    row: "look-a",
    source: lookA,
    neutral: neutralDirectionFrame,
    progress: 73,
  });
  let firstLookGate = await reviewFirstLookRow(ctx, { look: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  const firstLookRepairRequirements: string[] = [];
  while (!firstLookGate.pass) {
    if (lookA.job.attempt >= lookA.job.maxAttempts) {
      const message = `方向 000 到 157.5 未通过 row-10 前置门禁：${firstLookGate.failures.join("；") || "方向语义或连续性失败"}`;
      if (ctx.perImageBilling || ctx.env.CODEX_PET_IMAGE_APPROVAL_GATE !== "0") {
        throw new CodexPetImageApprovalRequiredError("look-a", `${message}，需要确认后才能重新生成`);
      }
      throw new Error(message);
    }
    await emit(ctx, "run.repairing", "repairing", 74, "正在修复第一组观察方向，第二组尚未启动", {
      attempt: lookA.job.attempt,
      retryKind: "visual",
      failures: firstLookGate.failures,
    }, lookA.job.key);
    const diagnosticBoard = lookA.board;
    const cumulativeRepairHint = appendCumulativeRepairRequirement(
      firstLookRepairRequirements,
      firstLookGate.repairPrompt || firstLookGate.failures.join("；") || "Keep the complete 000 through 157.5 row on one monotonic clockwise screen-right arc.",
    );
    lookA = await runBoardJob(ctx, {
      key: "look-a",
      kind: "look_row",
      dependencies: ["look-cardinals"],
      inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, standard.contactArtifact.id],
      prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics),
      references: lookRowReferences({
        row: "look-a",
        anchorStoryboard: lookAAnchorStoryboard,
        canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
        cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
        standardContact: standard.contact,
        layout: lookLayout,
        diagnosticBoard,
      }),
      columns: 4,
      rows: 2,
      frameCount: 8,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
      progress: 74,
      qaKind: "directions",
      qaContext: "修复方向 000 到 157.5 的完整连续动作组",
      animationDurations: petRowSpec("look-a").durations,
      force: true,
      repairHint: cumulativeRepairHint,
    });
    registeredLookA = await registerDirectionRow(ctx, {
      row: "look-a",
      source: lookA,
      neutral: neutralDirectionFrame,
      progress: 73,
    });
    firstLookGate = await reviewFirstLookRow(ctx, { look: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  }
  requireApprovedRegisteredRow(registeredLookA, "第一组观察方向");
  await resumeStageIfRepairing(ctx, "direction_generating", 74, "第一组观察方向已通过门禁，正在生成第二组方向");
  // Persist row 9 as an exact 8x1 atlas strip, but present those same approved
  // cells to GPT edits in the supported 4x2 board geometry. This is a pure
  // rearrangement with no resampling and avoids an unnecessarily extreme
  // 1536x208 reference aspect ratio.
  let registeredLookAReference = await composeLookSourceBoardReference(registeredLookA.frames, ctx.identity.chromaKey);
  let lookBScreenLeftTrajectoryReference = await composeLookBScreenLeftTrajectoryReference(
    registeredLookA.frames,
    cardinals.frames,
    ctx.identity.chromaKey,
  );
  await emit(ctx, "stage.completed", "direction_generating", 74, "第一组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 9,
    registeredRowArtifactId: registeredLookA.registeredRowArtifact.id,
    registrationManifestArtifactId: registeredLookA.manifestArtifact.id,
    neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
    continuityWarnings: firstLookGate.continuity.warnings.map((warning) => warning.message),
  }, lookA.job.key);
  let lookB = await runBoardJob(ctx, {
    key: "look-b",
    kind: "look_row",
    dependencies: ["look-a-registration"],
    inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, registeredLookA.registeredRowArtifact.id, registeredLookA.manifestArtifact.id, standard.contactArtifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics),
    references: lookRowReferences({
      row: "look-b",
      anchorStoryboard: lookBAnchorStoryboard,
      directionArcGuide: lookBScreenLeftTrajectoryReference,
      canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
      cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
      registeredLookA: registeredLookAReference,
      standardContact: standard.contact,
      layout: lookLayout,
    }),
    columns: 4,
    rows: 2,
    frameCount: 8,
    frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    progress: 76,
    qaKind: "directions",
    qaContext: "方向 180 到 337.5 连续顺时针观察动作，并与 157.5/000 边界连续",
    animationDurations: petRowSpec("look-b").durations,
  });
  let registeredLookB = await registerDirectionRow(ctx, {
    row: "look-b",
    source: lookB,
    neutral: neutralDirectionFrame,
    lockedRow9: registeredLookA,
    progress: 77,
  });
  let secondLookGate = await reviewSecondLookRow(ctx, { look: registeredLookB, previousLook: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  const secondLookRepairRequirements: string[] = [];
  while (!secondLookGate.pass) {
    if (lookB.job.attempt >= lookB.job.maxAttempts) {
      const message = `方向 180 到 337.5 未通过 row-10 前置门禁：${secondLookGate.failures.join("；") || "方向语义或连续性失败"}`;
      if (ctx.perImageBilling || ctx.env.CODEX_PET_IMAGE_APPROVAL_GATE !== "0") {
        throw new CodexPetImageApprovalRequiredError("look-b", `${message}，需要确认后才能重新生成`);
      }
      throw new Error(message);
    }
    await emit(ctx, "run.repairing", "repairing", 78, "正在修复第二组观察方向，最终组装尚未启动", {
      attempt: lookB.job.attempt,
      retryKind: "visual",
      failures: secondLookGate.failures,
    }, lookB.job.key);
    const diagnosticBoard = lookB.board;
    const cumulativeRepairHint = appendCumulativeRepairRequirement(
      secondLookRepairRequirements,
      secondLookGate.repairPrompt || secondLookGate.failures.join("；") || "Keep the complete 180 through 337.5 row on one monotonic clockwise screen-left arc.",
    );
    lookB = await runBoardJob(ctx, {
      key: "look-b", kind: "look_row", dependencies: ["look-a-registration"], inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, registeredLookA.registeredRowArtifact.id, registeredLookA.manifestArtifact.id, standard.contactArtifact.id],
      prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics),
      references: lookRowReferences({
        row: "look-b",
        anchorStoryboard: lookBAnchorStoryboard,
        directionArcGuide: lookBScreenLeftTrajectoryReference,
        canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
        cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
        registeredLookA: registeredLookAReference,
        standardContact: standard.contact,
        layout: lookLayout,
        diagnosticBoard,
      }),
      columns: 4, rows: 2, frameCount: 8, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT, progress: 78, qaKind: "directions", qaContext: "修复方向 180 到 337.5 的完整连续动作组", animationDurations: petRowSpec("look-b").durations, force: true, repairHint: cumulativeRepairHint,
    });
    registeredLookB = await registerDirectionRow(ctx, {
      row: "look-b",
      source: lookB,
      neutral: neutralDirectionFrame,
      lockedRow9: registeredLookA,
      progress: 78,
    });
    secondLookGate = await reviewSecondLookRow(ctx, { look: registeredLookB, previousLook: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  }
  requireApprovedRegisteredRow(registeredLookB, "第二组观察方向");
  await resumeStageIfRepairing(ctx, "direction_generating", 79, "第二组观察方向已通过门禁，正在组装 16 方向");
  await emit(ctx, "stage.completed", "direction_generating", 79, "第二组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 10,
    registeredRowArtifactId: registeredLookB.registeredRowArtifact.id,
    registrationManifestArtifactId: registeredLookB.manifestArtifact.id,
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
    readonly diagnosticsByBoard: readonly (readonly DirectionRegistrationCellDiagnostics[])[];
    readonly schemaVersion: string;
    readonly neutralFrameArtifactId: string;
    readonly target: NeutralDirectionRegistrationManifest["transform"]["target"];
    readonly registeredRowArtifactIds: readonly string[];
    readonly manifestArtifactId: string;
    readonly row9ImmutableDuringRow10Registration: true;
    readonly neutralValidationByBoard: readonly NeutralDirectionGeometryValidation[];
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  } | null = null;
  let finalQa: PetVisualQaVerdict | null = null;
  const finalRepairHistory: Array<{ attempt: number; rows: readonly string[]; failures: readonly string[] }> = [];

  // Rebuild both direction rows as complete groups whenever a direction gate
  // or final visual QA requests repair.  Re-running both rows keeps the seam
  // and the 000/360 wrap coherent; no individual direction frame is patched.
  const regenerateDirectionRows = async (repairHint: string): Promise<void> => {
    const lookARequirements: string[] = [];
    let lookADiagnosticBoard = lookA.board;
    let lookAHint = appendCumulativeRepairRequirement(
      lookARequirements,
      repairHint || "Rebuild both coherent look rows while preserving the approved cardinal semantics and both row boundaries.",
    );
    for (;;) {
      lookA = await runBoardJob(ctx, {
        key: "look-a", kind: "look_row", dependencies: ["look-cardinals"], inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, standard.contactArtifact.id],
        prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics), references: lookRowReferences({
          row: "look-a",
          anchorStoryboard: lookAAnchorStoryboard,
          canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
          cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
          standardContact: standard.contact,
          layout: lookLayout,
          diagnosticBoard: lookADiagnosticBoard,
        }),
        columns: 4, rows: 2, frameCount: 8, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT, progress: 84, qaKind: "directions", qaContext: "修复方向 000 到 157.5 的完整连续动作组", workflowStage: "validating", animationDurations: petRowSpec("look-a").durations, force: true, repairHint: lookAHint,
      });
      registeredLookA = await registerDirectionRow(ctx, {
        row: "look-a",
        source: lookA,
        neutral: neutralDirectionFrame,
        progress: 84,
      });
      firstLookGate = await reviewFirstLookRow(ctx, { look: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
      if (firstLookGate.pass) break;
      if (lookA.job.attempt >= lookA.job.maxAttempts) throw new Error(`修复后的第一组观察方向未通过前置门禁：${firstLookGate.failures.join("；") || "方向语义或连续性失败"}`);
      lookADiagnosticBoard = lookA.board;
      lookAHint = appendCumulativeRepairRequirement(
        lookARequirements,
        firstLookGate.repairPrompt || firstLookGate.failures.join("；") || "Keep row A monotonic across the top-to-bottom row boundary between chronological cells 4 and 5.",
      );
    }
    requireApprovedRegisteredRow(registeredLookA, "修复后的第一组观察方向");
    registeredLookAReference = await composeLookSourceBoardReference(registeredLookA.frames, ctx.identity.chromaKey);
    lookBScreenLeftTrajectoryReference = await composeLookBScreenLeftTrajectoryReference(
      registeredLookA.frames,
      cardinals.frames,
      ctx.identity.chromaKey,
    );
    const lookBRequirements: string[] = [];
    let lookBDiagnosticBoard = lookB.board;
    let lookBHint = appendCumulativeRepairRequirement(
      lookBRequirements,
      repairHint || "Rebuild both coherent look rows while preserving the approved cardinal semantics and both row boundaries.",
    );
    for (;;) {
      lookB = await runBoardJob(ctx, {
        key: "look-b", kind: "look_row", dependencies: ["look-a-registration"], inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, registeredLookA.registeredRowArtifact.id, registeredLookA.manifestArtifact.id, standard.contactArtifact.id],
        prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics), references: lookRowReferences({
          row: "look-b",
          anchorStoryboard: lookBAnchorStoryboard,
          directionArcGuide: lookBScreenLeftTrajectoryReference,
          canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
          cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
          registeredLookA: registeredLookAReference,
          standardContact: standard.contact,
          layout: lookLayout,
          diagnosticBoard: lookBDiagnosticBoard,
        }),
        columns: 4, rows: 2, frameCount: 8, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT, progress: 84, qaKind: "directions", qaContext: "修复方向 180 到 337.5 的完整连续动作组", workflowStage: "validating", animationDurations: petRowSpec("look-b").durations, force: true, repairHint: lookBHint,
      });
      registeredLookB = await registerDirectionRow(ctx, {
        row: "look-b",
        source: lookB,
        neutral: neutralDirectionFrame,
        lockedRow9: registeredLookA,
        progress: 84,
      });
      secondLookGate = await reviewSecondLookRow(ctx, { look: registeredLookB, previousLook: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
      if (secondLookGate.pass) break;
      if (lookB.job.attempt >= lookB.job.maxAttempts) throw new Error(`修复后的第二组观察方向未通过前置门禁：${secondLookGate.failures.join("；") || "方向语义或连续性失败"}`);
      lookBDiagnosticBoard = lookB.board;
      lookBHint = appendCumulativeRepairRequirement(
        lookBRequirements,
        secondLookGate.repairPrompt || secondLookGate.failures.join("；") || "Keep row B monotonic across the top-to-bottom row boundary between chronological cells 4 and 5 and both row seams.",
      );
    }
    requireApprovedRegisteredRow(registeredLookB, "修复后的第二组观察方向");
    await resumeStageIfRepairing(ctx, "validating", 84, "方向修复已通过，正在继续最终质量检查");
  };

  /**
   * Regenerate the complete action groups a verdict implicates, then rebuild
   * every downstream artifact that depends on them.
   *
   * Deterministic structural gates and the independent visual reviewer both
   * produce row-scoped evidence, so both must reach the same bounded repair
   * path. Throwing on a structural rejection instead would end the run holding
   * fully paid, fully approved action groups — the `老鼠猫` failure mode.
   */
  const repairScopedRows = async (input: {
    readonly rows: readonly FinalRepairRow[];
    readonly repairHint: string;
    readonly progress: number;
    readonly message: string;
    readonly failures: readonly string[];
  }): Promise<void> => {
    await emit(ctx, "run.repairing", "repairing", input.progress, input.message, { retryKind: "visual", rows: [...input.rows], failures: [...input.failures] });
    const standardRows = codexPetCoupledStandardRepairRows(
      input.rows.filter((row): row is StandardRepairRow => row !== "look-a" && row !== "look-b"),
    );
    if (standardRows.length > 0) {
      const progressByState: Record<string, number> = { idle: 20, "running-right": 25, "running-left": 30, waving: 35, jumping: 40, failed: 45, waiting: 50, running: 55, review: 60 };
      if (standardRows[0] === "idle") {
        idle = await runStandardRow(
          ctx,
          "idle",
          selected,
          progressByState.idle!,
          true,
          input.repairHint,
          "validating",
        );
        frames.idle = idle.frames;
        jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
        neutralDirectionFrame = { artifact: idle.frameArtifacts[0]!, buffer: idle.frames[0]! };
      }
      const parallelRows = standardRows.filter((state) => state !== "idle");
      const repaired = await mapWithConcurrency(parallelRows, visualConcurrency, (state, _index, signal) => (
        runStandardRow(
          { ...ctx, signal },
          state,
          selected,
          progressByState[state] ?? 64,
          true,
          input.repairHint,
          "validating",
          state === "jumping" ? jumpingTargetHeight : undefined,
        )
      ), ctx.signal);
      repaired.forEach((result, index) => {
        const state = parallelRows[index]!;
        if (state === "running-right") runningRight = result;
        else runningLeft = state === "running-left" ? result : runningLeft;
        if (state !== "running-right" && state !== "running-left") remaining.set(state, result);
        frames[state] = result.frames;
      });
      standard = await storeStandardAtlas(ctx, frames, true);

      // Direction references include the approved standard contact; refresh
      // the cardinal anchors as well whenever standard action art changes.
      cardinals = await runBoardJob(ctx, {
        key: "look-cardinals", kind: "look_cardinals", dependencies: ["look-mechanics", "standard-atlas"], inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
        prompt: buildCardinalPrompt(ctx.identity, mechanics), references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
        columns: 2, rows: 2, frameCount: 4, progress: 83, qaKind: "cardinals", qaContext: "修复后四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左", qaRepetitions: 3, workflowStage: "validating", force: true, repairHint: input.repairHint,
      });
      cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals, true);
      lookAAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-a", ctx.identity.chromaKey);
      lookBAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-b", ctx.identity.chromaKey);
    }
    await regenerateDirectionRows(input.repairHint);
  };

  const directionMaxAttempts = 3;
  for (let directionAttempt = 1; directionAttempt <= directionMaxAttempts; directionAttempt += 1) {
    requireApprovedRegisteredRow(registeredLookA, "最终组装第一组观察方向");
    requireApprovedRegisteredRow(registeredLookB, "最终组装第二组观察方向");
    const registrationErrors = [
      ...registeredLookA.errors,
      ...registeredLookB.errors,
      ...(registeredLookA.manifest.transform.scale === registeredLookB.manifest.transform.scale ? [] : ["row-10-registration-scale-changed"]),
      ...(registeredLookA.manifestArtifact.id === registeredLookB.manifestArtifact.id ? [] : ["row-10-registration-manifest-changed"]),
    ];
    directionRegistration = {
      ok: registrationErrors.length === 0 && registeredLookA.validation.ok && registeredLookB.validation.ok,
      sharedScale: registeredLookA.manifest.transform.scale,
      sourceBoardSizes: [registeredLookA.sourceBoardSize, registeredLookB.sourceBoardSize],
      diagnosticsByBoard: [registeredLookA.diagnostics, registeredLookB.diagnostics],
      schemaVersion: registeredLookA.manifest.schemaVersion,
      neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
      target: registeredLookA.manifest.transform.target,
      registeredRowArtifactIds: [registeredLookA.registeredRowArtifact.id, registeredLookB.registeredRowArtifact.id],
      manifestArtifactId: registeredLookA.manifestArtifact.id,
      row9ImmutableDuringRow10Registration: true,
      neutralValidationByBoard: [registeredLookA.validation, registeredLookB.validation],
      errors: registrationErrors,
      warnings: [...registeredLookA.warnings, ...registeredLookB.warnings],
    };
    await putJsonArtifact(ctx, {
      jobId: registeredLookB.registrationJob.id,
      kind: "qa_report",
      name: `16 方向中立帧锁定缩放与基线注册 · 第 ${directionAttempt} 次`,
      value: directionRegistration,
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    if (!directionRegistration.ok) {
      if (directionAttempt >= directionMaxAttempts) {
        throw new CodexPetGateFailureError(
          `16 个观察方向中立帧锁定注册经 ${directionMaxAttempts} 次尝试后仍未通过：${directionRegistration.errors.join("；")}`,
          "direction-registration",
          ["look-a", "look-b"],
          directionRegistration.errors,
        );
      }
      const repairHint = directionRegistration.errors.join("; ") || "keep all 16 direction poses at the approved neutral body scale, lower-body anchor and baseline";
      await emit(ctx, "run.repairing", "repairing", 82, `方向中立帧锁定注册自动修复 ${directionAttempt}/${directionMaxAttempts - 1}`, { retryKind: "visual", failures: directionRegistration.errors });
      await regenerateDirectionRows(repairHint);
      continue;
    }
    // These are loaded from the persisted registered row artifacts. Final
    // assembly never revisits either raw 4x2 board and therefore cannot let a
    // wide row-10 pose recalculate or shrink the approved row 9.
    frames["look-a"] = registeredLookA.frames;
    frames["look-b"] = registeredLookB.frames;
    const assembled = await assemblePetAtlas(frames, "png");
    const cleaned = await despillChromaEdges(assembled, ctx.identity.chromaKey);
    finalAtlas = cleaned.image;
    despill = cleaned.report;
    validation = await validatePetAtlas(finalAtlas, ctx.identity.chromaKey, {
      allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
    });
    continuity = await measureDirectionContinuity(finalAtlas);
    if (!validation.ok || !continuity.ok) {
      // Both reports name the offending cells, so a structural rejection is a
      // repair scope rather than a wall. Only unattributable atlas-wide defects
      // (dimensions, missing alpha, residue outside the cell grid) remain fatal,
      // because no action group could be regenerated to fix them.
      const structuralFailures = [...validation.errors, ...continuity.errors];
      const unscopedErrors = atlasValidationErrorsWithoutCellScope(validation);
      const structuralRows = [...new Set([
        ...repairRowsFromAtlasValidation(validation),
        ...repairRowsFromDirectionContinuity(continuity),
      ])];
      if (unscopedErrors.length > 0 || structuralRows.length === 0 || directionAttempt >= directionMaxAttempts) {
        const message = `最终图集结构检查失败：${structuralFailures.join("；")}`;
        // An unattributable defect has no row scope to hand a continuation; a
        // scoped one does, even after the in-process attempts are spent.
        throw unscopedErrors.length > 0 || structuralRows.length === 0
          ? new Error(message)
          : new CodexPetGateFailureError(message, "final-atlas-structure", structuralRows, structuralFailures);
      }
      finalRepairHistory.push({ attempt: directionAttempt, rows: structuralRows, failures: structuralFailures });
      await repairScopedRows({
        rows: structuralRows,
        repairHint: `修复以下动作组的结构缺陷（单元格空白、越界、残留色键或方向缺失）：${structuralFailures.slice(0, 20).join("；")}`,
        progress: 86,
        message: `最终图集结构缺陷动作组修复 ${directionAttempt}/${directionMaxAttempts - 1}`,
        failures: structuralFailures,
      });
      continue;
    }
    // Despill residue inside the cell grid is already attributed per row above;
    // anything left here is a defect of the despill pass itself.
    if (!despill.ok) throw new Error(`最终图集残留色键像素 ${despill.remainingOpaqueKeyPixels}`);
    contactSheet = await createAtlasContactSheet(finalAtlas);
    directionSheet = await createDirectionQaSheet(finalAtlas);
    const blind = await createDirectionBlindQaSheet(finalAtlas);
    blindSheet = blind.image;
    if (!ctx.qualityInspectionEnabled) {
      blindValidation = { ok: true, reviewers: [], consensus: [], failures: [], warnings: [] };
      semantics = [];
      finalQa = {
        pass: true,
        score: 100,
        mirrorSafe: false,
        identity: true,
        structure: true,
        semantics: true,
        continuity: true,
        warnings: [],
        failures: [],
        repairPrompt: "",
      };
      break;
    }
    [blindValidation, semantics] = await Promise.all([
      ctx.blindQa({ sheet: blind.image, answerKey: blind.answerKey, identityGuide: ctx.identity.canonicalGuide, env: ctx.env, signal: ctx.signal }),
      ctx.directionSemantics({ sheet: directionSheet, expectedDirections: LOOK_DIRECTIONS, identityGuide: ctx.identity.canonicalGuide, env: ctx.env, signal: ctx.signal }),
    ]);
    assertCodexPetVisualQaProvenance(blindValidation.modelProvenance, ctx.visualQaModel, "blind-direction-qa");
    semantics.forEach((item) => {
      assertCodexPetVisualQaProvenance(item.modelProvenance, ctx.visualQaModel, `direction-${item.direction}`);
    });
    const semanticFailures = semantics.filter((item) => item.verdict === "fail");
    if (!(blindValidation.ok && semanticFailures.length === 0)) {
      const directionFailures = [...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}:${item.reason}`)];
      if (directionAttempt >= directionMaxAttempts) {
        // Blind QA and semantics both speak in direction labels; map them back to
        // the two direction rows so a continuation redoes only those boards.
        const directionRows = [...new Set([
          ...repairRowsFromDirectionContinuity({ errors: directionFailures }),
          ...(blindValidation.failures.length > 0 ? ["look-a", "look-b"] as const : []),
        ])];
        throw new CodexPetGateFailureError(
          `方向质检经 ${directionMaxAttempts} 次尝试后仍未通过：${directionFailures.join("；")}`,
          "direction-qa",
          directionRows,
          directionFailures,
        );
      }
      const repairHint = [...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}: ${item.reason}`)].join("; ");
      await emit(ctx, "run.repairing", "repairing", 84, `方向动作自动修复 ${directionAttempt}/${directionMaxAttempts - 1}`, { retryKind: "visual", failures: repairHint });
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
        ctx.identity.canonicalGuide,
        standardActionSpecificationSummary(ctx.identity.actionPrompts),
      ),
      env: ctx.env,
      signal: ctx.signal,
    });
    assertCodexPetVisualQaProvenance(finalQa.modelProvenance, ctx.visualQaModel, "final-visual-qa");
    if (codexPetVisualQaVerdictPasses(finalQa)) break;
    if (directionAttempt >= directionMaxAttempts) {
      throw new CodexPetGateFailureError(
        `最终独立视觉质检经 ${directionMaxAttempts} 次尝试后仍未通过：${finalQa.failures.join("；") || "角色一致性或动作连续性失败"}`,
        "final-visual-qa",
        repairRowsFromFinalQa(finalQa),
        finalQa.failures,
      );
    }
    const repairRows = repairRowsFromFinalQa(finalQa);
    finalRepairHistory.push({ attempt: directionAttempt, rows: repairRows, failures: finalQa.failures });
    await repairScopedRows({
      rows: repairRows,
      repairHint: finalQa.repairPrompt || finalQa.failures.join("；") || "修复指定动作组的身份、动作语义、节奏与连续性",
      progress: 88,
      message: `最终视觉质检动作组修复 ${directionAttempt}/${directionMaxAttempts - 1}`,
      failures: finalQa.failures,
    });
  }
  if (!validation || !despill || !blindValidation || !continuity || !directionRegistration?.ok || !finalQa || (ctx.qualityInspectionEnabled && !codexPetVisualQaVerdictPasses(finalQa))) {
    throw new Error("最终验证没有生成完整报告");
  }
  await resumeStageIfRepairing(ctx, "validating", 94, "最终结构、方向盲测与视觉质检已通过");
  const continuityWarnings = continuity.warnings.map((item) => item.message);
  await emit(ctx, "stage.completed", "validating", 94, "最终结构、方向盲测与视觉质检已通过", { warnings: [...validation.warnings, ...continuityWarnings, ...blindValidation.warnings, ...semantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`)] });

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
  const packagedValidation = await validatePetAtlas(packaged.spritesheet, ctx.identity.chromaKey, {
    allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
  });
  if (!packagedValidation.ok) {
    throw new Error(`Codex v2 WebP 图集验证失败：${packagedValidation.errors.join("；")}`);
  }
  let visualQaActualModels: string[] = [];
  let visualQaRoutes: string[] = [];
  if (ctx.qualityInspectionEnabled) {
    if (!firstLookGate.visual) throw new Error("row9 前置门禁缺少所选视觉模型证明");
    const requiredJobProvenance = await summarizeRequiredVisualJobProvenance(ctx);
    const row9GateProvenance = assertCodexPetVisualQaProvenance(firstLookGate.visual.modelProvenance, ctx.visualQaModel, "row9-pre-generation-gate");
    const row10GateProvenance = assertCodexPetVisualQaProvenance(secondLookGate.visual?.modelProvenance, ctx.visualQaModel, "row10-pre-generation-gate");
    const finalQaProvenance = assertCodexPetVisualQaProvenance(finalQa.modelProvenance, ctx.visualQaModel, "final-visual-qa");
    const blindQaProvenance = assertCodexPetVisualQaProvenance(blindValidation.modelProvenance, ctx.visualQaModel, "blind-direction-qa");
    const semanticProvenance = semantics.map((item) => (
      assertCodexPetVisualQaProvenance(item.modelProvenance, ctx.visualQaModel, `direction-${item.direction}`)
    ));
    visualQaActualModels = [...new Set([
      ...requiredJobProvenance.actualModels,
      ...row9GateProvenance.actualModels,
      ...row10GateProvenance.actualModels,
      ...finalQaProvenance.actualModels,
      ...blindQaProvenance.actualModels,
      ...semanticProvenance.flatMap((item) => item.actualModels),
    ])];
    if (visualQaActualModels.length === 0
      || visualQaActualModels.some((model) => !isAllowedCodexPetVisualModel(model))) {
      throw new Error(`最终视觉质检模型不符合 ${ctx.visualQaModel} 合同`);
    }
    visualQaRoutes = [...new Set([
      ...requiredJobProvenance.routes,
      ...row9GateProvenance.routes,
      ...row10GateProvenance.routes,
      ...finalQaProvenance.routes,
      ...blindQaProvenance.routes,
      ...semanticProvenance.flatMap((item) => item.routes),
    ])];
  }
  const provider = await summarizeProviderUsage(ctx);
  const imageModelMatches = (model: string) => model === ctx.imageModel
    || (ctx.imageModel === GPT_IMAGE_MODEL && model === "gpt-image-2-codex");
  if (provider.actualModels.length === 0
    || provider.actualModels.some((model) => !isAllowedCodexPetImageProvenance(model) || !imageModelMatches(model))) {
    throw new Error(`最终生图模型不符合 ${ctx.imageModel} 合同`);
  }
  const report = {
    ok: true,
    spriteVersionNumber: 2,
    modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
    requestedModel: ctx.imageModel,
    modelProvenance: {
      imageGeneration: {
        requestedModel: ctx.imageModel,
        actualModels: provider.actualModels,
      },
      visualQa: {
        enabled: ctx.qualityInspectionEnabled,
        requestedModel: ctx.qualityInspectionEnabled ? ctx.visualQaModel : null,
        actualModels: visualQaActualModels,
        routes: visualQaRoutes,
      },
    },
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
      neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
      registeredRowArtifactId: registeredLookA.registeredRowArtifact.id,
      registrationManifestArtifactId: registeredLookA.manifestArtifact.id,
      neutralGeometryValidation: registeredLookA.validation,
      deterministicContinuity: firstLookGate.continuity,
    },
    row10PreGenerationGate: {
      passed: secondLookGate.pass,
      registeredRowArtifactId: registeredLookB.registeredRowArtifact.id,
      reusedRegistrationManifestArtifactId: registeredLookB.manifestArtifact.id,
      neutralGeometryValidation: registeredLookB.validation,
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
  const durablePackage = await persistOrResumeCodexPetFinalPackage({
    prisma: ctx.prisma,
    artifacts: ctx.artifacts,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    displayName: ctx.identity.name,
    description: ctx.identity.description,
    chromaKey: ctx.identity.chromaKey,
    provider,
    seed: {
      petId: packaged.petId,
      finalAtlas,
      spritesheet: packaged.spritesheet,
      zip: packaged.zip,
      contactSheet,
      directionSheet,
      blindSheet,
      report,
      inputArtifactIds: [
        standard.atlasArtifact.id,
        registeredLookA.registeredRowArtifact.id,
        registeredLookB.registeredRowArtifact.id,
      ],
    },
  });
  if (!durablePackage) throw new Error("最终打包任务未能建立持久化 checkpoint");
  return continueAfterDurablePackaging(ctx, durablePackage);
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
  if (initialRun.status === "ready" || initialRun.status === "failed" || initialRun.status === "cancelled" || initialRun.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || initialRun.status === "awaiting_direction_review" || initialRun.status === "awaiting_regeneration_approval") {
    return { status: initialRun.status, runId: initialRun.id };
  }
  const initialSnapshot = asRecord(initialRun.inputSnapshot);
  const initialQualityInspectionEnabled = typeof initialSnapshot.qualityInspectionEnabled === "boolean"
    ? initialSnapshot.qualityInspectionEnabled
    : typeof initialRun.qualityInspectionEnabled === "boolean"
      ? initialRun.qualityInspectionEnabled
      : initialRun.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE ? false : true;
  const zeroChargeRecovery = ["packaging", "archiving"].includes(initialRun.status)
    && isCodexPetRecoverySnapshot(initialRun.inputSnapshot)
    && initialRun.billingChargeStatus === "not_required"
    && initialRun.billingPoints === 0;
  const initialVisualQaModel = typeof initialSnapshot.visualQaModel === "string"
    ? initialSnapshot.visualQaModel.trim()
    : "";
  const initialModelContractValid = initialSnapshot.modelContractVersion === CODEX_PET_MODEL_CONTRACT_VERSION
    && typeof initialSnapshot.requestedModel === "string"
    && isAllowedCodexPetImageModel(initialSnapshot.requestedModel)
    && initialRun.requestedModel === initialSnapshot.requestedModel
    && (!initialQualityInspectionEnabled || initialVisualQaModel === resolveCodexPetVisualQaModel(env, initialVisualQaModel));
  // Waiting for an explicit user choice is a durable pause, not runnable
  // work. A duplicate Bull delivery (for example an old retained/stalled job)
  // must not claim the run and replay base generation while the workbench is
  // showing candidates. Auto-selection and explicit selection routes first
  // move the row back to a runnable stage, so they are unaffected.
  if (initialRun.status === "awaiting_base_review"
    && !initialRun.selectedBaseArtifactId
    && !initialRun.autoContinue
    && initialModelContractValid
    && !initialRun.cancelRequested) {
    return { status: "awaiting_base_review", runId: initialRun.id };
  }
  // Queue delivery must never start visual work before the external package
  // charge is durably confirmed and the activation transaction has committed.
  const initialBillingActivated = initialRun.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE
    ? initialRun.billingSettlementStatus === "reserved"
    : initialRun.billingChargeStatus === "charged" && Boolean(initialRun.billingActivatedAt);
  if (!zeroChargeRecovery && !initialBillingActivated) {
    throw new Error("Codex pet run billing is not activated");
  }
  // A caller that does not supply a worker identity is generally a direct
  // invocation (tests, maintenance, or a one-off repair). Give each such
  // invocation a unique lease token so two concurrent calls in one process
  // still obey the same CAS rule. Queue workers supply their own unique token
  // and use it for the heartbeat below.
  const workerId = deps.workerId ?? `${WORKER_ID}:${randomUUID().slice(0, 12)}`;
  const claimed = await claimRunLease(
    deps.prisma,
    input.runId,
    workerId,
    env,
    initialRun.projectId,
    initialRun.userId,
    zeroChargeRecovery,
  );
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
  const snapshottedModelContractVersion = typeof snapshot.modelContractVersion === "string" ? snapshot.modelContractVersion.trim() : "";
  const snapshottedImageModel = typeof snapshot.requestedModel === "string" ? snapshot.requestedModel.trim() : "";
  const snapshottedVisualQaModel = typeof snapshot.visualQaModel === "string" ? snapshot.visualQaModel.trim() : "";
  const qualityInspectionEnabled = typeof snapshot.qualityInspectionEnabled === "boolean"
    ? snapshot.qualityInspectionEnabled
    : typeof run.qualityInspectionEnabled === "boolean"
      ? run.qualityInspectionEnabled
      : run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE ? false : true;
  const visualQaModel = qualityInspectionEnabled
    ? resolveCodexPetVisualQaModel(env, snapshottedVisualQaModel || run.visualQaModel || undefined)
    : "";
  const imageModel = snapshottedImageModel || run.requestedModel;
  const failedContinuation = asRecord(snapshot.failedContinuation);
  const snapshottedMaxBoardAttempts = failedContinuation.maxBoardAttemptsPerJob;
  const perImageBilling = run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE;
  const perImageCallPoints = perImageBilling ? frozenPerImageCallPoints(snapshot, run) : 0;
  const maxBoardAttempts = perImageBilling ? 1 : codexPetMaxBoardAttempts(env, snapshottedMaxBoardAttempts);
  // All visual calls in this run use the snapshotted project choice. Keeping
  // it in the context environment lets the existing visual helpers and their
  // injected test clients share one durable route without consulting the
  // mutable process default.
  const visualEnv = qualityInspectionEnabled ? { ...env, PET_VISUAL_QA_MODEL: visualQaModel } : env;
  // Recovery packaging is bound to already-approved bytes and never needs to
  // reload user references. Avoid making a zero-charge recovery depend on
  // reference-object availability after the original run has finished.
  const referenceAssetIds = zeroChargeRecovery ? [] : Array.isArray(snapshot.referenceAssetIds)
    ? snapshot.referenceAssetIds.filter((value): value is string => typeof value === "string")
    : [...run.project.referenceAssetIds];
  const snapshotString = (key: string, fallback: string) => typeof snapshot[key] === "string" ? snapshot[key] as string : fallback;
  const identity = {
    name: snapshotString("name", run.project.name),
    description: snapshotString("description", run.project.description),
    prompt: snapshotString("prompt", run.project.prompt),
    actionPrompts: normalizeCodexPetActionPrompts(snapshot.actionPrompts ?? run.project.actionPrompts),
    stylePreset: snapshotString("stylePreset", run.project.stylePreset),
    styleNotes: snapshotString("styleNotes", run.project.styleNotes),
  };
  let loadedReferences: Array<{ buffer: Buffer; mime: string; filename: string }> = [];
  let chromaKey = run.colorKey || "#ff00ff";
  try {
    if (snapshottedModelContractVersion !== CODEX_PET_MODEL_CONTRACT_VERSION) {
      throw new Error(`Codex pet run is missing the required ${CODEX_PET_MODEL_CONTRACT_VERSION} model contract`);
    }
    if (!isAllowedCodexPetImageModel(imageModel) || run.requestedModel !== imageModel) {
      throw new Error(`Codex pet image model contract is invalid: ${imageModel || "missing"}`);
    }
    if (qualityInspectionEnabled && snapshottedVisualQaModel !== visualQaModel) {
      throw new Error(`Codex pet visual model contract changed after start: ${snapshottedVisualQaModel} -> ${visualQaModel}`);
    }
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
        else if (!(CODEX_PET_ACTIVE_STATUSES as readonly string[]).includes(fresh.status) || fresh.workerId !== workerId) controller.abort(new CodexPetLeaseLostError());
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
        ...(zeroChargeRecovery
          ? { billingChargeStatus: "not_required", billingPoints: 0 }
          : perImageBilling
            ? { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" }
            : { billingChargeStatus: "charged", billingActivatedAt: { not: null } }),
      },
      data: { heartbeatAt: new Date() },
    }).then((updated) => {
      if (updated.count !== 1 && !controller.signal.aborted) controller.abort(new CodexPetLeaseLostError());
    }).catch(() => undefined);
  }, leaseHeartbeatMs);
  const ctx: RunnerContext = {
    ...deps,
    env: visualEnv,
    workerId,
    signal: controller.signal,
    project: run.project,
    runId: run.id,
    imageModel,
    visualQaModel,
    qualityInspectionEnabled,
    perImageBilling,
    perImageCallPoints,
    maxBoardAttempts,
    referenceAssetIds,
    identity: {
      ...identity,
      chromaKey,
    },
    userReferences: loadedReferences.map((loaded) => imageInput(loaded.buffer, loaded.mime, loaded.filename)),
    generate: deps.visual?.generate ?? ((input) => generateCodexPetVisual({ ...input, model: imageModel })),
    qa: deps.visual?.qa ?? runCodexPetVisualQa,
    qaConsensus: deps.visual?.qaConsensus ?? runCodexPetVisualQaConsensus,
    blindQa: deps.visual?.blindQa ?? runBlindDirectionQa,
    directionSemantics: deps.visual?.directionSemantics ?? runLabeledDirectionSemantics,
    lookMechanics: deps.visual?.lookMechanics ?? generateCodexPetLookMechanics,
    identityGuide: deps.visual?.identityGuide ?? generateCodexPetIdentityGuide,
  };
  try {
    return await executeRun(ctx);
  } catch (error) {
    if (error instanceof CodexPetImageApprovalRequiredError) {
      await pauseForImageApproval(ctx, error);
      return { status: ctx.perImageBilling ? "awaiting_regeneration_approval" : "awaiting_direction_review", runId: run.id };
    }
    if (error instanceof CodexPetImageCallLimitError || error instanceof CodexPetImageCallApprovalRequiredError || error instanceof CodexPetImageCallAlreadySentError) {
      await pauseForImageApproval(ctx, new CodexPetImageApprovalRequiredError(error.jobKey, error.message));
      return { status: "awaiting_regeneration_approval", runId: run.id };
    }
    if (error instanceof CodexPetPackagingDeferredError) {
      if (await releaseDeferredPackagingLease(ctx, error)) {
        return { status: "packaging", runId: run.id };
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
      if (latest?.status === "archiving") return { status: "archiving", runId: run.id };
      return { status: "busy", runId: run.id };
    }
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
