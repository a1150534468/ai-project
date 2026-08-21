// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，类型、常量、信号异常）。

import { Buffer } from "node:buffer";
import {
  type DirectionRegistrationCellDiagnostics,
  type NeutralDirectionGeometryValidation,
  type NeutralDirectionRegistrationManifest,
  type PetRowSpec,
  validateStandardPetAtlas,
} from "@ai-assistant/codex-pet-pipeline";
import {
  type CodexPetArtifact,
  type CodexPetJob,
  type CodexPetProject,
  type CodexPetRun,
  type ImageAsset,
  type PrismaClient,
} from "@prisma/client";
import { CODEX_PET_BOARD_PROMPT_VERSION } from "../codex-pet-board-version.js";
import { type CodexPetGateRepairRow } from "../codex-pet-gate-failure.js";
import { type CodexPetVisualIdentity } from "../codex-pet-prompts.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "../codex-pet-read-only-archive.js";
import {
  type PetVisualQaConsensus,
  generateCodexPetIdentityGuide,
  generateCodexPetLookMechanics,
  generateCodexPetVisual,
  runBlindDirectionQa,
  runCodexPetVisualQa,
  runCodexPetVisualQaConsensus,
  runLabeledDirectionSemantics,
} from "../codex-pet-visual.js";
import { type ImageBinaryInput } from "../image-service.js";

export const CODEX_PET_ACTIVE_STATUSES = [
  "queued", "base_generating", "awaiting_base_review", "standard_generating", "direction_generating",
  "awaiting_direction_review", "validating", "repairing", "packaging", "archiving",
] as const;

export const CODEX_PET_RESOURCE_KEY = "codex_pet_v2_package";

export const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60_000;

export const DEFAULT_STALE_RUN_MS = 15 * 60_000;

export const IDENTITY_GUIDE_VERSION = 2;

export const BOARD_JOB_INPUT_SCHEMA_VERSION = "codex-pet-board-input-v3";

export const CODEX_PET_IDLE_BOARD_PROMPT_VERSION = "codex-pet-board-prompt-v9";

export const CODEX_PET_RECOVERY_SCHEMA_VERSION = "codex-pet-recovery-v1";

export function codexPetStandardRowPromptVersion(
  state: Exclude<PetRowSpec["state"], "look-a" | "look-b">,
): string {
  return state === "idle" ? CODEX_PET_IDLE_BOARD_PROMPT_VERSION : CODEX_PET_BOARD_PROMPT_VERSION;
}

export type StandardActionState = Exclude<PetRowSpec["state"], "look-a" | "look-b">;

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

export interface RunnerContext extends CodexPetRunnerDeps {
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

export interface BoardJobResult {
  readonly job: CodexPetJob;
  readonly frames: readonly Buffer[];
  readonly frameArtifacts: readonly CodexPetArtifact[];
  readonly board: Buffer;
  readonly boardArtifact: CodexPetArtifact;
  readonly mirrorSafe: boolean;
  readonly qa: PetVisualQaConsensus;
}

export interface RegisteredDirectionRowResult {
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

export class CodexPetCancelledError extends Error {
  constructor() {
    super("用户已取消桌宠制作");
    this.name = "CodexPetCancelledError";
  }
}

export class CodexPetImageApprovalRequiredError extends Error {
  constructor(
    readonly jobKey: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexPetImageApprovalRequiredError";
  }
}

export class CodexPetArchiveDeferredError extends Error {
  constructor(
    message: string,
    readonly attempt: number,
    readonly maxAttempts: number,
  ) {
    super(message);
    this.name = "CodexPetArchiveDeferredError";
  }
}

export type FinalRepairRow = CodexPetGateRepairRow;

export type StandardRepairRow = Exclude<FinalRepairRow, "look-a" | "look-b">;

/**
 * A terminal gate rejection that still knows which action groups it blames.
 *
 * The in-process repair loop is bounded, so exhausting it ends the run. Carrying
 * the row scope out to `finalizeFailure` lets the failure be recorded as
 * continuable work instead of an opaque wall: the user can resume the same paid
 * run and redo exactly those rows.
 */
export class CodexPetGateFailureError extends Error {
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

export type RunnerRunWithProject = CodexPetRun & { project: CodexPetProject };

/**
 * A freshly assembled standard atlas failed its deterministic structure gate.
 *
 * The report travels with the error so the caller can regenerate exactly the
 * implicated action groups. At this point in the run no direction row exists
 * yet, so the repair loop lives at the call site rather than here.
 */
export class CodexPetStandardAtlasStructureError extends Error {
  constructor(readonly validation: Awaited<ReturnType<typeof validateStandardPetAtlas>>) {
    super(`标准 8×9 图集结构检查失败：${validation.errors.join("；")}`);
    this.name = "CodexPetStandardAtlasStructureError";
  }
}
