import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireUser } from "../auth/require-user.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { getObject, loadS3Config, makeS3 } from "../storage/s3.js";
import { enqueueCodexPetRun } from "./codex-pet-queue.js";
import {
  GPT_IMAGE_MODEL,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  isVerifiedWorkflowImageObjectKeyForUser,
} from "./image-service.js";
import { isCodexPetArtifactObjectKey, isCodexPetArtifactObjectKeyFor } from "./codex-pet-storage.js";
import {
  CODEX_PET_ACTION_PROMPT_KEYS,
  CODEX_PET_ACTION_PROMPT_MAX_LENGTH,
  CODEX_PET_ACTION_PROMPTS_MAX_TOTAL_LENGTH,
  CODEX_PET_STYLES,
} from "./codex-pet-prompts.js";
import { sanitizeCodexPetDiagnosticText, sanitizeCodexPetEventPayload } from "./codex-pet-events.js";
import {
  assertCodexPetImageRoute,
  CODEX_PET_BAILIAN_VISUAL_QA_MODEL,
  CODEX_PET_IMAGE_MODELS,
  CODEX_PET_MODEL_CONTRACT_VERSION,
  CODEX_PET_VISUAL_QA_MODEL,
} from "./codex-pet-model-contract.js";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
  codexPetExtraCallBudget,
  codexPetExtraCallBudgetFromCalls,
  prepareCodexPetExtraImageCall,
  refundCodexPetUndispatchedExtraCalls,
} from "./codex-pet-call-ledger.js";
import { initializeCodexPetFailedContinuation } from "./codex-pet-failed-continuation.js";
import { readCodexPetGateFailureSnapshot } from "./codex-pet-gate-failure.js";
import { CODEX_PET_GPT_FAILED_CONTINUATION_SCHEMA_VERSION } from "./codex-pet-gpt-continuation.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import {
  assertCodexPetVisualQaRoute,
} from "./codex-pet-visual.js";
import { loadSharp } from "../runtime/resource-limits.js";

export { codexPetValidationPassed } from "./codex-pet-delivery-validation.js";

export const CODEX_PET_RESOURCE_KEY = "codex_pet_v2_package";
export const CODEX_PET_PUBLIC_ARTIFACT_PURPOSE = "codex-pet-install";
export const CODEX_PET_PREVIEW_ARTIFACT_PURPOSE = "codex-pet-preview";
export const CODEX_PET_INSTALL_URL_TTL_SECONDS = 30 * 60;
export const CODEX_PET_PREVIEW_URL_TTL_SECONDS = 15 * 60;
export const CODEX_PET_EVENT_CHANNEL_PREFIX = "codex-pet:run:";

// Signed preview URLs are intentionally unauthenticated for a short period,
// so never serve an active document format such as SVG inline. Codex-pet
// artifacts are raster outputs; this response-boundary allowlist protects
// against malformed/legacy rows or provider content-type spoofing turning the
// API origin into an XSS host.
const SAFE_RASTER_IMAGE_MIMES = new Set([
  "image/png",
  "image/webp",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/avif",
]);

const DEFAULT_PRICE = {
  resourceKey: CODEX_PET_RESOURCE_KEY,
  displayName: "Codex v2 桌宠生图调用",
  pricingType: "PER_UNIT" as const,
  rate: 200,
  perUnits: 1,
  enabled: true,
};

const ACTIVE_RUN_STATUSES = [
  "queued",
  "base_generating",
  "awaiting_base_review",
  "awaiting_direction_review",
  "standard_generating",
  "direction_generating",
  "validating",
  "repairing",
  "packaging",
  "archiving",
] as const;

// A run parked on `awaiting_regeneration_approval` is not *running*, but it is
// still wake-able: approving it dispatches paid image calls immediately. Any
// check that asks "does this account already have a run that could hit the
// relay?" must therefore include it. Leaving it out of the new-run block let a
// user start a second run and then approve the parked one, putting two runs on
// the same upstream quota at once — the 429 shape that killed an earlier run.
const BLOCKING_RUN_STATUSES = [...ACTIVE_RUN_STATUSES, "awaiting_regeneration_approval"] as const;

const TERMINAL_RUN_STATUSES = ["ready", "failed", "cancelled", CODEX_PET_LEGACY_READ_ONLY_STATUS] as const;
// Final artifacts are independently verified when the package job commits.
// Knowledge archival is useful discovery metadata, not a prerequisite for a
// user to receive an already valid pet.
const DELIVERABLE_RUN_STATUSES = ["archiving", "ready", "failed"] as const;
const EDITABLE_PROJECT_STATUSES = ["draft", "awaiting_base_review"] as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const idSchema = z.string().trim().min(1).max(128).regex(ID_PATTERN);
const idempotencyKeySchema = z.string().trim().min(8).max(128).regex(ID_PATTERN);
const projectParamsSchema = z.object({ projectId: idSchema });
const runParamsSchema = z.object({ projectId: idSchema, runId: idSchema });
const publicArtifactParamsSchema = z.object({ artifactId: idSchema });
const publicArtifactQuerySchema = z.object({
  exp: z.coerce.number().int().positive(),
  sig: z.string().trim().min(32).max(128),
  purpose: z.enum(["install", "preview"]).default("install"),
});
const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
});
const deliveryRunQuerySchema = z.object({
  runId: idSchema.optional(),
});

const actionPromptsSchema = z.object(Object.fromEntries(
  CODEX_PET_ACTION_PROMPT_KEYS.map((key) => [key, z.string().trim().max(CODEX_PET_ACTION_PROMPT_MAX_LENGTH).optional()]),
) as Record<(typeof CODEX_PET_ACTION_PROMPT_KEYS)[number], z.ZodOptional<z.ZodString>>).strict().transform((value) => Object.fromEntries(
  Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
)).refine(
  (value) => Object.values(value).reduce((total, prompt) => total + prompt.length, 0) <= CODEX_PET_ACTION_PROMPTS_MAX_TOTAL_LENGTH,
  { message: `动作提示词总长度不能超过 ${CODEX_PET_ACTION_PROMPTS_MAX_TOTAL_LENGTH} 个字符` },
);

const projectFieldsSchema = z.object({
  name: z.string().trim().min(1).max(30),
  description: z.string().trim().max(500).default(""),
  prompt: z.string().trim().max(4_000).default(""),
  actionPrompts: actionPromptsSchema.default({}),
  stylePreset: z.enum(CODEX_PET_STYLES).default("auto"),
  styleNotes: z.string().trim().max(1_000).default(""),
  referenceAssetIds: z.array(idSchema).max(3).default([]),
  autoContinue: z.boolean().default(false),
  imageModel: z.literal(GPT_IMAGE_MODEL).default(GPT_IMAGE_MODEL),
  qualityInspectionEnabled: z.boolean().default(false),
  visualQaModel: z.string().trim().min(1).max(128).default(CODEX_PET_VISUAL_QA_MODEL),
});

const createProjectSchema = projectFieldsSchema.extend({
  idempotencyKey: idempotencyKeySchema.optional(),
}).superRefine((value, context) => {
  if (new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["referenceAssetIds"], message: "参考图不能重复" });
  }
});

const updateProjectSchema = projectFieldsSchema.partial().superRefine((value, context) => {
  if (value.referenceAssetIds && new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["referenceAssetIds"], message: "参考图不能重复" });
  }
});

const startRunSchema = z.object({ idempotencyKey: idempotencyKeySchema.optional() }).default({});
const failedContinuationSchema = z.object({ idempotencyKey: idempotencyKeySchema.optional() }).default({});
const gateFailureResumeSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).default({});
const baseSelectionSchema = z.union([
  z.object({ artifactId: idSchema }).strict(),
  z.object({ autoSelect: z.literal(true) }).strict(),
  z.object({ regenerate: z.literal(true) }).strict(),
]);
const extraImageApprovalSchema = z.object({ idempotencyKey: idempotencyKeySchema.optional() }).default({});

type ResourcePrice = {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly perUnits: number;
  readonly enabled: boolean;
};

export interface CodexPetBilling {
  readonly chargeResource: (args: {
    readonly operationId: string;
    readonly userId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly charged: number }>;
  readonly reserveResource?: (args: {
    readonly operationId: string;
    readonly userId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly reserved: number }>;
  readonly settleResource?: (args: {
    readonly operationId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly settled: number }>;
  readonly refundResource: (operationId: string) => Promise<{ readonly success: boolean }>;
  readonly listResourcePrices?: () => Promise<{ readonly data: readonly ResourcePrice[] }>;
  readonly listEnabledModels?: () => Promise<{
    readonly data: readonly {
      readonly model: string;
      readonly displayName: string;
      readonly maxOutputTokens?: number;
      readonly tags?: string;
    }[];
  }>;
}

export interface CodexPetArtifactShape {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly userId: string;
  readonly jobId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly status: string;
  readonly objectKey: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly metadata: unknown;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface CodexPetRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: CodexPetBilling;
  /** Must enqueue BullMQ with jobId=runId. */
  readonly enqueueRun?: (runId: string) => Promise<void>;
  /** Wakes a local/remote worker so AbortSignal and the persisted flag both take effect. */
  readonly requestCancellation?: (runId: string) => Promise<void> | void;
  /** Optional Redis notifier; database persistence remains authoritative. */
  readonly notifyRunEvent?: (runId: string) => Promise<void> | void;
  /** Optional Redis subscriber. SSE always retains database polling as a fallback. */
  readonly subscribeRunEvents?: (
    runId: string,
    onMessage: () => void,
  ) => Promise<(() => Promise<void> | void) | void>;
  readonly loadArtifact?: (objectKey: string) => Promise<Buffer>;
  /** Revalidates persisted reference bytes before a project can use them. */
  readonly validateReferenceAsset?: (asset: {
    readonly id: string;
    readonly userId: string;
    readonly objectKey: string;
    readonly mime: string;
  }) => Promise<boolean>;
  /** Legacy hard-cleanup hook for pre-soft-delete tombstones. */
  readonly enqueueProjectCleanup?: (input: { readonly userId: string; readonly projectId: string }) => Promise<void>;
  readonly artifactPreviewUrl?: (
    artifact: CodexPetArtifactShape,
    context: { readonly userId: string; readonly projectId: string },
  ) => Promise<string | null> | string | null;
  readonly signingSecret?: string;
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
  readonly ssePollIntervalMs?: number;
  readonly sseHeartbeatIntervalMs?: number;
  /** Testable connection lifetime; production waits for the raw response to close. */
  readonly waitForSseDisconnect?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Startup/start-run GPT route preflight; injectable only for isolated route tests. */
  readonly assertVisualQaReady?: () => void;
  /** Start-run GPT Image generations/edits preflight. */
  readonly assertImageReady?: () => void;
}

type ProjectShape = {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly actionPrompts: unknown;
  readonly stylePreset: string;
  readonly styleNotes: string;
  readonly referenceAssetIds: readonly string[];
  readonly autoContinue: boolean;
  readonly imageModel: string;
  readonly visualQaModel: string;
  readonly qualityInspectionEnabled: boolean;
  readonly status: string;
  readonly latestRunId: string | null;
  readonly createIdempotencyKey: string | null;
  readonly deletedAt?: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type RunShape = {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly idempotencyKey: string | null;
  readonly inputSnapshot: unknown;
  readonly status: string;
  readonly progressStage: string;
  readonly progressPercent: number;
  readonly progressMessage: string | null;
  readonly autoContinue: boolean;
  readonly colorKey: string | null;
  readonly billingOperationId: string | null;
  readonly billingMode: string;
  readonly billingResourceKey: string | null;
  readonly billingReservedUnits: number;
  readonly billingSettledUnits: number;
  readonly billingReservedPoints: number;
  readonly billingSettledPoints: number;
  readonly billingSettlementStatus: string;
  readonly billingPoints: number;
  readonly billingChargeStatus: string;
  readonly billingChargeAttemptCount: number;
  readonly billingChargeError: string | null;
  readonly billingChargeNextRetryAt: Date | null;
  readonly billingChargedAt: Date | null;
  readonly billingActivatedAt: Date | null;
  readonly billingRefundedAt: Date | null;
  readonly billingRefundStatus: string;
  readonly cancelRequested: boolean;
  readonly hasSuccessfulImage: boolean;
  readonly selectedBaseArtifactId: string | null;
  readonly spritesheetArtifactId: string | null;
  readonly packageArtifactId: string | null;
  readonly previewArtifactId: string | null;
  readonly validationReport: unknown;
  readonly requestedModel: string;
  readonly visualQaModel: string;
  readonly qualityInspectionEnabled: boolean;
  readonly imageGenerationCallCount: number;
  readonly plannedImageCallLimit: number;
  readonly imageGenerationApprovalBudget: number;
  readonly pendingImageJobKey: string | null;
  readonly actualModels: readonly string[];
  readonly usage: unknown;
  readonly knowledgeDocumentId: string | null;
  readonly lastEventSequence: number;
  readonly workerId?: string | null;
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type EventShape = {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly stage: string;
  readonly jobKey: string | null;
  readonly message: string | null;
  readonly progress: number;
  readonly payload: unknown;
  readonly createdAt: Date;
};

class ActiveCodexPetRunError extends Error {
  readonly runId: string;

  // A parked run reads as "nothing is happening" from the user's side, so the
  // generic message leaves them with no idea what to do. Name the exit.
  constructor(runId: string, status?: string) {
    super(status === "awaiting_regeneration_approval"
      ? "当前账号有一个停摆的桌宠运行正在等待重出图授权，请先授权继续或取消它，再开始新的制作"
      : "当前账号已有正在制作的桌宠");
    this.name = "ActiveCodexPetRunError";
    this.runId = runId;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeDiagnostic(error: unknown): string {
  return sanitizeCodexPetDiagnosticText(
    error instanceof Error ? error.message : String(error),
    1_000,
  );
}

function safeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function serializeProject(project: ProjectShape) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    prompt: project.prompt,
    actionPrompts: recordOf(project.actionPrompts),
    stylePreset: project.stylePreset,
    styleNotes: project.styleNotes,
    referenceAssetIds: [...project.referenceAssetIds],
    autoContinue: project.autoContinue,
    imageModel: project.imageModel || GPT_IMAGE_MODEL,
    visualQaModel: project.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
    qualityInspectionEnabled: project.qualityInspectionEnabled === true,
    status: project.status,
    latestRunId: project.latestRunId,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function serializeProjectSummary(project: ProjectShape) {
  const serialized = serializeProject(project);
  return {
    id: serialized.id,
    name: serialized.name,
    description: serialized.description,
    stylePreset: serialized.stylePreset,
    status: serialized.status,
    latestRunId: serialized.latestRunId,
    createdAt: serialized.createdAt,
    updatedAt: serialized.updatedAt,
  };
}

function recoverySourceRunId(
  inputSnapshot: unknown,
  ownedRunIds: ReadonlySet<string> | null,
): string | null {
  if (!ownedRunIds) return null;
  const recovery = recordOf(recordOf(inputSnapshot).recovery);
  const sourceRunId = recovery.sourceRunId;
  return typeof sourceRunId === "string" && ownedRunIds.has(sourceRunId)
    ? sourceRunId
    : null;
}

function serializeRun(run: RunShape, ownedRunIds: ReadonlySet<string> | null = null) {
  const inputSnapshot = recordOf(run.inputSnapshot);
  const validationReport = recordOf(run.validationReport);
  const validationProvenance = recordOf(validationReport.modelProvenance);
  const visualQaProvenance = recordOf(validationProvenance.visualQa);
  const visualQaActualModels = Array.isArray(visualQaProvenance.actualModels)
    ? visualQaProvenance.actualModels.filter((model): model is string => typeof model === "string")
    : [];
  const visualQaRoutes = Array.isArray(visualQaProvenance.routes)
    ? visualQaProvenance.routes.filter((route): route is string => typeof route === "string")
    : [];
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    progressStage: run.progressStage,
    progressPercent: run.progressPercent,
    progressMessage: run.progressMessage,
    autoContinue: run.autoContinue,
    colorKey: run.colorKey,
    billingPoints: run.billingPoints,
    billingMode: run.billingMode,
    billingResourceKey: run.billingResourceKey,
    billingReservedUnits: run.billingReservedUnits,
    billingSettledUnits: run.billingSettledUnits,
    billingReservedPoints: run.billingReservedPoints,
    billingSettledPoints: run.billingSettledPoints,
    billingSettlementStatus: run.billingSettlementStatus,
    billingChargeStatus: run.billingChargeStatus,
    billingChargeAttemptCount: run.billingChargeAttemptCount,
    billingChargeError: run.billingChargeError,
    billingChargeNextRetryAt: safeDate(run.billingChargeNextRetryAt),
    billingChargedAt: safeDate(run.billingChargedAt),
    billingActivatedAt: safeDate(run.billingActivatedAt),
    billingRefundedAt: safeDate(run.billingRefundedAt),
    billingRefundStatus: run.billingRefundStatus,
    cancelRequested: run.cancelRequested,
    hasSuccessfulImage: run.hasSuccessfulImage,
    selectedBaseArtifactId: run.selectedBaseArtifactId,
    spritesheetArtifactId: run.spritesheetArtifactId,
    packageArtifactId: run.packageArtifactId,
    previewArtifactId: run.previewArtifactId,
    // Recovery runs own the final delivery artifacts, while their standard
    // animation previews remain on the failed source run. Only publish the
    // lineage when that source is another run returned for this owned project.
    recoverySourceRunId: recoverySourceRunId(run.inputSnapshot, ownedRunIds),
    validationReport: run.validationReport,
    requestedModel: run.requestedModel,
    qualityInspectionEnabled: typeof inputSnapshot.qualityInspectionEnabled === "boolean"
      ? inputSnapshot.qualityInspectionEnabled
      : run.qualityInspectionEnabled,
    imageGenerationCallCount: run.imageGenerationCallCount,
    plannedImageCallLimit: run.plannedImageCallLimit,
    imageGenerationApprovalBudget: run.imageGenerationApprovalBudget,
    pendingImageJobKey: run.pendingImageJobKey,
    visualQaModel: typeof inputSnapshot.visualQaModel === "string"
      ? inputSnapshot.visualQaModel
      : run.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
    modelContractVersion: typeof inputSnapshot.modelContractVersion === "string"
      ? inputSnapshot.modelContractVersion
      : "",
    visualQaActualModels,
    visualQaRoutes,
    actualModels: [...run.actualModels],
    usage: run.usage,
    knowledgeDocumentId: run.knowledgeDocumentId,
    lastEventSequence: run.lastEventSequence,
    // A gate that named its action groups leaves the failure resumable inside the
    // same paid run. Publishing the scope is what lets the panel offer that resume
    // instead of only "copy to a new project and pay for everything again".
    resumableGateRows: [...(readCodexPetGateFailureSnapshot(run.inputSnapshot)?.rows ?? [])],
    error: run.error,
    startedAt: safeDate(run.startedAt),
    completedAt: safeDate(run.completedAt),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function serializeJob(job: {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    id: job.id,
    key: job.key,
    kind: job.kind,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function serializeEvent(event: EventShape) {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    stage: event.stage,
    jobKey: event.jobKey,
    message: event.message ? sanitizeCodexPetDiagnosticText(event.message, 1_000) : null,
    progress: event.progress,
    // Events are normally sanitized on write; sanitize again at the read
    // boundary so a legacy/corrupt row cannot expose keys, signed URLs, or
    // embedded image data through SSE or the replay endpoint.
    payload: sanitizeCodexPetEventPayload(recordOf(event.payload)),
    createdAt: event.createdAt.toISOString(),
  };
}

function safeSseEventName(value: string): string {
  return /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : "message";
}

async function serializeArtifact(
  artifact: CodexPetArtifactShape,
  deps: CodexPetRouteDeps,
  context: { readonly userId: string; readonly projectId: string },
) {
  const configuredPreviewUrl = isSafeRasterImageMime(artifact.mime)
    ? await deps.artifactPreviewUrl?.(artifact, context)
    : null;
  const previewUrl = configuredPreviewUrl === undefined
    ? defaultArtifactPreviewUrl(artifact, deps)
    : configuredPreviewUrl;
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    runId: artifact.runId,
    jobId: artifact.jobId,
    kind: artifact.kind,
    name: artifact.name,
    status: artifact.status,
    mime: artifact.mime,
    sizeBytes: artifact.sizeBytes,
    width: artifact.width,
    height: artifact.height,
    metadata: recordOf(artifact.metadata),
    expiresAt: safeDate(artifact.expiresAt),
    createdAt: artifact.createdAt.toISOString(),
    url: previewUrl,
    previewUrl,
    thumbnailUrl: previewUrl,
  };
}

function isSafeRasterImageMime(mime: string): boolean {
  return SAFE_RASTER_IMAGE_MIMES.has(mime.split(";", 1)[0]!.trim().toLowerCase());
}

function defaultArtifactPreviewUrl(artifact: CodexPetArtifactShape, deps: CodexPetRouteDeps): string | null {
  if (artifact.status !== "ready" || !isSafeRasterImageMime(artifact.mime) || !hasOwnedArtifactObjectKey(artifact)) return null;
  const currentTime = deps.now?.() ?? new Date();
  if (artifact.expiresAt && artifact.expiresAt.getTime() <= currentTime.getTime()) return null;
  let secret: string;
  try {
    secret = signingSecret(deps);
  } catch {
    return null;
  }
  const expiresAtSeconds = Math.floor(currentTime.getTime() / 1_000) + CODEX_PET_PREVIEW_URL_TTL_SECONDS;
  const signature = signCodexPetArtifact(
    artifact.id,
    expiresAtSeconds,
    secret,
    CODEX_PET_PREVIEW_ARTIFACT_PURPOSE,
  );
  // Previewing a private artifact is a browser-only, same-origin operation.
  // Do not couple it to CODEX_PET_PUBLIC_BASE_URL: that setting is for the
  // external Codex install deep link and can point at a rotated tunnel/CDN.
  // A stale public origin would otherwise leave every workspace image pending
  // even though the local API can serve the signed artifact immediately.
  return `/api/public/codex-pets/artifacts/${encodeURIComponent(artifact.id)}?exp=${expiresAtSeconds}&sig=${encodeURIComponent(signature)}&purpose=preview`;
}

export function codexPetRunEventChannel(runId: string): string {
  return `${CODEX_PET_EVENT_CHANNEL_PREFIX}${runId}`;
}

export function deriveCodexPetRunId(userId: string, projectId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update("codex-pet-run\0")
    .update(userId)
    .update("\0")
    .update(projectId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 32);
  return `cpr_${digest}`;
}

export function signCodexPetArtifact(
  artifactId: string,
  expiresAtSeconds: number,
  secret: string,
  purpose = CODEX_PET_PUBLIC_ARTIFACT_PURPOSE,
): string {
  return createHmac("sha256", secret)
    .update(`v1:${purpose}:${artifactId}:${expiresAtSeconds}`)
    .digest("base64url");
}

export function verifyCodexPetArtifactSignature(args: {
  readonly artifactId: string;
  readonly expiresAtSeconds: number;
  readonly signature: string;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly purpose?: string;
}): boolean {
  if (args.expiresAtSeconds <= args.nowSeconds) return false;
  const expected = signCodexPetArtifact(
    args.artifactId,
    args.expiresAtSeconds,
    args.secret,
    args.purpose ?? CODEX_PET_PUBLIC_ARTIFACT_PURPOSE,
  );
  const actualBuffer = Buffer.from(args.signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isActiveRunStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function isUniqueConstraintError(error: unknown): boolean {
  return recordOf(error).code === "P2002";
}

function resolveIdempotencyKey(
  header: string | string[] | undefined,
  body: string | undefined,
): { readonly success: true; readonly value: string } | { readonly success: false } {
  const headerValue = Array.isArray(header) ? header[0] : header;
  const normalizedHeader = headerValue?.trim() || undefined;
  if (normalizedHeader && body && normalizedHeader !== body) return { success: false };
  const parsed = idempotencyKeySchema.safeParse(body ?? normalizedHeader);
  return parsed.success ? { success: true, value: parsed.data } : { success: false };
}

function resolvePricing(rows: readonly ResourcePrice[]): ResourcePrice {
  const configured = rows.find((row) => row.resourceKey === CODEX_PET_RESOURCE_KEY);
  return configured
    ? { ...DEFAULT_PRICE, ...configured, resourceKey: CODEX_PET_RESOURCE_KEY }
    : DEFAULT_PRICE;
}

function isCodexPetPerImagePrice(pricing: ResourcePrice): boolean {
  return pricing.pricingType === "PER_UNIT"
    && pricing.perUnits === 1
    && Number.isFinite(pricing.rate)
    && pricing.rate > 0;
}

function signingSecret(deps: CodexPetRouteDeps): string {
  const value = deps.signingSecret
    ?? process.env.CODEX_PET_ARTIFACT_SIGNING_SECRET
    ?? process.env.SESSION_SECRET;
  if (!value || Buffer.byteLength(value) < 32) {
    throw new Error("CODEX_PET_ARTIFACT_SIGNING_SECRET or SESSION_SECRET must be at least 32 bytes");
  }
  return value;
}

function publicBaseUrl(deps: CodexPetRouteDeps): string {
  const value = deps.publicBaseUrl
    ?? process.env.CODEX_PET_PUBLIC_BASE_URL
    ?? process.env.API_PUBLIC_BASE_URL;
  if (!value) throw new Error("CODEX_PET_PUBLIC_BASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new Error("CODEX_PET_PUBLIC_BASE_URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function packageFilename(project: ProjectShape, artifact: CodexPetArtifactShape): string {
  const metadata = recordOf(artifact.metadata);
  const source = typeof metadata.petId === "string" ? metadata.petId : project.name;
  const safe = source.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return `${safe || "codex-pet"}.zip`;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function validateCodexPetReferenceAsset(
  asset: { readonly id: string; readonly userId: string; readonly objectKey: string; readonly mime: string },
  load: (objectKey: string) => Promise<Buffer>,
): Promise<boolean> {
  if (!IMAGE_REFERENCE_MIME_TYPES.has(asset.mime.toLowerCase().split(";", 1)[0]!)
    || !isVerifiedWorkflowImageObjectKeyForUser(asset.objectKey, asset.userId)) return false;
  const bytes = await load(asset.objectKey);
  if (bytes.byteLength < 1 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) return false;
  try {
    const sharp = await loadSharp();
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).metadata();
    return Boolean(metadata.width && metadata.height);
  } catch {
    return false;
  }
}

function eventCursor(request: FastifyRequest, after: number): number {
  const raw = request.headers["last-event-id"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(header ?? 0);
  return Math.max(after, Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0);
}

export function formatCodexPetSseEvent(event: EventShape): string {
  return `id: ${event.sequence}\nevent: ${safeSseEventName(event.type)}\ndata: ${JSON.stringify(serializeEvent(event))}\n\n`;
}

async function defaultWaitForSseDisconnect(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  await new Promise<void>((resolve) => {
    const onClose = () => resolve();
    reply.raw.once("close", onClose);
    reply.raw.once("error", onClose);
  });
}

function assertFinalSpritesheet(artifact: CodexPetArtifactShape): boolean {
  return artifact.status === "ready"
    && artifact.kind === "spritesheet"
    && artifact.sizeBytes > 0
    && artifact.width === 1_536
    && artifact.height === 2_288
    && (artifact.mime === "image/webp" || artifact.mime === "image/png")
    && hasOwnedArtifactObjectKey(artifact)
    && artifact.expiresAt === null;
}

function assertPackageArtifact(artifact: CodexPetArtifactShape): boolean {
  return artifact.status === "ready"
    && artifact.kind === "package"
    && artifact.sizeBytes > 0
    && (artifact.mime === "application/zip" || artifact.mime === "application/x-zip-compressed")
    && hasOwnedArtifactObjectKey(artifact)
    && artifact.expiresAt === null;
}

function hasOwnedArtifactObjectKey(artifact: CodexPetArtifactShape): boolean {
  return isCodexPetArtifactObjectKeyFor({
    objectKey: artifact.objectKey,
    userId: artifact.userId,
    projectId: artifact.projectId,
    runId: artifact.runId,
  });
}

async function notifyEvent(app: FastifyInstance, deps: CodexPetRouteDeps, runId: string): Promise<void> {
  try {
    if (deps.notifyRunEvent) await deps.notifyRunEvent(runId);
    else await getRedis().publish(codexPetRunEventChannel(runId), "route-event");
  } catch (error) {
    app.log.warn({ error: safeDiagnostic(error), runId }, "Codex pet Redis event notification failed; SSE database polling will recover");
  }
}

async function defaultSubscribeRunEvents(runId: string, onMessage: () => void): Promise<() => Promise<void>> {
  const subscriber = getRedis().duplicate();
  const channel = codexPetRunEventChannel(runId);
  const handleMessage = (receivedChannel: string) => {
    if (receivedChannel === channel) onMessage();
  };
  // ioredis otherwise reports an unhandled error event when Redis is down;
  // the failed subscribe is still surfaced and the caller falls back to DB.
  const handleError = () => undefined;
  subscriber.on("message", handleMessage);
  subscriber.on("error", handleError);
  try {
    await subscriber.subscribe(channel);
  } catch (error) {
    subscriber.off("message", handleMessage);
    subscriber.off("error", handleError);
    subscriber.disconnect();
    throw error;
  }
  return async () => {
    subscriber.off("message", handleMessage);
    subscriber.off("error", handleError);
    await subscriber.unsubscribe(channel).catch(() => undefined);
    subscriber.disconnect();
  };
}

export async function codexPetRoutes(app: FastifyInstance, deps: CodexPetRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const enqueueRun = deps.enqueueRun ?? ((runId: string) => enqueueCodexPetRun({ runId }));
  const now = deps.now ?? (() => new Date());
  const loadArtifact = deps.loadArtifact ?? ((objectKey: string) => {
    // The production loader is the last boundary before S3. Embedded tests
    // may provide an in-memory loader with synthetic keys, but the real route
    // must never follow a database row outside our private prefix.
    // The caller performs the row-level ownership check before invoking this
    // loader. Keep the generic namespace guard here as defense in depth.
    if (!isCodexPetArtifactObjectKey(objectKey)) throw new Error("invalid Codex pet artifact object key");
    return getObject(makeS3(loadS3Config()), objectKey);
  });
  const validateReferenceAsset = deps.validateReferenceAsset ?? ((asset: {
    readonly id: string;
    readonly userId: string;
    readonly objectKey: string;
    readonly mime: string;
  }) => validateCodexPetReferenceAsset(
    asset,
    (objectKey) => getObject(makeS3(loadS3Config()), objectKey),
  ));

  async function ownedProject(userId: string, projectId: string) {
    return prisma.codexPetProject.findFirst({ where: { id: projectId, userId, deletedAt: null } });
  }

  async function ownedRun(userId: string, projectId: string, runId: string) {
    return prisma.codexPetRun.findFirst({ where: { id: runId, projectId, userId } });
  }

  async function validateReferenceAssets(userId: string, assetIds: readonly string[]): Promise<boolean> {
    if (assetIds.length === 0) return true;
    const assets = await prisma.imageAsset.findMany({
      where: { userId, id: { in: [...assetIds] } },
      select: { id: true, objectKey: true, mime: true },
    });
    if (assets.length !== assetIds.length) return false;
    if (!assets.every((asset) => Boolean(asset.objectKey)
      && IMAGE_REFERENCE_MIME_TYPES.has(asset.mime.toLowerCase().split(";", 1)[0]!))) return false;
    const checks = await Promise.all(assets.map((asset) => validateReferenceAsset({
      id: asset.id,
      userId,
      objectKey: asset.objectKey!,
      mime: asset.mime,
    }).catch(() => false)));
    return checks.every(Boolean);
  }

  async function codexPetModelOptions() {
    const configured = await billing.listEnabledModels?.();
    const visualModels = (configured?.data ?? [])
      .filter((model) => {
        const normalized = model.model.trim().toLowerCase();
        const tags = new Set((model.tags ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean));
        const verifiedWithoutCatalogTag = normalized === CODEX_PET_VISUAL_QA_MODEL
          || normalized === CODEX_PET_BAILIAN_VISUAL_QA_MODEL;
        return normalized.length > 0
          && !normalized.includes("embedding")
          && !normalized.startsWith("qwen3.7")
          && !normalized.includes("image")
          && !normalized.includes("ocr")
          && !tags.has("image-gen")
          && !tags.has("ocr")
          && (verifiedWithoutCatalogTag || tags.has("vision"));
      })
      .map((model) => ({ model: model.model, displayName: model.displayName || model.model }));
    const fallbackVisual = [{ model: CODEX_PET_VISUAL_QA_MODEL, displayName: "GPT-5.6 Sol" }];
    return {
      visualModels: visualModels.length > 0 ? visualModels : fallbackVisual,
      imageModels: CODEX_PET_IMAGE_MODELS.map((model) => ({ model, displayName: "GPT Image 2" })),
    } as const;
  }

  async function selectedVisualModelIsAvailable(model: string): Promise<boolean> {
    const options = await codexPetModelOptions();
    return options.visualModels.some((candidate) => candidate.model === model);
  }

  async function price(): Promise<ResourcePrice> {
    const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
    return resolvePricing(rows);
  }

  async function createCancellation(
    userId: string,
    projectId: string,
    runId: string,
  ): Promise<{ readonly run: RunShape; readonly eventSequences: readonly number[]; readonly refundPending: boolean }> {
    return prisma.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns PostgreSQL `void`. Prisma attempts to
      // deserialize SELECT rows issued through $queryRawUnsafe and raises
      // P2010 for that type, so execute the statement without decoding rows.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-cancel:${runId}`);
      await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', runId);
      const current = await tx.codexPetRun.findFirst({ where: { id: runId, projectId, userId } });
      if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
      if (current.status === "ready" || current.status === "failed" || current.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
        throw new Error("CODEX_PET_RUN_TERMINAL");
      }
      const definitelyUncharged = current.billingActivatedAt === null
        && (current.billingChargeStatus === "pending" || current.billingChargeStatus === "insufficient" || current.billingChargeStatus === "cancelled");
      const chargeConfirmed = current.billingChargeStatus === "charged";
      if (current.status === "cancelled") {
        const attemptedAt = now();
        if (definitelyUncharged && current.billingChargeStatus !== "cancelled") {
          const released = await tx.codexPetRun.update({
            where: { id: current.id },
            data: {
              billingChargeStatus: "cancelled",
              billingChargeError: null,
              billingChargeLeaseUntil: null,
              billingChargeNextRetryAt: null,
            },
          });
          return { run: released as RunShape, eventSequences: [], refundPending: false };
        }
        const refundEligible = chargeConfirmed
          && !current.hasSuccessfulImage
          // A legacy run may have reached base review before the
          // hasSuccessfulImage marker was introduced. Its first cancellation
          // intentionally leaves billingRefundStatus=none; require a durable
          // refund intent here so a duplicate cancellation cannot infer a
          // refund from the now-generic `cancelled` status and charge history.
          && (current.billingRefundStatus === "pending" || current.billingRefundStatus === "failed")
          && Boolean(current.billingOperationId)
          && !current.billingRefundedAt;
        const retryDue = !current.billingRefundNextRetryAt || current.billingRefundNextRetryAt <= attemptedAt;
        if (!refundEligible || !retryDue) return { run: current as RunShape, eventSequences: [], refundPending: false };
        const claimed = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            billingRefundStatus: "pending",
            billingRefundError: null,
            // This is a short durable lease. If the API process dies after
            // commit, maintenance retries the idempotent billing operation.
            billingRefundNextRetryAt: new Date(attemptedAt.getTime() + 60_000),
          },
        });
        return { run: claimed as RunShape, eventSequences: [], refundPending: true };
      }
      if (current.workerId && current.cancelRequested) {
        return { run: current as RunShape, eventSequences: [], refundPending: false };
      }

      // A live worker may still finish an image-generation request after this
      // transaction begins. Persist the flag and let that worker decide the
      // refund only after it has stopped, so the first-successful-image policy
      // cannot race with a refund here.
      if (current.workerId) {
        const requested = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            cancelRequested: true,
            progressMessage: "正在取消桌宠制作",
            lastEventSequence: { increment: 1 },
          },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId,
            runId,
            userId,
            sequence: requested.lastEventSequence,
            type: "run.cancellation_requested",
            stage: requested.progressStage,
            message: "已请求取消桌宠制作，正在等待当前子任务停止",
            progress: requested.progressPercent,
            payload: {},
          },
        });
        return { run: requested as RunShape, eventSequences: [requested.lastEventSequence], refundPending: false };
      }

      const cancelledAt = now();
      // Never refund a merely pending/charging/uncertain operation. An
      // idempotent charge may still settle later; the billing reconciler then
      // records the confirmed charge and creates a fresh durable refund intent.
      const refundPending = chargeConfirmed
        && !current.hasSuccessfulImage
        && current.status !== "awaiting_base_review"
        && Boolean(current.billingOperationId)
        && !current.billingRefundedAt;
      const updated = await tx.codexPetRun.update({
        where: { id: current.id },
        data: {
          cancelRequested: true,
          status: "cancelled",
          progressStage: "cancelled",
          progressMessage: "用户已取消",
          completedAt: cancelledAt,
          lastEventSequence: { increment: 1 },
          ...(definitelyUncharged ? {
            billingChargeStatus: "cancelled",
            billingChargeError: null,
            billingChargeLeaseUntil: null,
            billingChargeNextRetryAt: null,
          } : {}),
          ...(refundPending ? {
            billingRefundStatus: "pending",
            billingRefundError: null,
            billingRefundNextRetryAt: new Date(cancelledAt.getTime() + 60_000),
          } : {}),
        },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId,
          runId,
          userId,
          sequence: updated.lastEventSequence,
          type: "run.cancelled",
          stage: "cancelled",
          message: "用户已取消桌宠制作",
          progress: updated.progressPercent,
          payload: { refundEligible: !updated.hasSuccessfulImage },
        },
      });

      await tx.codexPetProject.updateMany({
        where: { id: projectId, userId, latestRunId: runId, status: { not: "deleting" } },
        data: { status: definitelyUncharged ? "draft" : "cancelled" },
      });
      return { run: updated as RunShape, eventSequences: [updated.lastEventSequence], refundPending };
    });
  }

  async function settleCancellationRefund(
    result: { readonly run: RunShape; readonly eventSequences: readonly number[]; readonly refundPending: boolean },
  ): Promise<{ readonly run: RunShape; readonly eventSequences: readonly number[]; readonly refundPending: boolean }> {
    if (result.run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
      // Extra calls charged at approval but never dispatched are refunded on
      // their own axis: they are not part of the run reservation, so the planned
      // settle below can neither return nor account for them. Runs first so an
      // already-settled reservation does not short-circuit the extras refund.
      let extraRefundSequences = result.eventSequences;
      if (result.run.status === "cancelled" && result.run.workerId === null) {
        const extras = await refundCodexPetUndispatchedExtraCalls({
          prisma,
          billing,
          runId: result.run.id,
          projectId: result.run.projectId,
          userId: result.run.userId,
        }).catch(() => ({ refunded: 0, pending: 0 }));
        if (extras.refunded > 0) {
          const recorded = await prisma.$transaction(async (tx) => {
            const bumped = await tx.codexPetRun.update({
              where: { id: result.run.id },
              data: { lastEventSequence: { increment: 1 } },
              select: { lastEventSequence: true, projectId: true, userId: true, status: true, progressPercent: true },
            });
            await tx.codexPetEvent.create({
              data: {
                projectId: bumped.projectId,
                runId: result.run.id,
                userId: bumped.userId,
                sequence: bumped.lastEventSequence,
                type: "billing.refunded",
                stage: bumped.status,
                message: `已退回 ${extras.refunded} 次已授权但未派发的额外生图积分`,
                progress: bumped.progressPercent,
                payload: { refundedExtraCalls: extras.refunded, pendingExtraRefunds: extras.pending },
              },
            });
            return bumped.lastEventSequence;
          }).catch(() => null);
          if (recorded !== null) extraRefundSequences = [...extraRefundSequences, recorded];
        }
      }
      result = { ...result, eventSequences: extraRefundSequences };
      if (result.run.status !== "cancelled"
        || result.run.workerId !== null
        || result.run.billingSettlementStatus === "settled"
        || (result.run.billingSettlementStatus !== "reserved" && result.run.billingSettlementStatus !== "settle_failed")
        || !result.run.billingOperationId
        || !result.run.billingResourceKey
        || !billing.settleResource) return result;
      try {
        // Must match the runner and the sweeper exactly: a planned call that
        // failed at the provider delivered no image and is not settled.
        const units = await prisma.codexPetImageCall.count({
          where: {
            runId: result.run.id,
            projectId: result.run.projectId,
            userId: result.run.userId,
            callKind: "planned",
            sentAt: { not: null },
            status: { not: "failed" },
          },
        });
        const receipt = await billing.settleResource({
          operationId: result.run.billingOperationId,
          resourceKey: result.run.billingResourceKey,
          units,
        });
        const settled = await prisma.codexPetRun.update({
          where: { id: result.run.id },
          data: {
            billingSettledUnits: units,
            billingSettledPoints: receipt.settled,
            billingPoints: receipt.settled,
            billingSettlementStatus: "settled",
            billingSettledAt: now(),
            billingChargeError: null,
          },
        });
        return { ...result, run: settled as RunShape };
      } catch (error) {
        const deferred = await prisma.codexPetRun.update({
          where: { id: result.run.id },
          data: {
            billingSettlementStatus: "settle_failed",
            billingChargeError: safeDiagnostic(error),
          },
        }).catch(() => null);
        return { ...result, run: (deferred as RunShape | null) ?? result.run };
      }
    }
    const operationId = result.run.billingOperationId;
    if (!result.refundPending
      || result.run.billingChargeStatus !== "charged"
      || !operationId
      || result.run.billingRefundedAt) return result;
    const attemptedAt = now();
    try {
      const refund = await billing.refundResource(operationId);
      if (!refund.success) throw new Error("billing refund was not accepted");
      const settled = await prisma.$transaction(async (tx) => {
        // Billing refunds are idempotent by operationId. This conditional DB
        // transition ensures concurrent API/maintenance attempts create only
        // one persisted billing.refunded event.
        const transition = await tx.codexPetRun.updateMany({
          where: { id: result.run.id, billingRefundedAt: null },
          data: {
            billingRefundedAt: attemptedAt,
            billingRefundStatus: "refunded",
            billingRefundError: null,
            billingRefundLastAttemptAt: attemptedAt,
            billingRefundRetryCount: { increment: 1 },
            billingRefundNextRetryAt: null,
            lastEventSequence: { increment: 1 },
          },
        });
        const run = await tx.codexPetRun.findFirst({ where: { id: result.run.id } });
        if (!run) throw new Error("CODEX_PET_RUN_NOT_FOUND");
        if (transition.count === 0) return { run: run as RunShape, sequence: null as number | null };
        await tx.codexPetEvent.create({
          data: {
            projectId: run.projectId,
            runId: run.id,
            userId: run.userId,
            sequence: run.lastEventSequence,
            type: "billing.refunded",
            stage: run.status,
            message: "套餐积分已全额退回",
            progress: run.progressPercent,
            payload: { operationId },
          },
        });
        return { run: run as RunShape, sequence: run.lastEventSequence as number | null };
      });
      return {
        run: settled.run,
        eventSequences: settled.sequence === null ? result.eventSequences : [...result.eventSequences, settled.sequence],
        refundPending: false,
      };
    } catch (error) {
      // Cancellation was committed before the external call. Keep the durable
      // pending marker even if billing or the success-record transaction
      // fails; maintenance safely retries the same operationId.
      await prisma.codexPetRun.updateMany({
        where: { id: result.run.id, billingRefundedAt: null },
        data: {
          billingRefundStatus: "pending",
          billingRefundError: error instanceof Error ? error.message.slice(0, 500) : "退款失败",
          billingRefundRetryCount: { increment: 1 },
          billingRefundLastAttemptAt: attemptedAt,
          billingRefundNextRetryAt: new Date(attemptedAt.getTime() + 60_000),
        },
      }).catch(() => undefined);
      app.log.warn({ runId: result.run.id }, "Codex pet cancellation refund deferred for retry");
      const current = await prisma.codexPetRun.findFirst({ where: { id: result.run.id } }).catch(() => null);
      return { ...result, run: (current as RunShape | null) ?? result.run, refundPending: true };
    }
  }

  app.get("/api/workflow/codex-pets/pricing", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    try {
      const pricing = await price();
      return {
        success: true,
        data: {
          pricing: {
            ...pricing,
            plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
            includedBaseCandidates: 2,
          },
        },
      };
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error) }, "failed to load Codex pet pricing");
      return reply.code(502).send({ error: "获取桌宠套餐价格失败" });
    }
  });

  app.get("/api/workflow/codex-pets/models", { preHandler: requireUser }, async (request, reply) => {
    try {
      return { success: true, data: await codexPetModelOptions() };
    } catch (error) {
      app.log.warn({ error: safeDiagnostic(error) }, "failed to load Codex pet model catalog");
      return reply.code(503).send({ error: "模型目录暂不可用，请稍后重试" });
    }
  });

  app.get("/api/workflow/codex-pets/projects", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const projects = await prisma.codexPetProject.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return { success: true, data: { projects: projects.map((project) => serializeProjectSummary(project as ProjectShape)) } };
  });

  app.post("/api/workflow/codex-pets/projects", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "桌宠项目参数不合法", issues: parsed.error.flatten() });
    const keyResult = parsed.data.idempotencyKey || request.headers["idempotency-key"]
      ? resolveIdempotencyKey(request.headers["idempotency-key"], parsed.data.idempotencyKey)
      : null;
    if (keyResult && !keyResult.success) return reply.code(400).send({ error: "幂等键不合法或不一致" });
    const idempotencyKey = keyResult?.value ?? null;

    if (idempotencyKey) {
      const existing = await prisma.codexPetProject.findFirst({ where: { userId, createIdempotencyKey: idempotencyKey } });
      if (existing) return { success: true, data: { project: serializeProject(existing as ProjectShape) } };
    }
    if (!await validateReferenceAssets(userId, parsed.data.referenceAssetIds)) {
      return reply.code(400).send({ error: "参考图不存在、无权使用或不是可用的已上传图片" });
    }

    try {
      const project = await prisma.codexPetProject.create({
        data: {
          userId,
          name: parsed.data.name,
          description: parsed.data.description,
          prompt: parsed.data.prompt,
          actionPrompts: parsed.data.actionPrompts,
          stylePreset: parsed.data.stylePreset,
          styleNotes: parsed.data.styleNotes,
          referenceAssetIds: parsed.data.referenceAssetIds,
          autoContinue: parsed.data.autoContinue,
          imageModel: parsed.data.imageModel,
          visualQaModel: parsed.data.visualQaModel,
          qualityInspectionEnabled: parsed.data.qualityInspectionEnabled,
          createIdempotencyKey: idempotencyKey,
          status: "draft",
        },
      });
      return reply.code(201).send({ success: true, data: { project: serializeProject(project as ProjectShape) } });
    } catch (error) {
      if (idempotencyKey && isUniqueConstraintError(error)) {
        const existing = await prisma.codexPetProject.findFirst({ where: { userId, createIdempotencyKey: idempotencyKey } });
        if (existing) return { success: true, data: { project: serializeProject(existing as ProjectShape) } };
      }
      throw error;
    }
  });

  app.get("/api/workflow/codex-pets/projects/:projectId", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });

    const [runs, artifacts, referenceAssets] = await Promise.all([
      prisma.codexPetRun.findMany({
        where: { projectId: project.id, userId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.codexPetArtifact.findMany({
        where: { projectId: project.id, userId },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      project.referenceAssetIds.length
        ? prisma.imageAsset.findMany({
          where: { userId, id: { in: [...project.referenceAssetIds] } },
          select: { id: true, mime: true, originalUrl: true, thumbnailUrl: true, createdAt: true },
        })
        : Promise.resolve([]),
    ]);
    const latestRun = project.latestRunId
      ? runs.find((run) => run.id === project.latestRunId) ?? null
      : runs[0] ?? null;
    const jobs = latestRun
      ? await prisma.codexPetJob.findMany({ where: { runId: latestRun.id, projectId: project.id, userId }, orderBy: { createdAt: "asc" } })
      : [];
    const ledgerDelegate = (prisma as unknown as {
      codexPetImageCall?: {
        findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
      };
    }).codexPetImageCall;
    const imageCalls = latestRun && ledgerDelegate
      ? await ledgerDelegate.findMany({ where: { runId: latestRun.id, projectId: project.id, userId }, orderBy: { createdAt: "asc" } })
      : [];
    const serializedArtifacts = await Promise.all(artifacts
      .filter((artifact) => artifact.status !== "superseded")
      .map((artifact) => serializeArtifact(
        artifact as CodexPetArtifactShape,
        deps,
        { userId, projectId: project.id },
      )));
    const projectData = {
      ...serializeProject(project as ProjectShape),
      referenceAssets: referenceAssets.map((asset) => ({
        id: asset.id,
        mime: asset.mime,
        originalUrl: asset.originalUrl,
        thumbnailUrl: asset.thumbnailUrl,
        createdAt: asset.createdAt.toISOString(),
      })),
    };
    const ownedRunIds = new Set(runs.map((run) => run.id));
    return {
      success: true,
      data: {
        detail: {
          project: projectData,
          latestRun: latestRun ? serializeRun(latestRun as RunShape, ownedRunIds) : null,
          runs: runs.map((run) => serializeRun(run as RunShape, ownedRunIds)),
          artifacts: serializedArtifacts,
          jobs: jobs.map(serializeJob),
          imageCalls: imageCalls.map((call) => ({
            id: String(call.id),
            jobKey: String(call.jobKey),
            logicalAttempt: Number(call.logicalAttempt),
            callKind: String(call.callKind),
            purpose: String(call.purpose),
            requestedModel: String(call.requestedModel),
            actualModel: typeof call.actualModel === "string" ? call.actualModel : null,
            status: String(call.status),
            points: Number(call.points ?? 0),
            sentAt: call.sentAt instanceof Date ? call.sentAt.toISOString() : null,
            completedAt: call.completedAt instanceof Date ? call.completedAt.toISOString() : null,
            error: typeof call.error === "string" ? call.error : null,
          })),
          // Sent with the run so the approval panel can state the remaining paid
          // repair attempts up front, instead of letting the user discover the cap
          // by being refused after a click.
          extraCallBudget: latestRun
            ? codexPetExtraCallBudgetFromCalls(
              imageCalls.map((call) => ({ callKind: String(call.callKind), status: String(call.status), jobKey: String(call.jobKey) })),
              latestRun.pendingImageJobKey ?? null,
            )
            : null,
        },
      },
    };
  });

  app.patch("/api/workflow/codex-pets/projects/:projectId", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    const body = updateProjectSchema.safeParse(request.body);
    if (!params.success || !body.success || Object.keys(body.data).length === 0) {
      return reply.code(400).send({ error: "桌宠项目参数不合法" });
    }
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能修改" });
    const blockingRun = await prisma.codexPetRun.findFirst({
      where: {
        projectId: project.id,
        userId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (project.status === "draft" && blockingRun) {
      return reply.code(409).send({ error: "桌宠制作正在等待扣费或执行，不能修改输入" });
    }
    if (!(EDITABLE_PROJECT_STATUSES as readonly string[]).includes(project.status)) {
      return reply.code(409).send({ error: "只有草稿或等待主形象确认的项目可以修改" });
    }
    if (body.data.referenceAssetIds && !await validateReferenceAssets(userId, body.data.referenceAssetIds)) {
      return reply.code(400).send({ error: "参考图不存在、无权使用或不是可用的已上传图片" });
    }
    if (project.status === "draft") {
      const updated = await prisma.codexPetProject.update({
        where: { id: project.id, userId },
        data: body.data,
      });
      return { success: true, data: { project: serializeProject(updated as ProjectShape) } };
    }

    if (!project.latestRunId) return reply.code(409).send({ error: "等待确认的运行不存在，请刷新后重试" });
    const regenerated = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${project.latestRunId}`);
      const current = await tx.codexPetProject.findFirst({ where: { id: project.id, userId } });
      if (!current || current.status !== "awaiting_base_review" || !current.latestRunId) {
        throw new Error("CODEX_PET_EDIT_STATE_CONFLICT");
      }
      const run = await tx.codexPetRun.findFirst({
        where: { id: current.latestRunId, projectId: current.id, userId, status: "awaiting_base_review" },
      });
      if (!run) throw new Error("CODEX_PET_EDIT_STATE_CONFLICT");
      const updatedProject = await tx.codexPetProject.update({
        where: { id: current.id, userId },
        data: { ...body.data, status: "base_generating" },
      });
      const inputSnapshot = {
        name: updatedProject.name,
        description: updatedProject.description,
        prompt: updatedProject.prompt,
        actionPrompts: recordOf(updatedProject.actionPrompts) as Prisma.InputJsonObject,
        stylePreset: updatedProject.stylePreset,
        styleNotes: updatedProject.styleNotes,
        referenceAssetIds: updatedProject.referenceAssetIds,
        autoContinue: updatedProject.autoContinue,
        modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
        requestedModel: updatedProject.imageModel || GPT_IMAGE_MODEL,
        visualQaModel: updatedProject.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
        qualityInspectionEnabled: updatedProject.qualityInspectionEnabled,
      };
      const supersededAt = now();
      await tx.codexPetArtifact.updateMany({
        where: {
          projectId: current.id,
          runId: run.id,
          userId,
          kind: "base_candidate",
          status: "ready",
        },
        data: {
          status: "superseded",
          expiresAt: new Date(supersededAt.getTime() + 7 * 24 * 60 * 60_000),
        },
      });
      await tx.codexPetJob.updateMany({
        where: {
          runId: run.id,
          projectId: current.id,
          userId,
          key: { in: ["base-candidate-1", "base-candidate-2", "base-selection"] },
        },
        data: {
          status: "queued",
          attempt: 0,
          inputArtifactIds: [],
          outputArtifactIds: [],
          output: {},
          error: null,
          workerId: null,
          startedAt: null,
          completedAt: null,
        },
      });
      const updatedRun = await tx.codexPetRun.update({
        where: { id: run.id },
        data: {
          inputSnapshot,
          autoContinue: updatedProject.autoContinue,
          requestedModel: updatedProject.imageModel || GPT_IMAGE_MODEL,
          visualQaModel: updatedProject.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
          qualityInspectionEnabled: updatedProject.qualityInspectionEnabled,
          colorKey: null,
          selectedBaseArtifactId: null,
          status: "base_generating",
          progressStage: "base_generating",
          progressPercent: 5,
          progressMessage: "项目输入已更新，正在重新生成主形象候选",
          error: null,
          completedAt: null,
          lastEventSequence: { increment: 1 },
        },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: current.id,
          runId: run.id,
          userId,
          sequence: updatedRun.lastEventSequence,
          type: "stage.started",
          stage: "base_generating",
          message: "项目输入已更新，正在重新生成主形象候选",
          progress: 5,
          payload: { projectInputUpdated: true },
        },
      });
      return { project: updatedProject as ProjectShape, run: updatedRun as RunShape };
    }).catch((error) => {
      if (error instanceof Error && error.message === "CODEX_PET_EDIT_STATE_CONFLICT") return null;
      throw error;
    });
    if (!regenerated) return reply.code(409).send({ error: "项目状态已变化，请刷新后重试" });
    try {
      await enqueueRun(regenerated.run.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: regenerated.run.id }, "Codex pet edited base regeneration enqueue failed");
      return reply.code(503).send({
        error: "修改已保存，任务将由恢复程序自动入队",
        retryable: true,
        runId: regenerated.run.id,
      });
    }
    await notifyEvent(app, deps, regenerated.run.id);
    return reply.code(202).send({
      success: true,
      data: {
        project: serializeProject(regenerated.project),
        run: serializeRun(regenerated.run),
        candidatesRegenerated: true,
      },
    });
  });

  app.delete("/api/workflow/codex-pets/projects/:projectId", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能删除" });
    const deletedAt = now();
    const marked = await prisma.$transaction(async (tx) => {
      // Serialize with /start for this user. The deleting status stops
      // workers from publishing new project state while deletedAt hides this
      // durable tombstone from the user's history and detail endpoints.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
      return tx.codexPetProject.updateMany({
        where: { id: project.id, userId, deletedAt: null },
        data: { status: "deleting", deletedAt, createIdempotencyKey: null },
      });
    });
    if (marked.count === 0) return reply.code(404).send({ error: "桌宠项目不存在" });
    const runs = await prisma.codexPetRun.findMany({ where: { projectId: project.id, userId }, orderBy: { createdAt: "desc" } });
    const stillRunning = runs.filter((run) => isActiveRunStatus(run.status) || Boolean(run.workerId));
    let waitingForWorker = stillRunning.some((run) => Boolean(run.workerId));
    if (stillRunning.length > 0) {
      for (const run of stillRunning) {
        if (isActiveRunStatus(run.status)) {
          try {
            const cancellation = await settleCancellationRefund(await createCancellation(userId, project.id, run.id));
            waitingForWorker ||= Boolean(cancellation.run.workerId);
            await notifyEvent(app, deps, run.id);
          } catch (error) {
            if ((error as Error).message !== "CODEX_PET_RUN_TERMINAL") {
              // The soft-delete marker is already committed. Keep DELETE
              // successful and let persisted project/run state plus billing
              // maintenance converge instead of exposing a stale history row
              // after a transient cancellation/refund failure.
              app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet soft-delete cancellation deferred");
            }
          }
        }
        try {
          await deps.requestCancellation?.(run.id);
        } catch (error) {
          app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet cancellation signal failed; persisted flag remains authoritative");
        }
      }
    }
    return reply.code(202).send({
      success: true,
      data: {
        projectId: project.id,
        softDeleted: true,
        deletionPending: waitingForWorker,
        waitingForWorker,
        message: waitingForWorker ? "已从项目历史隐藏，正在停止运行" : "项目已从历史隐藏，数据和产物已保留",
      },
    });
  });

  app.post("/api/workflow/codex-pets/projects/:projectId/start", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    const body = startRunSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "启动参数不合法" });
    const key = resolveIdempotencyKey(request.headers["idempotency-key"], body.data.idempotencyKey);
    if (!key.success) return reply.code(400).send({ error: "启动制作必须提供一致且合法的幂等键" });

    const initialProject = await ownedProject(userId, params.data.projectId);
    if (!initialProject) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (initialProject.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能创建新运行" });
    }
    const selectedImageModel = initialProject.imageModel || GPT_IMAGE_MODEL;
    const selectedVisualQaModel = initialProject.visualQaModel || CODEX_PET_VISUAL_QA_MODEL;
    const qualityInspectionEnabled = initialProject.qualityInspectionEnabled === true;
    if (initialProject.status === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能开始新制作" });
    if (selectedImageModel !== GPT_IMAGE_MODEL) {
      return reply.code(409).send({ error: "该旧项目使用的生图模型已停用，请迁移为 GPT Image 2 后新建运行" });
    }
    if (!initialProject.prompt.trim() && initialProject.referenceAssetIds.length === 0) {
      return reply.code(400).send({ error: "请填写角色提示词或上传至少一张参考图" });
    }
    if (!await validateReferenceAssets(userId, initialProject.referenceAssetIds)) {
      return reply.code(400).send({ error: "项目参考图不存在、无权使用或已失效" });
    }
    if (qualityInspectionEnabled) {
      try {
        if (!await selectedVisualModelIsAvailable(selectedVisualQaModel)) {
          return reply.code(409).send({ error: "所选视觉理解/质检模型已不在模型广场，请重新选择" });
        }
      } catch (error) {
        app.log.warn({ error: safeDiagnostic(error) }, "failed to verify Codex pet visual model selection");
        return reply.code(503).send({ error: "模型目录暂不可用，请稍后重试" });
      }
    }
    try {
      if (qualityInspectionEnabled) {
        (deps.assertVisualQaReady ?? (() => { assertCodexPetVisualQaRoute(process.env, selectedVisualQaModel); }))();
      }
      (deps.assertImageReady ?? (() => { assertCodexPetImageRoute(process.env, selectedImageModel); }))();
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), status: "model_route_unavailable" }, "Codex pet model route preflight failed");
      return reply.code(503).send({ error: "桌宠 GPT 生图或所选视觉模型（如 GPT-5.6）服务未就绪，请稍后重试" });
    }
    let pricing: ResourcePrice;
    try {
      pricing = await price();
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error) }, "failed to load Codex pet price before start");
      return reply.code(502).send({ error: "桌宠套餐计费服务不可用" });
    }
    if (!pricing.enabled) return reply.code(409).send({ error: "Codex 桌宠套餐当前已停用" });
    if (!isCodexPetPerImagePrice(pricing)) return reply.code(500).send({ error: "Codex 桌宠单次生图计价配置错误" });

    // The GPT-only contract uses one reservation for the fourteen planned
    // provider calls. The durable run commits before the external reservation,
    // then becomes queue-eligible only after that idempotent reservation wins.
    let prepared: { readonly project: ProjectShape; readonly run: RunShape; readonly created: boolean };
    try {
      prepared = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        const project = await tx.codexPetProject.findFirst({ where: { id: params.data.projectId, userId } });
        if (!project) throw new Error("CODEX_PET_PROJECT_NOT_FOUND");
        if ((project.imageModel || GPT_IMAGE_MODEL) !== GPT_IMAGE_MODEL) throw new Error("CODEX_PET_LEGACY_MODEL");
        const existing = await tx.codexPetRun.findFirst({ where: { projectId: project.id, userId, idempotencyKey: key.value } });
        if (existing) {
          if (existing.billingMode !== CODEX_PET_PER_IMAGE_BILLING_MODE) throw new Error("CODEX_PET_LEGACY_RUN");
          return { project: project as ProjectShape, run: existing as RunShape, created: false };
        }
        if (project.status !== "draft") throw new Error("CODEX_PET_PROJECT_NOT_DRAFT");
        const active = await tx.codexPetRun.findFirst({ where: { userId, status: { in: [...BLOCKING_RUN_STATUSES] } }, orderBy: { createdAt: "desc" } });
        if (active) throw new ActiveCodexPetRunError(active.id, active.status);
        const runId = deriveCodexPetRunId(userId, project.id, key.value);
        const operationId = `codex-pet:run:${runId}:planned-images`;
        const inputSnapshot = {
        name: project.name,
        description: project.description,
        prompt: project.prompt,
        actionPrompts: recordOf(project.actionPrompts) as Prisma.InputJsonObject,
        stylePreset: project.stylePreset,
        styleNotes: project.styleNotes,
        referenceAssetIds: project.referenceAssetIds,
        autoContinue: project.autoContinue,
        modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
        requestedModel: GPT_IMAGE_MODEL,
        qualityInspectionEnabled: project.qualityInspectionEnabled === true,
        visualQaModel: project.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
        billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
        plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        perImageCallPoints: Math.ceil(pricing.rate),
      };
        const run = await tx.codexPetRun.create({ data: {
        id: runId,
        projectId: project.id,
        userId,
        idempotencyKey: key.value,
        inputSnapshot,
        autoContinue: project.autoContinue,
        requestedModel: GPT_IMAGE_MODEL,
        visualQaModel: project.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
        qualityInspectionEnabled: project.qualityInspectionEnabled === true,
        billingOperationId: operationId,
        billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
        billingResourceKey: pricing.resourceKey,
        billingReservedUnits: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        billingSettlementStatus: "reserving",
        billingChargeStatus: "reserving",
        plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        status: "queued",
        progressStage: "queued",
        progressPercent: 0,
        progressMessage: "正在预留最多 14 次 GPT Image 2 调用额度",
        lastEventSequence: 1,
        } });
        await tx.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id, status: "queued" } });
        // 时间线的第一条：预留流程不再走 reconciler，run.queued 必须在这里落库，
        // 否则前端时间线要等 Worker 首个事件才有内容。
        await tx.codexPetEvent.create({ data: {
          projectId: project.id,
          runId: run.id,
          userId,
          sequence: 1,
          type: "run.queued",
          stage: "queued",
          message: "桌宠制作任务已进入队列",
          progress: 0,
          payload: { resourceKey: pricing.resourceKey, reservedUnits: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT },
        } });
        return { project: project as ProjectShape, run: run as RunShape, created: true };
      });
    } catch (error) {
      if (error instanceof ActiveCodexPetRunError) {
        return reply.code(409).send({ error: error.message, activeRunId: error.runId });
      }
      if (error instanceof Error && error.message === "CODEX_PET_PROJECT_NOT_FOUND") {
        return reply.code(404).send({ error: "桌宠项目不存在" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_LEGACY_MODEL") {
        return reply.code(409).send({ error: "该旧项目使用的生图模型已停用，请迁移为 GPT Image 2 后新建运行" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_LEGACY_RUN") {
        return reply.code(409).send({ error: "该历史运行使用旧计费合同，不能重新启动" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_PROJECT_NOT_DRAFT") {
        return reply.code(409).send({ error: "只有草稿项目可以开始新的桌宠制作，请复制为新项目" });
      }
      app.log.error({ error: safeDiagnostic(error), status: "run_create_failed" }, "failed to create Codex pet run");
      return reply.code(502).send({ error: "启动桌宠制作失败，请稍后重试" });
    }

    let activeRun = prepared.run;
    if (activeRun.billingSettlementStatus !== "reserved" && activeRun.billingSettlementStatus !== "settled") {
      const reservationLeaseUntil = new Date(now().getTime() + 60_000);
      const reservationClaim = await prisma.codexPetRun.updateMany({
        where: {
          id: activeRun.id,
          projectId: params.data.projectId,
          userId,
          billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
          billingSettlementStatus: { in: ["reserving", "insufficient", "reserve_failed"] },
          OR: [{ billingChargeLeaseUntil: null }, { billingChargeLeaseUntil: { lte: now() } }],
        },
        data: {
          billingChargeStatus: "reserving",
          billingChargeLeaseUntil: reservationLeaseUntil,
          billingChargeError: null,
        },
      });
      if (reservationClaim.count !== 1) {
        const currentProject = await ownedProject(userId, params.data.projectId);
        if (!currentProject) return reply.code(404).send({ error: "桌宠项目不存在" });
        return reply.code(202).send({
          success: true,
          data: { project: serializeProject(currentProject as ProjectShape), run: serializeRun(activeRun as RunShape), billingPending: true },
          error: "调用额度预留正在确认，尚未入队",
          retryable: true,
          runId: activeRun.id,
        });
      }
      try {
        if (!billing.reserveResource) throw new Error("Codex pet billing reserve capability is unavailable");
        const receipt = await billing.reserveResource({
          operationId: activeRun.billingOperationId!,
          userId,
          resourceKey: activeRun.billingResourceKey || pricing.resourceKey,
          units: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        });
        activeRun = await prisma.codexPetRun.update({ where: { id: activeRun.id }, data: {
          billingReservedPoints: receipt.reserved,
          billingChargeStatus: "reserved",
          billingSettlementStatus: "reserved",
          billingActivatedAt: now(),
          billingChargeLeaseUntil: null,
          progressMessage: "14 次 GPT Image 2 调用额度已预留，等待 Worker",
        } });
      } catch (error) {
        const insufficient = error instanceof Error && error.name === "InsufficientBalanceError";
        activeRun = await prisma.codexPetRun.update({ where: { id: activeRun.id }, data: {
          billingChargeStatus: insufficient ? "insufficient" : "uncertain",
          billingSettlementStatus: insufficient ? "insufficient" : "reserve_failed",
          billingChargeError: safeDiagnostic(error),
          billingChargeLeaseUntil: null,
          progressMessage: insufficient ? "积分不足，未创建可执行生图任务" : "调用额度预留失败，未创建可执行生图任务",
        } });
        return reply.code(insufficient ? 402 : 503).send({ error: activeRun.progressMessage, runId: activeRun.id, retryable: !insufficient });
      }
    }
    if (activeRun.status === "queued") {
      try {
        await enqueueRun(activeRun.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: activeRun.id }, "reserved Codex pet run enqueue failed");
        return reply.code(503).send({ error: "调用额度已预留，但任务暂未入队；请使用同一幂等键重试", retryable: true, runId: activeRun.id });
      }
    }
    const currentProject = await ownedProject(userId, params.data.projectId);
    if (!currentProject) return reply.code(404).send({ error: "桌宠项目不存在" });
    await notifyEvent(app, deps, activeRun.id);
    return reply.code(prepared.created ? 202 : 200).send({ success: true, data: { project: serializeProject(currentProject as ProjectShape), run: serializeRun(activeRun as RunShape) } });

  });

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/continue-failed", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = failedContinuationSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "失败续跑参数不合法" });
    const key = resolveIdempotencyKey(request.headers["idempotency-key"], body.data.idempotencyKey);
    if (!key.success) return reply.code(400).send({ error: "失败续跑必须提供一致且合法的幂等键" });

    let pricing: ResourcePrice;
    try {
      pricing = await price();
      (deps.assertImageReady ?? (() => { assertCodexPetImageRoute(process.env, GPT_IMAGE_MODEL); }))();
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), status: "continuation_preflight_failed" }, "Codex pet continuation preflight failed");
      return reply.code(503).send({ error: "GPT Image 2 生图或计费服务未就绪，未创建续跑" });
    }
    if (!pricing.enabled || !isCodexPetPerImagePrice(pricing)) {
      return reply.code(409).send({ error: "Codex 桌宠单次生图计费当前不可用" });
    }

    const continuationIdempotencyKey = `failed-continuation:${key.value}`;
    const continuationRunId = deriveCodexPetRunId(userId, params.data.projectId, continuationIdempotencyKey);
    let prepared: {
      readonly run: RunShape;
      readonly created: boolean;
      readonly sourceBaseArtifactId: string;
      readonly plannedCallsRemaining: number;
    };
    try {
      prepared = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        const existing = await tx.codexPetRun.findFirst({
          where: { projectId: params.data.projectId, userId, idempotencyKey: continuationIdempotencyKey },
        });
        if (existing) {
          const snapshot = recordOf(existing.inputSnapshot);
          const continuation = recordOf(snapshot.gptFailedContinuation);
          return {
            run: existing as RunShape,
            created: false,
            sourceBaseArtifactId: String(continuation.sourceBaseArtifactId ?? ""),
            plannedCallsRemaining: Number(continuation.plannedCallsRemaining ?? 0),
          };
        }

        const [project, source, sourceJobs, sourceArtifacts, sourceCalls, active] = await Promise.all([
          tx.codexPetProject.findFirst({ where: { id: params.data.projectId, userId } }),
          tx.codexPetRun.findFirst({ where: { id: params.data.runId, projectId: params.data.projectId, userId } }),
          tx.codexPetJob.findMany({ where: { runId: params.data.runId, projectId: params.data.projectId, userId } }),
          tx.codexPetArtifact.findMany({ where: { runId: params.data.runId, projectId: params.data.projectId, userId, kind: "base_candidate", status: "ready" } }),
          tx.codexPetImageCall.findMany({ where: { runId: params.data.runId, projectId: params.data.projectId, userId }, orderBy: { createdAt: "asc" } }),
          tx.codexPetRun.findFirst({
            where: {
              userId,
              id: { not: params.data.runId },
              status: { in: [...BLOCKING_RUN_STATUSES] },
            },
          }),
        ]);
        if (!project || !source) throw new Error("CODEX_PET_CONTINUATION_NOT_FOUND");
        if (active) throw new ActiveCodexPetRunError(active.id, active.status);
        const candidateOneJob = sourceJobs.find((job) => job.key === "base-candidate-1");
        const candidateTwoJob = sourceJobs.find((job) => job.key === "base-candidate-2");
        const sourceBaseArtifactId = candidateOneJob?.outputArtifactIds.length === 1
          ? candidateOneJob.outputArtifactIds[0]!
          : "";
        const sourceBase = sourceArtifacts.find((artifact) => artifact.id === sourceBaseArtifactId);
        const plannedSent = sourceCalls.filter((call) => call.callKind === "planned" && call.sentAt);
        const candidateTwoCall = plannedSent.find((call) => call.jobKey === "base-candidate-2");
        const sourceIsEligible = project.latestRunId === source.id
          && project.status === "failed"
          && !project.deletedAt
          && source.status === "failed"
          && source.progressStage === "failed"
          && source.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE
          && source.billingSettlementStatus === "settled"
          && source.billingSettledUnits === 2
          && source.imageGenerationCallCount === 2
          && source.plannedImageCallLimit === CODEX_PET_PLANNED_IMAGE_CALL_LIMIT
          && source.requestedModel === GPT_IMAGE_MODEL
          && source.qualityInspectionEnabled === false
          && source.hasSuccessfulImage
          && !source.selectedBaseArtifactId
          && !source.workerId
          && !source.cancelRequested
          && candidateOneJob?.status === "completed"
          && candidateOneJob.attempt === 1
          && candidateTwoJob?.status === "failed"
          && candidateTwoJob.attempt === 1
          && Boolean(sourceBase)
          && plannedSent.length === 2
          && plannedSent.some((call) => call.jobKey === "base-candidate-1" && call.status === "succeeded")
          && candidateTwoCall?.status === "failed"
          && /429|rate.?limit|concurrency limit/i.test(candidateTwoCall.error ?? "");
        if (!sourceIsEligible) throw new Error("CODEX_PET_CONTINUATION_NOT_ELIGIBLE");

        const plannedCallsRemaining = CODEX_PET_PLANNED_IMAGE_CALL_LIMIT - plannedSent.length;
        const inputSnapshot = {
          ...recordOf(source.inputSnapshot),
          gptFailedContinuation: {
            schemaVersion: CODEX_PET_GPT_FAILED_CONTINUATION_SCHEMA_VERSION,
            initializedAt: now().toISOString(),
            sourceRunId: source.id,
            sourceBaseArtifactId,
            retryJobKey: "base-candidate-2",
            retryReason: "rate_limit",
            sourcePlannedCallCount: plannedSent.length,
            plannedCallsRemaining,
            sourceSettlementOperationId: source.billingOperationId,
            sourceCallOperationIds: plannedSent.map((call) => call.operationId),
          },
        };
        const operationId = `codex-pet:run:${continuationRunId}:planned-images`;
        const run = await tx.codexPetRun.create({ data: {
          id: continuationRunId,
          projectId: project.id,
          userId,
          idempotencyKey: continuationIdempotencyKey,
          inputSnapshot,
          status: "awaiting_regeneration_approval",
          progressStage: "awaiting_regeneration_approval",
          progressPercent: 8,
          progressMessage: "候选 1 已锁定复用；候选 2 的 429 重试等待单次额外调用授权",
          autoContinue: false,
          colorKey: source.colorKey,
          billingOperationId: operationId,
          billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
          billingResourceKey: pricing.resourceKey,
          billingReservedUnits: plannedCallsRemaining,
          billingSettlementStatus: "reserving",
          billingChargeStatus: "reserving",
          requestedModel: GPT_IMAGE_MODEL,
          visualQaModel: source.visualQaModel,
          qualityInspectionEnabled: false,
          plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
          pendingImageJobKey: "base-candidate-2",
          hasSuccessfulImage: true,
          actualModels: source.actualModels,
          startedAt: now(),
          lastEventSequence: 1,
        } });
        await tx.codexPetJob.create({ data: {
          projectId: project.id,
          runId: run.id,
          userId,
          key: "base-candidate-2",
          kind: "base_candidate",
          status: "awaiting_approval",
          dependencyKeys: [],
          attempt: 0,
          maxAttempts: 1,
          input: { candidateIndex: 2, continuationSourceRunId: source.id },
          error: "上游 429 后已停止；等待一次额外调用授权",
        } });
        await tx.codexPetProject.update({
          where: { id: project.id },
          data: { latestRunId: run.id, status: "awaiting_regeneration_approval" },
        });
        await tx.codexPetEvent.create({ data: {
          projectId: project.id,
          runId: run.id,
          userId,
          sequence: 1,
          type: "run.continuation_prepared",
          stage: "awaiting_regeneration_approval",
          jobKey: "base-candidate-2",
          message: "候选 1 将复用；候选 2 的 429 重试等待单次授权",
          progress: 8,
          payload: {
            sourceRunId: source.id,
            sourceBaseArtifactId,
            sourcePlannedCallCount: plannedSent.length,
            plannedCallsRemaining,
            providerCallReused: true,
          },
        } });
        return { run: run as RunShape, created: true, sourceBaseArtifactId, plannedCallsRemaining };
      });
    } catch (error) {
      if (error instanceof ActiveCodexPetRunError) return reply.code(409).send({ error: error.message, activeRunId: error.runId });
      if (error instanceof Error && error.message === "CODEX_PET_CONTINUATION_NOT_FOUND") {
        return reply.code(404).send({ error: "失败桌宠运行不存在" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_CONTINUATION_NOT_ELIGIBLE") {
        return reply.code(409).send({ error: "只允许复用候选 1 并续跑因 429 失败的 GPT Image 2 候选 2" });
      }
      app.log.error({ error: safeDiagnostic(error), runId: params.data.runId }, "failed to prepare GPT Codex pet continuation");
      return reply.code(502).send({ error: "创建同项目续跑失败，未联系生图服务" });
    }

    let continuationRun = prepared.run;
    if (continuationRun.billingSettlementStatus !== "reserved") {
      const claim = await prisma.codexPetRun.updateMany({
        where: {
          id: continuationRun.id,
          projectId: params.data.projectId,
          userId,
          billingSettlementStatus: { in: ["reserving", "insufficient", "reserve_failed"] },
          OR: [{ billingChargeLeaseUntil: null }, { billingChargeLeaseUntil: { lte: now() } }],
        },
        data: { billingChargeLeaseUntil: new Date(now().getTime() + 60_000), billingChargeError: null },
      });
      if (claim.count !== 1) {
        return reply.code(202).send({
          success: true,
          data: { run: serializeRun(continuationRun), approvalPending: true },
          error: "剩余计划内额度正在预留，尚不能批准重试",
          retryable: true,
        });
      }
      try {
        if (!billing.reserveResource) throw new Error("Codex pet billing reserve capability is unavailable");
        const receipt = await billing.reserveResource({
          operationId: continuationRun.billingOperationId!,
          userId,
          resourceKey: continuationRun.billingResourceKey || pricing.resourceKey,
          units: prepared.plannedCallsRemaining,
        });
        continuationRun = await prisma.codexPetRun.update({ where: { id: continuationRun.id }, data: {
          billingReservedPoints: receipt.reserved,
          billingChargeStatus: "reserved",
          billingSettlementStatus: "reserved",
          billingActivatedAt: now(),
          billingChargeLeaseUntil: null,
          billingChargeError: null,
        } });
      } catch (error) {
        const insufficient = error instanceof Error && error.name === "InsufficientBalanceError";
        continuationRun = await prisma.codexPetRun.update({ where: { id: continuationRun.id }, data: {
          billingChargeStatus: insufficient ? "insufficient" : "uncertain",
          billingSettlementStatus: insufficient ? "insufficient" : "reserve_failed",
          billingChargeError: safeDiagnostic(error),
          billingChargeLeaseUntil: null,
        } });
        return reply.code(insufficient ? 402 : 503).send({
          error: insufficient ? "积分不足，未预留剩余 12 次计划内调用" : "剩余计划内调用预留失败，未联系生图服务",
          runId: continuationRun.id,
          retryable: !insufficient,
        });
      }
    }
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    await notifyEvent(app, deps, continuationRun.id);
    return reply.code(prepared.created ? 202 : 200).send({ success: true, data: {
      project: serializeProject(project as ProjectShape),
      run: serializeRun(continuationRun),
      sourceRunId: params.data.runId,
      reusedArtifactId: prepared.sourceBaseArtifactId,
      plannedCallsRemaining: prepared.plannedCallsRemaining,
    } });
  });

  /**
   * Resume a failed run whose deterministic/visual gate named the action groups
   * it rejected, redoing only those boards inside the same reservation.
   *
   * This charges nothing by itself: the reset rows arrive at the per-image ledger
   * as fresh logical attempts, so each redo still has to be approved and paid for
   * one at a time. Without this route the gate scope recorded at failure time had
   * no consumer and the only exit was copying the project and paying for all
   * fourteen planned calls again.
   */
  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/resume-gate-failure", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = gateFailureResumeSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "闸门续跑参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || run.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能继续制作" });
    }
    const gateFailure = readCodexPetGateFailureSnapshot(run.inputSnapshot);
    if (!gateFailure) return reply.code(409).send({ error: "本次失败没有可重做的动作组范围，请复制为新项目重跑" });
    const active = await prisma.codexPetRun.findFirst({
      where: {
        userId,
        id: { not: run.id },
        status: { in: [...BLOCKING_RUN_STATUSES] },
      },
      select: { id: true, status: true },
    });
    if (active) {
      return reply.code(409).send({
        error: new ActiveCodexPetRunError(active.id, active.status).message,
        activeRunId: active.id,
      });
    }

    try {
      await initializeCodexPetFailedContinuation({
        prisma,
        runId: run.id,
        projectId: params.data.projectId,
        userId,
        reason: body.data.reason?.trim()
          || `${gateFailure.gate} 闸门指认动作组重做：${gateFailure.rows.join("、")}`,
      });
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: run.id, status: "gate_resume_rejected" }, "Codex pet gate-failure resume rejected");
      return reply.code(409).send({ error: safeDiagnostic(error) });
    }
    try {
      await enqueueRun(run.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: run.id }, "failed to enqueue Codex pet gate-failure resume");
      return reply.code(503).send({ error: "续跑已登记但入队失败，请稍后重试", runId: run.id, retryable: true });
    }
    const resumed = await ownedRun(userId, params.data.projectId, params.data.runId);
    const refreshedProject = await ownedProject(userId, params.data.projectId);
    await notifyEvent(app, deps, run.id);
    return reply.code(202).send({ success: true, data: {
      ...(refreshedProject ? { project: serializeProject(refreshedProject as ProjectShape) } : {}),
      run: serializeRun((resumed ?? run) as RunShape),
      gate: gateFailure.gate,
      rows: [...gateFailure.rows],
    } });
  });

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/base-selection", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = baseSelectionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "主形象选择参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || run.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能继续制作" });
    }
    if (project.status === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能修改主形象" });

    if ("regenerate" in body.data) {
      if (run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
        return reply.code(409).send({ error: "主形象候选已属于计划内调用；额外生成必须等待失败后逐次批准并单独计费" });
      }
      if (run.status !== "awaiting_base_review" && run.status !== "base_generating") {
        return reply.code(409).send({ error: "只有等待主形象确认时才能重生候选" });
      }
      const regenerated = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${run.id}`);
        const mutableProject = await tx.codexPetProject.findFirst({
          where: { id: run.projectId, userId, status: { not: "deleting" } },
          select: { id: true },
        });
        if (!mutableProject) throw new Error("CODEX_PET_PROJECT_DELETING");
        const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: run.projectId, userId } });
        if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
        // A concurrent retry that sees the already-reset state only needs to
        // enqueue the same BullMQ job again; it must not invalidate new output.
        if (current.status === "base_generating" && !current.selectedBaseArtifactId) {
          return { run: current, reset: false };
        }
        if (current.status !== "awaiting_base_review") throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
        const supersededAt = now();
        await tx.codexPetArtifact.updateMany({
          where: {
            projectId: current.projectId,
            runId: current.id,
            userId,
            kind: "base_candidate",
            status: "ready",
          },
          data: {
            status: "superseded",
            expiresAt: new Date(supersededAt.getTime() + 7 * 24 * 60 * 60_000),
          },
        });
        await tx.codexPetJob.updateMany({
          where: {
            runId: current.id,
            projectId: current.projectId,
            userId,
            key: { in: ["base-candidate-1", "base-candidate-2", "base-selection"] },
          },
          data: {
            status: "queued",
            attempt: 0,
            outputArtifactIds: [],
            error: null,
            workerId: null,
            startedAt: null,
            completedAt: null,
          },
        });
        const next = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            selectedBaseArtifactId: null,
            status: "base_generating",
            progressStage: "base_generating",
            progressPercent: 5,
            progressMessage: "正在重新生成两个主形象候选",
            error: null,
            completedAt: null,
            lastEventSequence: { increment: 1 },
          },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId: current.projectId,
            runId: current.id,
            userId,
            sequence: next.lastEventSequence,
            type: "stage.started",
            stage: "base_generating",
            message: "正在重新生成两个主形象候选",
            progress: 5,
            payload: { regenerate: true },
          },
        });
        await tx.codexPetProject.updateMany({
          where: { id: current.projectId, userId, latestRunId: current.id },
          data: { status: "base_generating" },
        });
        return { run: next, reset: true };
      }).catch((error) => {
        if (error instanceof Error && error.message === "CODEX_PET_BASE_STATE_CONFLICT") return null;
        if (error instanceof Error && error.message === "CODEX_PET_PROJECT_DELETING") return "deleting" as const;
        throw error;
      });
      if (regenerated === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能重生主形象" });
      if (!regenerated) return reply.code(409).send({ error: "主形象确认状态已变化，请刷新后重试" });
      try {
        await enqueueRun(regenerated.run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: regenerated.run.id }, "Codex pet base regeneration enqueue failed");
        return reply.code(503).send({ error: "重生请求已保存，但暂时未能入队；请重试", retryable: true });
      }
      if (regenerated.reset) await notifyEvent(app, deps, regenerated.run.id);
      return reply.code(regenerated.reset ? 202 : 200).send({
        success: true,
        data: { run: serializeRun(regenerated.run as RunShape) },
      });
    }

    if ("autoSelect" in body.data) {
      if (run.status !== "awaiting_base_review" && !(run.status === "base_generating" && run.autoContinue && !run.selectedBaseArtifactId)) {
        return reply.code(409).send({ error: "当前运行不在可自动选择主形象的阶段" });
      }
      const delegated = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${run.id}`);
        const mutableProject = await tx.codexPetProject.findFirst({
          where: { id: run.projectId, userId, status: { not: "deleting" } },
          select: { id: true },
        });
        if (!mutableProject) throw new Error("CODEX_PET_PROJECT_DELETING");
        const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: run.projectId, userId } });
        if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
        if (current.status === "base_generating" && current.autoContinue && !current.selectedBaseArtifactId) {
          return { run: current, delegated: false };
        }
        if (current.status !== "awaiting_base_review") throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
        const next = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            autoContinue: true,
            selectedBaseArtifactId: null,
            status: "base_generating",
            progressStage: "base_generating",
            progressPercent: 15,
            progressMessage: "视觉质检正在自动选择较优主形象",
            lastEventSequence: { increment: 1 },
          },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId: current.projectId,
            runId: current.id,
            userId,
            sequence: next.lastEventSequence,
            type: "stage.started",
            stage: "base_generating",
            message: "视觉质检正在自动选择较优主形象",
            progress: 15,
            payload: { autoSelect: true },
          },
        });
        await tx.codexPetProject.updateMany({
          where: { id: current.projectId, userId, latestRunId: current.id },
          data: { status: "base_generating" },
        });
        return { run: next, delegated: true };
      }).catch((error) => {
        if (error instanceof Error && error.message === "CODEX_PET_BASE_STATE_CONFLICT") return null;
        if (error instanceof Error && error.message === "CODEX_PET_PROJECT_DELETING") return "deleting" as const;
        throw error;
      });
      if (delegated === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能自动选择主形象" });
      if (!delegated) return reply.code(409).send({ error: "主形象确认状态已变化，请刷新后重试" });
      try {
        await enqueueRun(delegated.run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: delegated.run.id }, "Codex pet automatic base selection enqueue failed");
        return reply.code(503).send({ error: "自动选择请求已保存，但暂时未能入队；请重试", retryable: true });
      }
      if (delegated.delegated) await notifyEvent(app, deps, delegated.run.id);
      return reply.code(delegated.delegated ? 202 : 200).send({
        success: true,
        data: { run: serializeRun(delegated.run as RunShape) },
      });
    }

    const candidates = await prisma.codexPetArtifact.findMany({
      where: {
        projectId: run.projectId,
        runId: run.id,
        userId,
        kind: "base_candidate",
        status: "ready",
      },
      orderBy: { createdAt: "asc" },
    });
    if (candidates.length === 0) return reply.code(409).send({ error: "当前运行没有可选择的主形象候选" });
    if (!("artifactId" in body.data)) return reply.code(400).send({ error: "主形象选择参数不合法" });
    const artifactId = body.data.artifactId;
    const selected = candidates.find((candidate) => candidate.id === artifactId);
    if (!selected) return reply.code(400).send({ error: "只能选择当前运行所属的主形象候选" });

    if (run.status !== "awaiting_base_review") {
      if (run.selectedBaseArtifactId !== selected.id || isTerminalRunStatus(run.status)) {
        return reply.code(409).send({ error: "当前运行不在主形象确认阶段" });
      }
      try {
        await enqueueRun(run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: run.id }, "Codex pet continuation enqueue failed");
        return reply.code(503).send({ error: "已保存主形象选择，但续跑暂时未入队；请重试", retryable: true });
      }
      return { success: true, data: { run: serializeRun(run as RunShape) } };
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${run.id}`);
      const mutableProject = await tx.codexPetProject.findFirst({
        where: { id: run.projectId, userId, status: { not: "deleting" } },
        select: { id: true },
      });
      if (!mutableProject) throw new Error("CODEX_PET_PROJECT_DELETING");
      const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: run.projectId, userId } });
      if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
      if (current.status !== "awaiting_base_review") {
        if (current.selectedBaseArtifactId === selected.id && !isTerminalRunStatus(current.status)) return current;
        throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
      }
      const currentSelected = await tx.codexPetArtifact.findFirst({
        where: {
          id: selected.id,
          projectId: current.projectId,
          runId: current.id,
          userId,
          kind: "base_candidate",
          status: "ready",
        },
      });
      if (!currentSelected) throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
      const next = await tx.codexPetRun.update({
        where: { id: current.id },
        data: {
          selectedBaseArtifactId: selected.id,
          status: "standard_generating",
          progressStage: "standard_generating",
          progressPercent: 15,
          progressMessage: "主形象已确认，正在制作标准动作",
          lastEventSequence: { increment: 1 },
        },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: current.projectId,
          runId: current.id,
          userId,
          sequence: next.lastEventSequence,
          type: "stage.started",
          stage: "standard_generating",
          message: "主形象已确认，正在制作标准动作",
          progress: 15,
          payload: { selectedBaseArtifactId: selected.id, autoSelected: false },
        },
      });
      const selectedArtifactUpdate = await tx.codexPetArtifact.updateMany({
        where: {
          id: selected.id,
          projectId: current.projectId,
          runId: current.id,
          userId,
          kind: "base_candidate",
          status: "ready",
        },
        data: { expiresAt: null },
      });
      if (selectedArtifactUpdate.count !== 1) throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
      await tx.codexPetProject.updateMany({
        where: { id: current.projectId, userId, latestRunId: current.id },
        data: { status: "standard_generating" },
      });
      return next;
    }).catch((error) => {
      if (error instanceof Error && error.message === "CODEX_PET_BASE_STATE_CONFLICT") return null;
      if (error instanceof Error && error.message === "CODEX_PET_PROJECT_DELETING") return "deleting" as const;
      throw error;
    });
    if (updated === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能选择主形象" });
    if (!updated) return reply.code(409).send({ error: "主形象确认状态已变化，请刷新后重试" });
    try {
      await enqueueRun(updated.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: updated.id }, "Codex pet continuation enqueue failed");
      return reply.code(503).send({ error: "已保存主形象选择，但续跑暂时未入队；请重试", retryable: true });
    }
    await notifyEvent(app, deps, updated.id);
    return reply.code(202).send({ success: true, data: { run: serializeRun(updated as RunShape) } });
  });

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/cancel", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "取消参数不合法" });
    try {
      const result = await settleCancellationRefund(await createCancellation(userId, params.data.projectId, params.data.runId));
      try {
        await deps.requestCancellation?.(result.run.id);
      } catch (error) {
        app.log.warn({ error: safeDiagnostic(error), runId: result.run.id }, "Codex pet cancellation signal failed; persisted flag remains authoritative");
      }
      await notifyEvent(app, deps, result.run.id);
      return { success: true, data: { run: serializeRun(result.run) } };
    } catch (error) {
      if (error instanceof Error && error.message === "CODEX_PET_RUN_NOT_FOUND") {
        return reply.code(404).send({ error: "桌宠运行不存在" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_RUN_TERMINAL") {
        return reply.code(409).send({ error: "该桌宠运行已经结束，不能取消" });
      }
      throw error;
    }
  });

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/approve-next-image", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = extraImageApprovalSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "生图批准参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!project || !run || project.latestRunId !== run.id) return reply.code(404).send({ error: "桌宠运行不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || run.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能批准额外调用" });
    }

    if (run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
      const approvalKey = resolveIdempotencyKey(request.headers["idempotency-key"], body.data.idempotencyKey);
      if (!approvalKey.success) return reply.code(400).send({ error: "额外生图批准必须提供一致且合法的幂等键" });
      if (run.status !== "awaiting_regeneration_approval" || project.status !== "awaiting_regeneration_approval" || !run.pendingImageJobKey) {
        return reply.code(409).send({ error: "当前没有等待单次额外授权的生图调用" });
      }
      if (run.billingSettlementStatus !== "reserved") {
        return reply.code(409).send({ error: "计划内调用额度尚未成功预留，不能批准额外调用" });
      }
      const pricing = await price().catch(() => null);
      if (!pricing || !pricing.enabled || !isCodexPetPerImagePrice(pricing)) {
        return reply.code(503).send({ error: "额外生图计费服务不可用" });
      }
      const job = await prisma.codexPetJob.findFirst({ where: { runId: run.id, projectId: project.id, userId, key: run.pendingImageJobKey } });
      if (!job) return reply.code(409).send({ error: "等待批准的动作不存在" });
      // Each approval used to raise only this job's own maxAttempts, so a row
      // that kept failing could be re-approved without bound. Refused before
      // charging, and counted from paid ledger rows so refunded transport
      // failures do not consume the budget.
      const budget = await codexPetExtraCallBudget({
        prisma,
        runId: run.id,
        projectId: project.id,
        userId,
        jobKey: job.key,
      });
      if (budget.exhausted) {
        // The run is parked in `awaiting_regeneration_approval`, which is not a
        // terminal state: neither 失败续跑 (needs `failed`) nor 复制为新项目 (needs a
        // terminal run) is reachable from here. Cancelling first is the only real
        // way out, so name that step instead of an option the user cannot click.
        return reply.code(409).send({
          error: budget.exhausted === "job"
            ? `该动作的额外生图次数已达上限（${budget.jobLimit} 次），请先取消本次运行，再复制为新项目重跑`
            : `本次运行的额外生图次数已达上限（${budget.runLimit} 次），请先取消本次运行，再复制为新项目重跑`,
          data: { extraCallBudget: budget },
        });
      }
      const logicalAttempt = Math.max(1, job.attempt + 1);
      let preparedExtra: { readonly operationId: string; readonly created: boolean } | undefined;
      try {
        preparedExtra = await prepareCodexPetExtraImageCall({
          prisma,
          runId: run.id,
          projectId: project.id,
          userId,
          jobKey: job.key,
          logicalAttempt,
          requestedModel: run.requestedModel,
          resourceKey: pricing.resourceKey,
          points: pricing.rate,
        });
        if (!preparedExtra.created) {
          return reply.code(202).send({
            success: true,
            data: { run: serializeRun(run as RunShape), approvalPending: true },
            error: "该额外生图授权正在确认，未重复扣费或入队",
            retryable: true,
          });
        }
        await billing.chargeResource({ operationId: preparedExtra.operationId, userId, resourceKey: pricing.resourceKey, units: 1 });
      } catch (error) {
        if (preparedExtra?.created) {
          await prisma.codexPetImageCall.updateMany({
            where: { operationId: preparedExtra.operationId, status: "prepared" },
            data: { status: "cancelled", error: safeDiagnostic(error), completedAt: now() },
          }).catch(() => undefined);
        }
        const insufficient = error instanceof Error && error.name === "InsufficientBalanceError";
        return reply.code(insufficient ? 402 : 503).send({ error: insufficient ? "积分不足，额外生图未获授权" : "额外生图扣费失败，未联系生图服务", retryable: !insufficient });
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-extra:${run.id}:${approvalKey.value}`);
        const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: project.id, userId, status: "awaiting_regeneration_approval" } });
        if (!current || current.pendingImageJobKey !== job.key) return null;
        const resumeStage = job.kind === "base_candidate" ? "base_generating" : "direction_generating";
        await tx.codexPetJob.update({ where: { id: job.id }, data: { status: "queued", maxAttempts: logicalAttempt, workerId: null, completedAt: null, error: null } });
        const next = await tx.codexPetRun.update({ where: { id: current.id }, data: {
          status: resumeStage,
          progressStage: resumeStage,
          progressMessage: `已授权 ${job.key} 的 1 次额外 GPT Image 2 调用`,
          pendingImageJobKey: null,
          workerId: null,
          heartbeatAt: null,
          error: null,
          completedAt: null,
          lastEventSequence: { increment: 1 },
        } });
        await tx.codexPetProject.updateMany({ where: { id: project.id, userId, latestRunId: current.id }, data: { status: resumeStage } });
        await tx.codexPetEvent.create({ data: {
          projectId: project.id,
          runId: current.id,
          userId,
          sequence: next.lastEventSequence,
          type: "image.call.extra_approved",
          stage: resumeStage,
          jobKey: job.key,
          message: `用户已授权 ${job.key} 的 1 次额外生图调用`,
          progress: next.progressPercent,
          payload: { jobKey: job.key, logicalAttempt, operationId: preparedExtra!.operationId, callKind: "extra" },
        } });
        return next;
      });
      if (!updated) return reply.code(409).send({ error: "额外授权状态已变化，请刷新后重试" });
      try {
        await enqueueRun(updated.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: updated.id }, "approved extra Codex pet image call enqueue failed");
        return reply.code(503).send({ error: "额外授权已保存，任务暂未入队；可使用同一幂等键重试", retryable: true });
      }
      await notifyEvent(app, deps, updated.id);
      return reply.code(202).send({ success: true, data: { run: serializeRun(updated as RunShape) } });
    }

    if (run.status === "direction_generating" && run.imageGenerationApprovalBudget === 1) {
      try {
        await enqueueRun(run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: run.id }, "approved Codex pet image call re-enqueue failed");
        return reply.code(503).send({ error: "批准已保存，任务暂未入队；可再次点击重试", retryable: true });
      }
      return reply.code(200).send({ success: true, data: { run: serializeRun(run as RunShape) } });
    }
    if (run.status !== "awaiting_direction_review" || project.status !== "awaiting_direction_review" || !run.pendingImageJobKey) {
      return reply.code(409).send({ error: "当前没有等待批准的真实生图调用" });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-image:${run.id}`);
      const current = await tx.codexPetRun.findFirst({
        where: { id: run.id, projectId: project.id, userId, status: "awaiting_direction_review" },
      });
      if (!current?.pendingImageJobKey || current.imageGenerationApprovalBudget !== 0) return null;
      const job = await tx.codexPetJob.findFirst({
        where: { runId: current.id, projectId: project.id, userId, key: current.pendingImageJobKey },
      });
      if (!job || job.attempt >= job.maxAttempts) return null;
      await tx.codexPetJob.update({
        where: { id: job.id },
        data: { status: "queued", workerId: null, completedAt: null, error: null },
      });
      const next = await tx.codexPetRun.update({
        where: { id: current.id },
        data: {
          status: "direction_generating",
          progressStage: "direction_generating",
          progressMessage: `已批准 ${job.key} 的 1 次真实生图调用`,
          imageGenerationApprovalBudget: 1,
          pendingImageJobKey: null,
          workerId: null,
          heartbeatAt: null,
          error: null,
          completedAt: null,
          lastEventSequence: { increment: 1 },
        },
      });
      await tx.codexPetProject.updateMany({
        where: { id: project.id, userId, latestRunId: current.id, status: "awaiting_direction_review" },
        data: { status: "direction_generating" },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: project.id,
          runId: current.id,
          userId,
          sequence: next.lastEventSequence,
          type: "image.call.approved",
          stage: "direction_generating",
          jobKey: job.key,
          message: `用户已批准 ${job.key} 的 1 次真实生图调用`,
          progress: next.progressPercent,
          payload: { jobKey: job.key, approvedCalls: 1 },
        },
      });
      return next;
    });
    if (!updated) return reply.code(409).send({ error: "批准状态已变化或该方向任务已用完尝试次数，请刷新后重试" });
    try {
      await enqueueRun(updated.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: updated.id }, "approved Codex pet image call enqueue failed");
      return reply.code(503).send({ error: "批准已保存，任务暂未入队；可再次点击重试", retryable: true });
    }
    await notifyEvent(app, deps, updated.id);
    return reply.code(202).send({ success: true, data: { run: serializeRun(updated as RunShape) } });
  });

  app.get("/api/workflow/codex-pets/projects/:projectId/runs/:runId/events", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const query = eventsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "事件查询参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });
    const initialTail = query.data.after === 0;
    const events = await prisma.codexPetEvent.findMany({
      where: { runId: run.id, projectId: run.projectId, userId, sequence: { gt: query.data.after } },
      orderBy: { sequence: initialTail ? "desc" : "asc" },
      take: initialTail ? 200 : 500,
    });
    const ordered = initialTail ? events.reverse() : events;
    return {
      success: true,
      data: {
        events: ordered.map((event) => serializeEvent(event as EventShape)),
        cursor: ordered.at(-1)?.sequence ?? query.data.after,
      },
    };
  });

  app.get("/api/workflow/codex-pets/projects/:projectId/runs/:runId/events/stream", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const query = eventsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "事件流参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let cursor = eventCursor(request, query.data.after);
    app.log.info({ runId: run.id, status: "opened" }, "Codex pet SSE connection opened");
    let flushing = false;
    const flush = async () => {
      if (flushing || reply.raw.destroyed || reply.raw.writableEnded) return;
      flushing = true;
      try {
        const events = await prisma.codexPetEvent.findMany({
          where: { runId: run.id, projectId: run.projectId, userId, sequence: { gt: cursor } },
          orderBy: { sequence: "asc" },
          take: 200,
        });
        for (const event of events) {
          reply.raw.write(formatCodexPetSseEvent(event as EventShape));
          cursor = event.sequence;
        }
      } finally {
        flushing = false;
      }
    };
    const triggerFlush = () => {
      void flush().catch((error) => app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet SSE database replay failed"));
    };

    let unsubscribe: (() => Promise<void> | void) | undefined;
    let redisFallback = false;
    try {
      try {
        const subscribe = deps.subscribeRunEvents ?? defaultSubscribeRunEvents;
        unsubscribe = await subscribe(run.id, triggerFlush) ?? undefined;
      } catch (error) {
        redisFallback = true;
        app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet SSE Redis subscription unavailable; polling database");
      }
      await flush();
      const poller = setInterval(triggerFlush, deps.ssePollIntervalMs ?? 2_000);
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      }, deps.sseHeartbeatIntervalMs ?? 15_000);
      try {
        await (deps.waitForSseDisconnect ?? defaultWaitForSseDisconnect)(request, reply);
      } finally {
        clearInterval(poller);
        clearInterval(heartbeat);
      }
    } finally {
      await unsubscribe?.();
      app.log.info({ runId: run.id, status: "closed", redisFallback }, "Codex pet SSE connection closed");
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });

  async function readyProjectAssets(userId: string, projectId: string, requestedRunId?: string) {
    const project = await ownedProject(userId, projectId);
    const runId = requestedRunId ?? project?.latestRunId;
    if (!project || !runId) return null;
    const run = await prisma.codexPetRun.findFirst({
      where: { id: runId, projectId: project.id, userId },
    });
    if (!run
      || !DELIVERABLE_RUN_STATUSES.includes(run.status as (typeof DELIVERABLE_RUN_STATUSES)[number])
      || !run.spritesheetArtifactId
      || !run.packageArtifactId) return null;
    const [spritesheet, packageArtifact] = await Promise.all([
      prisma.codexPetArtifact.findFirst({
        where: { id: run.spritesheetArtifactId, runId: run.id, projectId: project.id, userId },
      }),
      prisma.codexPetArtifact.findFirst({
        where: { id: run.packageArtifactId, runId: run.id, projectId: project.id, userId },
      }),
    ]);
    if (!spritesheet || !packageArtifact) return null;
    if (!assertFinalSpritesheet(spritesheet as CodexPetArtifactShape)
      || !assertPackageArtifact(packageArtifact as CodexPetArtifactShape)) return null;
    return {
      project: project as ProjectShape,
      run: run as RunShape,
      spritesheet: spritesheet as CodexPetArtifactShape,
      packageArtifact: packageArtifact as CodexPetArtifactShape,
    };
  }

  app.post("/api/workflow/codex-pets/projects/:projectId/install-link", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const query = deliveryRunQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "运行参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    const ready = await readyProjectAssets(userId, project.id, query.data.runId);
    if (!ready) return reply.code(409).send({ error: "桌宠兼容包尚未生成，暂不能安装" });
    try {
      const secret = signingSecret(deps);
      const origin = publicBaseUrl(deps);
      const expiresAtSeconds = Math.floor(now().getTime() / 1_000) + CODEX_PET_INSTALL_URL_TTL_SECONDS;
      const signature = signCodexPetArtifact(ready.spritesheet.id, expiresAtSeconds, secret);
      const imageUrl = `${origin}/api/public/codex-pets/artifacts/${encodeURIComponent(ready.spritesheet.id)}?exp=${expiresAtSeconds}&sig=${encodeURIComponent(signature)}`;
      const installParams = new URLSearchParams({
        name: ready.project.name,
        imageUrl,
        description: ready.project.description,
        spriteVersionNumber: "2",
      });
      app.log.info({ runId: ready.run.id, status: "install_link_issued" }, "Codex pet install link issued");
      return {
        success: true,
        data: {
          installUrl: `codex://pets/install?${installParams.toString()}`,
          imageUrl,
          expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
        },
      };
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), status: "install_signing_failed" }, "Codex pet install signing is not configured");
      return reply.code(503).send({ error: "Codex 安装地址暂未配置" });
    }
  });

  app.get("/api/workflow/codex-pets/projects/:projectId/download", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const query = deliveryRunQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "运行参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    const ready = await readyProjectAssets(userId, project.id, query.data.runId);
    if (!ready) return reply.code(409).send({ error: "桌宠兼容包尚未生成，暂不能下载" });
    try {
      const bytes = await loadArtifact(ready.packageArtifact.objectKey);
      const filename = packageFilename(ready.project, ready.packageArtifact);
      app.log.info({ runId: ready.run.id, status: "package_downloaded" }, "Codex pet package downloaded");
      return reply
        .header("Content-Disposition", contentDisposition(filename))
        .header("Content-Length", String(bytes.byteLength))
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type("application/zip")
        .send(bytes);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: ready.run.id, status: "package_download_failed" }, "Codex pet package download failed");
      return reply.code(502).send({ error: "桌宠兼容包读取失败" });
    }
  });

  app.get("/api/public/codex-pets/artifacts/:artifactId", async (request, reply) => {
    const params = publicArtifactParamsSchema.safeParse(request.params);
    const query = publicArtifactQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "资源地址不合法" });
    let secret: string;
    try {
      secret = signingSecret(deps);
    } catch {
      return reply.code(503).send({ error: "资源签名服务暂不可用" });
    }
    if (!verifyCodexPetArtifactSignature({
      artifactId: params.data.artifactId,
      expiresAtSeconds: query.data.exp,
      signature: query.data.sig,
      secret,
      nowSeconds: Math.floor(now().getTime() / 1_000),
      purpose: query.data.purpose === "preview"
        ? CODEX_PET_PREVIEW_ARTIFACT_PURPOSE
        : CODEX_PET_PUBLIC_ARTIFACT_PURPOSE,
    })) {
      return reply.code(401).send({ error: "资源地址已失效" });
    }
    const artifact = await prisma.codexPetArtifact.findFirst({
      where: { id: params.data.artifactId },
    });
    const shape = artifact as CodexPetArtifactShape | null;
    if (query.data.purpose === "preview") {
      if (!shape
        || shape.status !== "ready"
        || !isSafeRasterImageMime(shape.mime)
        || !hasOwnedArtifactObjectKey(shape)
        || (shape.expiresAt !== null && shape.expiresAt.getTime() <= now().getTime())) {
        return reply.code(404).send({ error: "桌宠预览不存在" });
      }
    } else {
      if (!shape || !assertFinalSpritesheet(shape)) {
        return reply.code(404).send({ error: "桌宠精灵图不存在" });
      }
      const run = await prisma.codexPetRun.findFirst({
        where: {
          id: shape.runId,
          projectId: shape.projectId,
          userId: shape.userId,
          spritesheetArtifactId: shape.id,
        },
      });
      if (!run || !DELIVERABLE_RUN_STATUSES.includes(run.status as (typeof DELIVERABLE_RUN_STATUSES)[number])) {
        return reply.code(404).send({ error: "桌宠精灵图不存在" });
      }
    }
    if (!shape) return reply.code(404).send({ error: "桌宠资源不存在" });
    try {
      const bytes = await loadArtifact(shape.objectKey);
      const maxAge = Math.max(0, Math.min(300, query.data.exp - Math.floor(now().getTime() / 1_000)));
      app.log.info({ runId: shape.runId, status: query.data.purpose === "preview" ? "preview_served" : "install_image_served" }, "Codex pet signed artifact served");
      return reply
        .header("Content-Length", String(bytes.byteLength))
        .header("Cache-Control", `private, max-age=${maxAge}`)
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .type(shape.mime)
        .send(bytes);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: shape.runId, status: "signed_artifact_read_failed" }, "Codex pet signed artifact read failed");
      return reply.code(502).send({ error: "桌宠资源读取失败" });
    }
  });
}
