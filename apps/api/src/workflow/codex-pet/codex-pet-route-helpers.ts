import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getRedis } from "@ai-assistant/db";
import {
  GPT_IMAGE_MODEL,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  isVerifiedWorkflowImageObjectKeyForUser,
} from "../_shared/image-service.js";
import { isCodexPetArtifactObjectKeyFor } from "./codex-pet-storage.js";
import {
  CODEX_PET_ACTION_PROMPT_KEYS,
  CODEX_PET_ACTION_PROMPT_MAX_LENGTH,
  CODEX_PET_ACTION_PROMPTS_MAX_TOTAL_LENGTH,
  CODEX_PET_STYLES,
} from "./codex-pet-prompts.js";
import { sanitizeCodexPetDiagnosticText, sanitizeCodexPetEventPayload } from "./codex-pet-events.js";
import { CODEX_PET_VISUAL_QA_MODEL } from "./codex-pet-model-contract.js";
import { readCodexPetGateFailureSnapshot } from "./codex-pet-gate-failure.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import { loadSharp } from "../../runtime/resource-limits.js";
import type {
  CodexPetArtifactShape,
  CodexPetRouteDeps,
  EventShape,
  ProjectShape,
  ResourcePrice,
  RunShape,
} from "./codex-pet-route-types.js";

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
export const SAFE_RASTER_IMAGE_MIMES = new Set([
  "image/png",
  "image/webp",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/avif",
]);

export const DEFAULT_PRICE = {
  resourceKey: CODEX_PET_RESOURCE_KEY,
  displayName: "Codex v2 桌宠生图调用",
  pricingType: "PER_UNIT" as const,
  rate: 200,
  perUnits: 1,
  enabled: true,
};

export const ACTIVE_RUN_STATUSES = [
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
export const BLOCKING_RUN_STATUSES = [...ACTIVE_RUN_STATUSES, "awaiting_regeneration_approval"] as const;

export const TERMINAL_RUN_STATUSES = ["ready", "failed", "cancelled", CODEX_PET_LEGACY_READ_ONLY_STATUS] as const;
// Final artifacts are independently verified when the package job commits.
// Knowledge archival is useful discovery metadata, not a prerequisite for a
// user to receive an already valid pet.
export const DELIVERABLE_RUN_STATUSES = ["archiving", "ready", "failed"] as const;
export const EDITABLE_PROJECT_STATUSES = ["draft", "awaiting_base_review"] as const;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const idSchema = z.string().trim().min(1).max(128).regex(ID_PATTERN);
export const idempotencyKeySchema = z.string().trim().min(8).max(128).regex(ID_PATTERN);
export const projectParamsSchema = z.object({ projectId: idSchema });
export const runParamsSchema = z.object({ projectId: idSchema, runId: idSchema });
export const publicArtifactParamsSchema = z.object({ artifactId: idSchema });
export const publicArtifactQuerySchema = z.object({
  exp: z.coerce.number().int().positive(),
  sig: z.string().trim().min(32).max(128),
  purpose: z.enum(["install", "preview"]).default("install"),
});
export const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
});
export const deliveryRunQuerySchema = z.object({
  runId: idSchema.optional(),
});

export const actionPromptsSchema = z.object(Object.fromEntries(
  CODEX_PET_ACTION_PROMPT_KEYS.map((key) => [key, z.string().trim().max(CODEX_PET_ACTION_PROMPT_MAX_LENGTH).optional()]),
) as Record<(typeof CODEX_PET_ACTION_PROMPT_KEYS)[number], z.ZodOptional<z.ZodString>>).strict().transform((value) => Object.fromEntries(
  Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
)).refine(
  (value) => Object.values(value).reduce((total, prompt) => total + prompt.length, 0) <= CODEX_PET_ACTION_PROMPTS_MAX_TOTAL_LENGTH,
  { message: `动作提示词总长度不能超过 ${CODEX_PET_ACTION_PROMPTS_MAX_TOTAL_LENGTH} 个字符` },
);

export const projectFieldsSchema = z.object({
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

export const createProjectSchema = projectFieldsSchema.extend({
  idempotencyKey: idempotencyKeySchema.optional(),
}).superRefine((value, context) => {
  if (new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["referenceAssetIds"], message: "参考图不能重复" });
  }
});

export const updateProjectSchema = projectFieldsSchema.partial().superRefine((value, context) => {
  if (value.referenceAssetIds && new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["referenceAssetIds"], message: "参考图不能重复" });
  }
});

export const startRunSchema = z.object({ idempotencyKey: idempotencyKeySchema.optional() }).default({});
export const failedContinuationSchema = z.object({ idempotencyKey: idempotencyKeySchema.optional() }).default({});
export const gateFailureResumeSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).default({});
export const baseSelectionSchema = z.union([
  z.object({ artifactId: idSchema }).strict(),
  z.object({ autoSelect: z.literal(true) }).strict(),
  z.object({ regenerate: z.literal(true) }).strict(),
]);
export const extraImageApprovalSchema = z.object({ idempotencyKey: idempotencyKeySchema.optional() }).default({});

export class ActiveCodexPetRunError extends Error {
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

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function safeDiagnostic(error: unknown): string {
  return sanitizeCodexPetDiagnosticText(
    error instanceof Error ? error.message : String(error),
    1_000,
  );
}

export function safeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function serializeProject(project: ProjectShape) {
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

export function serializeProjectSummary(project: ProjectShape) {
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

export function recoverySourceRunId(
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

export function serializeRun(run: RunShape, ownedRunIds: ReadonlySet<string> | null = null) {
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

export function serializeJob(job: {
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

export function serializeEvent(event: EventShape) {
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

export function safeSseEventName(value: string): string {
  return /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : "message";
}

export async function serializeArtifact(
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

export function isSafeRasterImageMime(mime: string): boolean {
  return SAFE_RASTER_IMAGE_MIMES.has(mime.split(";", 1)[0]!.trim().toLowerCase());
}

export function defaultArtifactPreviewUrl(artifact: CodexPetArtifactShape, deps: CodexPetRouteDeps): string | null {
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

export function isActiveRunStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return recordOf(error).code === "P2002";
}

export function resolveIdempotencyKey(
  header: string | string[] | undefined,
  body: string | undefined,
): { readonly success: true; readonly value: string } | { readonly success: false } {
  const headerValue = Array.isArray(header) ? header[0] : header;
  const normalizedHeader = headerValue?.trim() || undefined;
  if (normalizedHeader && body && normalizedHeader !== body) return { success: false };
  const parsed = idempotencyKeySchema.safeParse(body ?? normalizedHeader);
  return parsed.success ? { success: true, value: parsed.data } : { success: false };
}

export function resolvePricing(rows: readonly ResourcePrice[]): ResourcePrice {
  const configured = rows.find((row) => row.resourceKey === CODEX_PET_RESOURCE_KEY);
  return configured
    ? { ...DEFAULT_PRICE, ...configured, resourceKey: CODEX_PET_RESOURCE_KEY }
    : DEFAULT_PRICE;
}

export function isCodexPetPerImagePrice(pricing: ResourcePrice): boolean {
  return pricing.pricingType === "PER_UNIT"
    && pricing.perUnits === 1
    && Number.isFinite(pricing.rate)
    && pricing.rate > 0;
}

export function signingSecret(deps: CodexPetRouteDeps): string {
  const value = deps.signingSecret
    ?? process.env.CODEX_PET_ARTIFACT_SIGNING_SECRET
    ?? process.env.SESSION_SECRET;
  if (!value || Buffer.byteLength(value) < 32) {
    throw new Error("CODEX_PET_ARTIFACT_SIGNING_SECRET or SESSION_SECRET must be at least 32 bytes");
  }
  return value;
}

export function publicBaseUrl(deps: CodexPetRouteDeps): string {
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

export function packageFilename(project: ProjectShape, artifact: CodexPetArtifactShape): string {
  const metadata = recordOf(artifact.metadata);
  const source = typeof metadata.petId === "string" ? metadata.petId : project.name;
  const safe = source.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return `${safe || "codex-pet"}.zip`;
}

export function contentDisposition(filename: string): string {
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

export function eventCursor(request: FastifyRequest, after: number): number {
  const raw = request.headers["last-event-id"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(header ?? 0);
  return Math.max(after, Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0);
}

export function formatCodexPetSseEvent(event: EventShape): string {
  return `id: ${event.sequence}\nevent: ${safeSseEventName(event.type)}\ndata: ${JSON.stringify(serializeEvent(event))}\n\n`;
}

export async function defaultWaitForSseDisconnect(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  await new Promise<void>((resolve) => {
    const onClose = () => resolve();
    reply.raw.once("close", onClose);
    reply.raw.once("error", onClose);
  });
}

export function assertFinalSpritesheet(artifact: CodexPetArtifactShape): boolean {
  return artifact.status === "ready"
    && artifact.kind === "spritesheet"
    && artifact.sizeBytes > 0
    && artifact.width === 1_536
    && artifact.height === 2_288
    && (artifact.mime === "image/webp" || artifact.mime === "image/png")
    && hasOwnedArtifactObjectKey(artifact)
    && artifact.expiresAt === null;
}

export function assertPackageArtifact(artifact: CodexPetArtifactShape): boolean {
  return artifact.status === "ready"
    && artifact.kind === "package"
    && artifact.sizeBytes > 0
    && (artifact.mime === "application/zip" || artifact.mime === "application/x-zip-compressed")
    && hasOwnedArtifactObjectKey(artifact)
    && artifact.expiresAt === null;
}

export function hasOwnedArtifactObjectKey(artifact: CodexPetArtifactShape): boolean {
  return isCodexPetArtifactObjectKeyFor({
    objectKey: artifact.objectKey,
    userId: artifact.userId,
    projectId: artifact.projectId,
    runId: artifact.runId,
  });
}

export async function notifyEvent(app: FastifyInstance, deps: CodexPetRouteDeps, runId: string): Promise<void> {
  try {
    if (deps.notifyRunEvent) await deps.notifyRunEvent(runId);
    else await getRedis().publish(codexPetRunEventChannel(runId), "route-event");
  } catch (error) {
    app.log.warn({ error: safeDiagnostic(error), runId }, "Codex pet Redis event notification failed; SSE database polling will recover");
  }
}

export async function defaultSubscribeRunEvents(runId: string, onMessage: () => void): Promise<() => Promise<void>> {
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
