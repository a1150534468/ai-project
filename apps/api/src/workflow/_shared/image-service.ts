import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { loadS3Config, makeS3, putObject, type S3Config } from "../../storage/s3.js";
import { loadSharp } from "../../runtime/resource-limits.js";
import { isObjectLike } from "../../runtime/records.js";
import { trimTrailingSlash } from "../../runtime/url.js";
import { publicObjectUrl as basePublicObjectUrl } from "../../storage/public-url.js";
import { imageResolutionFromSize } from "./image-upstream-options.js";
import { IMAGE_STREAM_PARTIAL_IMAGES, readImageStream } from "./image-stream.js";
import { withImageStreamDispatcher } from "./image-stream-dispatcher.js";
import { withImageDispatchPermit } from "./image-dispatch-gate.js";

export const QWEN_IMAGE_MODEL = "qwen-image-2.0-pro-2026-04-22";
export const GPT_IMAGE_MODEL = "gpt-image-2";
export const DOUBAO_IMAGE_MODEL = "doubao-seedream-4-5-251128";
export const IMAGE_GENERATION_MODELS = [QWEN_IMAGE_MODEL, GPT_IMAGE_MODEL, DOUBAO_IMAGE_MODEL] as const;
/** Qwen Image 编辑接口与现有生图工作台共同遵守的参考图上限。 */
export const IMAGE_MAX_REFERENCE_COUNT = 3;
export const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_REFERENCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
]);
const DEFAULT_IMAGE_MODEL = QWEN_IMAGE_MODEL;
const DEFAULT_GPT_IMAGE_GENERATION_ENDPOINT = "https://api.ai-pixel.online/v1/images/generations";
const DEFAULT_DOUBAO_IMAGE_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const DEFAULT_BAILIAN_REGION = "cn-beijing";
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
const DEFAULT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const BAILIAN_IMAGE_GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const DEFAULT_QWEN_IMAGE_ENDPOINT = `https://dashscope.aliyuncs.com${BAILIAN_IMAGE_GENERATION_PATH}`;
const QWEN_IMAGE_MIN_PIXELS = 512 * 512;
const QWEN_IMAGE_MAX_PIXELS = 2048 * 2048;
const GPT_IMAGE_MIN_PIXELS = 655_360;
const GPT_IMAGE_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_MAX_EDGE = 3_840;
const GPT_IMAGE_MAX_ASPECT_RATIO = 3;
const SEEDREAM_MIN_PIXELS = 3_686_400;
const SEEDREAM_MAX_PIXELS = 16_777_216;
const SEEDREAM_MAX_ASPECT_RATIO = 3;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageGenerationConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly protocol: "bailian" | "openai" | "volcengine";
}

export type ImageGenerationModel = typeof IMAGE_GENERATION_MODELS[number];

export type GeneratedImage = { readonly kind: "url"; readonly url: string } | { readonly kind: "b64"; readonly b64: string; readonly mime: string };

export interface ImageGenerationUsage {
  readonly inputTokens: number;
  readonly imageInputTokens: number;
  readonly textInputTokens: number;
  readonly outputTokens: number;
  readonly imageOutputTokens: number;
  readonly totalTokens: number;
}

export interface ImageGenerationResult {
  readonly image: GeneratedImage;
  /** Safe, bounded correlation ID from an allowlisted upstream response header. */
  readonly upstreamRequestId: string | null;
  readonly requestedModel: string;
  readonly actualModel: string;
  readonly requestedSize: string;
  readonly actualSize: string;
  readonly requestedQuality: string;
  readonly actualQuality: string;
  readonly usage: ImageGenerationUsage | null;
}

export type ImageGenerationErrorCategory =
  | "rate_limit"
  | "timeout"
  | "upstream"
  | "moderation"
  | "invalid_request"
  | "authentication"
  | "cancelled"
  | "network"
  | "unknown";

export interface ImageGenerationErrorClassification {
  readonly category: ImageGenerationErrorCategory;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly code: string | null;
  readonly type: string | null;
  readonly upstreamRequestId: string | null;
  /** Bounded allowlisted network/TLS code; never contains an endpoint or message. */
  readonly transportCode: string | null;
}

export class ImageGenerationUpstreamError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly type: string | null;
  readonly category: ImageGenerationErrorCategory;
  readonly retryable: boolean;
  readonly upstreamRequestId: string | null;

  constructor(
    status: number,
    message: string,
    code: string | null = null,
    type: string | null = null,
    upstreamRequestId: string | null = null,
  ) {
    super(message);
    this.name = "ImageGenerationUpstreamError";
    this.status = status;
    this.code = code;
    this.type = type;
    this.upstreamRequestId = sanitizeImageUpstreamRequestId(upstreamRequestId);
    const classification = classifyUpstreamFailure(status, code, type, message);
    this.category = classification.category;
    this.retryable = classification.retryable;
  }
}

export class ImageGenerationTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly category = "timeout" as const;
  readonly retryable = true;

  constructor(timeoutMs: number) {
    super(`image request timed out after ${timeoutMs}ms`);
    this.name = "ImageGenerationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface StoredImage {
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly mime: string;
  readonly objectKey: string | null;
  /** 实际交付像素；上游只给 url 且没配对象存储时拿不到，为 null。 */
  readonly width?: number | null;
  readonly height?: number | null;
}

export interface RetryOptions {
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void>;
  readonly shouldStop?: (error: unknown) => boolean;
}

export interface ImageBinaryInput {
  readonly b64: string;
  readonly mime?: string;
  readonly filename?: string;
}

export interface CallImageGenerationArgs {
  readonly config: ImageGenerationConfig;
  readonly prompt: string;
  readonly size: string;
  readonly fetchFn: FetchLike;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly quality?: "low" | "medium" | "high" | "auto";
  readonly outputFormat?: "png" | "jpeg" | "webp";
  /** Invoked before fetch to reserve an idempotent provider-dispatch slot. */
  readonly onRequestDispatching?: () => Promise<void> | void;
  /** Invoked immediately after fetch has been called for the provider POST. */
  readonly onRequestSent?: () => Promise<void> | void;
}

export interface CallImageEditArgs {
  readonly config: ImageGenerationConfig;
  readonly prompt: string;
  readonly referenceImages: readonly ImageBinaryInput[];
  readonly fetchFn: FetchLike;
  readonly size?: string;
  readonly mask?: ImageBinaryInput;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly endpoint?: string;
  readonly quality?: "low" | "medium" | "high" | "auto";
  readonly outputFormat?: "png" | "jpeg" | "webp";
  /** Invoked before fetch to reserve an idempotent provider-dispatch slot. */
  readonly onRequestDispatching?: () => Promise<void> | void;
  /** Invoked immediately after fetch has been called for the provider POST. */
  readonly onRequestSent?: () => Promise<void> | void;
}

export interface StoreWorkflowImageArgs {
  readonly image: GeneratedImage;
  readonly userId: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly fetchFn: FetchLike;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly namespace?: string;
  readonly acl?: "public-read" | "private";
}

/** Validate a persisted workflow-image key before a worker or route reads S3. */
export function isVerifiedWorkflowImageObjectKey(value: string): boolean {
  const key = value.trim();
  if (key !== value || !key.startsWith("workflow/") || key.includes("\\")) return false;
  if ([...key].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return false;
  const segments = key.split("/");
  return segments.length >= 4
    && !key.endsWith("/")
    && !segments.some((segment) => !segment || segment === "." || segment === "..");
}

export function isVerifiedWorkflowImageObjectKeyForUser(value: string, userId: string): boolean {
  if (!isVerifiedWorkflowImageObjectKey(value) || !userId.trim()) return false;
  const segments = value.split("/");
  return segments[0] === "workflow"
    && (segments[1] === "images" || segments[1] === "codex-pets")
    && segments[2] === userId;
}

function endpointFromBase(baseURL: string): string {
  const base = trimTrailingSlash(baseURL);
  if (base.endsWith(BAILIAN_IMAGE_GENERATION_PATH)) return base;
  if (base.endsWith("/api/v1")) return `${base}${BAILIAN_IMAGE_GENERATION_PATH.slice("/api/v1".length)}`;
  return `${base}${BAILIAN_IMAGE_GENERATION_PATH}`;
}

function baseURLFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.IMAGE_BASE_URL ?? "").trim();
}

function workspaceImageEndpoint(env: NodeJS.ProcessEnv): string | null {
  const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim();
  if (!workspaceId) return null;
  const region = env.BAILIAN_REGION?.trim() || DEFAULT_BAILIAN_REGION;
  return `https://${workspaceId}.${region}.maas.aliyuncs.com${BAILIAN_IMAGE_GENERATION_PATH}`;
}

function generationEndpointFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.IMAGE_GENERATION_ENDPOINT?.trim();
  if (explicit) return explicit;
  const baseURL = baseURLFromEnv(env);
  if (baseURL) return endpointFromBase(baseURL);
  const workspaceEndpoint = workspaceImageEndpoint(env);
  if (workspaceEndpoint) return workspaceEndpoint;
  throw new Error("BAILIAN_WORKSPACE_ID or IMAGE_GENERATION_ENDPOINT/IMAGE_BASE_URL required for image generation");
}

function qwenImageEndpointFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.IMAGE_GENERATION_ENDPOINT?.trim();
  if (explicit) return explicit;
  const baseURL = baseURLFromEnv(env);
  if (baseURL) return endpointFromBase(baseURL);
  return DEFAULT_QWEN_IMAGE_ENDPOINT;
}

function usesRequestBoundNativeQwenModel(config: ImageGenerationConfig): boolean {
  if (config.protocol !== "bailian" || config.model !== QWEN_IMAGE_MODEL) return false;
  try {
    const hostname = new URL(config.endpoint).hostname.toLowerCase();
    return hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".maas.aliyuncs.com");
  } catch {
    return false;
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function seedreamSize(size: string): string {
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    const pixels = width * height;
    const aspectRatio = Math.max(width / height, height / width);
    if (pixels >= SEEDREAM_MIN_PIXELS
      && pixels <= SEEDREAM_MAX_PIXELS
      && aspectRatio <= SEEDREAM_MAX_ASPECT_RATIO) return `${width}x${height}`;
  }
  // Seedream 4.5 rejects the 1K tier. Use its provider-side 2K preset for
  // smaller workflow canvases while preserving already-valid pixel sizes.
  return imageResolutionFromSize(size) === "4K" ? "4K" : "2K";
}

const IMAGE_UPSTREAM_REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-openai-request-id",
  "x-dashscope-request-id",
  "request-id",
  "x-amzn-requestid",
  "x-amz-request-id",
  "x-goog-request-id",
  "cf-ray",
  "traceparent",
] as const;

const IMAGE_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_RESPONSE_STATUS_CODE",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Keep only low-cardinality transport diagnostics that cannot expose URLs or credentials. */
export function imageTransportCode(error: unknown): string | null {
  if (!isObjectLike(error) || !isObjectLike(error.cause)) return null;
  const code = stringField(error.cause, "code");
  return IMAGE_TRANSPORT_CODES.has(code) ? code : null;
}

/**
 * Request IDs are safe observability metadata, not arbitrary response text.
 * Reject whitespace, control characters and unbounded values so an upstream
 * cannot turn a correlation header into a log-injection or secret channel.
 */
export function sanitizeImageUpstreamRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (/^(?:sk-|bearer(?:[._:/+=-]|$)|api[_-]?key)/i.test(normalized)) return null;
  return normalized.length >= 1
    && normalized.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:/+=-]*$/.test(normalized)
    ? normalized
    : null;
}

export function imageUpstreamRequestIdFromHeaders(headers: Headers): string | null {
  for (const header of IMAGE_UPSTREAM_REQUEST_ID_HEADERS) {
    const requestId = sanitizeImageUpstreamRequestId(headers.get(header));
    if (requestId) return requestId;
  }
  return null;
}

function classifyUpstreamFailure(
  status: number,
  code: string | null,
  type: string | null,
  message: string,
): Pick<ImageGenerationErrorClassification, "category" | "retryable"> {
  const signal = `${code ?? ""} ${type ?? ""} ${message}`.toLowerCase();
  if (
    signal.includes("moderation")
    || signal.includes("content_policy")
    || signal.includes("safety")
    || signal.includes("blocked_prompt")
  ) {
    return { category: "moderation", retryable: false };
  }
  if (status === 401 || status === 403) return { category: "authentication", retryable: false };
  if (status === 408) return { category: "timeout", retryable: true };
  if (status === 429) return { category: "rate_limit", retryable: true };
  if (status >= 500) return { category: "upstream", retryable: true };
  if (status >= 400) return { category: "invalid_request", retryable: false };
  return { category: "unknown", retryable: false };
}

function errorName(error: unknown): string {
  return isObjectLike(error) && typeof error.name === "string" ? error.name : "";
}

export function classifyImageGenerationError(error: unknown): ImageGenerationErrorClassification {
  if (error instanceof ImageGenerationUpstreamError) {
    return {
      category: error.category,
      retryable: error.retryable,
      status: error.status,
      code: error.code,
      type: error.type,
      upstreamRequestId: error.upstreamRequestId,
      transportCode: null,
    };
  }
  if (error instanceof ImageGenerationTimeoutError) {
    return { category: "timeout", retryable: true, status: null, code: null, type: null, upstreamRequestId: null, transportCode: null };
  }
  if (errorName(error) === "AbortError") {
    return { category: "cancelled", retryable: false, status: null, code: null, type: null, upstreamRequestId: null, transportCode: null };
  }
  if (error instanceof TypeError) {
    return { category: "network", retryable: true, status: null, code: null, type: null, upstreamRequestId: null, transportCode: imageTransportCode(error) };
  }
  // Storage and malformed-success-response errors can be transient. Preserve the
  // existing retry behavior unless the image client can classify the failure.
  return { category: "unknown", retryable: true, status: null, code: null, type: null, upstreamRequestId: null, transportCode: null };
}

export function isRetryableImageGenerationError(error: unknown): boolean {
  return classifyImageGenerationError(error).retryable;
}

function usageFromPayload(payload: unknown): ImageGenerationUsage | null {
  if (!isObjectLike(payload) || !isObjectLike(payload.usage)) return null;
  const usage = payload.usage;
  const inputDetails = isObjectLike(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isObjectLike(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return {
    inputTokens: numberField(usage, "input_tokens"),
    imageInputTokens: numberField(inputDetails, "image_tokens"),
    textInputTokens: numberField(inputDetails, "text_tokens"),
    outputTokens: numberField(usage, "output_tokens"),
    imageOutputTokens: numberField(outputDetails, "image_tokens"),
    totalTokens: numberField(usage, "total_tokens"),
  };
}

async function decodedImageSize(image: GeneratedImage): Promise<string | null> {
  if (image.kind !== "b64") return null;
  try {
    const sharp = await loadSharp();
    const metadata = await sharp(Buffer.from(image.b64, "base64"), { limitInputPixels: GPT_IMAGE_MAX_PIXELS }).metadata();
    return metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null;
  } catch {
    // Some compatible relays return a declared size alongside an opaque or
    // temporarily malformed payload. The caller still gets that safe fallback.
    return null;
  }
}

async function detailedResult(
  payload: unknown,
  request: { readonly model: string; readonly size?: string; readonly quality?: string },
  upstreamRequestId: string | null,
  requestBoundModel = false,
): Promise<ImageGenerationResult> {
  const record = isObjectLike(payload) ? payload : {};
  const image = extractGeneratedImage(payload);
  const decodedSize = await decodedImageSize(image);
  return {
    image,
    upstreamRequestId,
    requestedModel: request.model,
    // Native providers bind the exact model in the authenticated request body
    // but may omit it from successful responses. Compatible relays do not get
    // this fallback because they can silently route to another deployment.
    actualModel: stringField(record, "model") || (requestBoundModel ? request.model : ""),
    requestedSize: request.size || "auto",
    actualSize: decodedSize || stringField(record, "size") || request.size || "auto",
    requestedQuality: request.quality || "auto",
    actualQuality: stringField(record, "quality") || request.quality || "auto",
    usage: usageFromPayload(payload),
  };
}

async function upstreamError(response: Response): Promise<ImageGenerationUpstreamError> {
  const text = await response.text().catch(() => "");
  let code: string | null = null;
  let type: string | null = null;
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isObjectLike(parsed) && isObjectLike(parsed.error)) {
      code = stringField(parsed.error, "code") || null;
      type = stringField(parsed.error, "type") || null;
      detail = stringField(parsed.error, "message").slice(0, 300) || detail;
    }
  } catch {
    // Keep the safe truncated text response.
  }
  return new ImageGenerationUpstreamError(
    response.status,
    `image relay ${response.status}${detail ? ` ${detail}` : ""}`,
    code,
    type,
    imageUpstreamRequestIdFromHeaders(response.headers),
  );
}

async function fetchWithSignal(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  onRequestSent?: () => Promise<void> | void,
): Promise<Response> {
  if (signal.aborted) throw new DOMException("This operation was aborted", "AbortError");
  // Calling fetch is the only durable boundary we can observe locally. A
  // later socket failure is still an attempted provider request.
  const response = fetchFn(url, withImageStreamDispatcher(url, { ...init, signal }));
  try {
    await onRequestSent?.();
  } catch (error) {
    // The request may already be in flight. Keep its rejection observed if
    // persisting the sent transition itself fails.
    void response.catch(() => undefined);
    throw error;
  }
  return await response;
}

/**
 * 单次尝试的截止时间，覆盖**整段** work——包括响应体的读取。
 *
 * 早先的实现只守到 Response 就绪就 clearTimeout，而 undici 的 headers/bodyTimeout
 * 已被 image-stream-dispatcher 置 0，于是流式读取阶段完全没有上限：实测出现过
 * 单张图卡到 226s 才因中继断连报 `terminated`，远超 IMAGE_ATTEMPT_TIMEOUT_MS=180s。
 * 图文工作流按批出图，一批卡住就会把整行拖过 reaper 的 15 分钟阈值被误判为超时中断。
 *
 * 因此把 deadline 上提到「拿响应 + 读完 body」这一整段，让 IMAGE_ATTEMPT_TIMEOUT_MS
 * 真正成为单次尝试的唯一上限。超时统一抛 ImageGenerationTimeoutError（可重试），
 * 调用方主动取消（外部 signal）仍照原样抛 AbortError。
 */
async function withImageAttemptDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  work: (deadlineSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  let fire: (() => void) | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    fire?.();
  }, timeoutMs);
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  // 抢跑而不是只等 work 自己失败：abort 只是「请求上游停下」，
  // 卡死的连接不保证及时把 abort 变成 reject。截止时间到了就必须交还控制权，
  // 否则这一层的上限又变成一句空话。
  const expired = new Promise<never>((_, reject) => {
    fire = () => reject(new ImageGenerationTimeoutError(timeoutMs));
  });
  try {
    return await Promise.race([
      work(controller.signal).catch((error) => {
        if (timedOut && !signal?.aborted) throw new ImageGenerationTimeoutError(timeoutMs);
        throw error;
      }),
      expired,
    ]);
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    fire = null;
  }
}

async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
  onRequestSent?: () => Promise<void> | void,
): Promise<Response> {
  return await withImageAttemptDeadline(timeoutMs, signal, async (deadlineSignal) => (
    await fetchWithSignal(fetchFn, url, init, deadlineSignal, onRequestSent)
  ));
}

function validatedImageInput(image: ImageBinaryInput, label: string): { readonly bytes: Buffer; readonly mime: string } {
  const mime = image.mime?.trim().startsWith("image/") ? image.mime.trim() : "image/png";
  const bytes = Buffer.from(image.b64, "base64");
  if (bytes.byteLength <= 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) {
    throw new Error(`${label} must be between 1 byte and ${IMAGE_REFERENCE_MAX_BYTES} bytes`);
  }
  return { bytes, mime };
}

const OPENAI_EDIT_NATIVE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

async function openAiEditImagePart(
  image: ImageBinaryInput,
  label: string,
  fallbackFilename: string,
): Promise<{ readonly bytes: Buffer; readonly mime: string; readonly filename: string }> {
  const validated = validatedImageInput(image, label);
  const normalizedMime = validated.mime.toLowerCase().split(";", 1)[0]!;
  if (OPENAI_EDIT_NATIVE_MIME_TYPES.has(normalizedMime)) {
    return { bytes: validated.bytes, mime: normalizedMime === "image/jpg" ? "image/jpeg" : normalizedMime, filename: image.filename || fallbackFilename };
  }
  try {
    const sharp = await loadSharp();
    // GPT Image edits accepts PNG/JPEG/WebP. Normalize legacy BMP/TIFF/GIF or
    // other uploaded raster formats in the shared provider adapter so both the
    // ordinary image studio and Codex-pet workflow behave identically. GIFs
    // intentionally use their first frame as a stable visual reference.
    const bytes = await sharp(validated.bytes, { limitInputPixels: 40_000_000, animated: false })
      .rotate()
      .resize({ width: 2_048, height: 2_048, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (bytes.byteLength <= 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) {
      throw new Error("normalized image exceeds the 10MB provider limit");
    }
    const base = (image.filename || fallbackFilename).replace(/\.[A-Za-z0-9]+$/, "");
    return { bytes, mime: "image/png", filename: `${base || "reference"}.png` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be normalized for GPT Image edits: ${detail}`);
  }
}

function dataUrlForImageInput(image: ImageBinaryInput): string {
  const { bytes, mime } = validatedImageInput(image, "Qwen image input");
  // Re-encode decoded bytes so malformed or whitespace-heavy base64 never gets
  // forwarded verbatim to the provider.
  const b64 = bytes.toString("base64");
  return `data:${mime};base64,${b64}`;
}

function qwenImageSize(size: string | undefined): string | undefined {
  const normalized = size?.trim();
  if (!normalized || normalized === "auto") return undefined;
  const match = /^(\d+)[x*](\d+)$/i.exec(normalized);
  if (!match) throw new Error(`Qwen image size must use widthxheight format: ${normalized}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels < QWEN_IMAGE_MIN_PIXELS || pixels > QWEN_IMAGE_MAX_PIXELS) {
    throw new Error(`Qwen image size must contain between 512*512 and 2048*2048 total pixels: ${normalized}`);
  }
  return `${width}*${height}`;
}

function qwenImageParameters(size: string | undefined): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    n: 1,
    prompt_extend: true,
    watermark: false,
  };
  const qwenSize = qwenImageSize(size);
  if (qwenSize) parameters.size = qwenSize;
  return parameters;
}

function gptImageSize(size: string | undefined): string | undefined {
  const normalized = size?.trim();
  if (!normalized || normalized === "auto") return normalized || undefined;
  const match = /^(\d+)[x*](\d+)$/i.exec(normalized);
  if (!match) throw new Error(`GPT image size must use widthxheight format: ${normalized}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  if (
    !Number.isSafeInteger(pixels)
    || width % 16 !== 0
    || height % 16 !== 0
    || longEdge > GPT_IMAGE_MAX_EDGE
    || longEdge / shortEdge > GPT_IMAGE_MAX_ASPECT_RATIO
    || pixels < GPT_IMAGE_MIN_PIXELS
    || pixels > GPT_IMAGE_MAX_PIXELS
  ) {
    throw new Error(`GPT image size is outside gpt-image-2 resolution constraints: ${normalized}`);
  }
  return `${width}x${height}`;
}

function publicBaseFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.IMAGE_S3_PUBLIC_BASE_URL ?? env.S3_PUBLIC_BASE_URL ?? "").trim();
}

function publicObjectUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv): string {
  const imageBase = (env.IMAGE_S3_PUBLIC_BASE_URL ?? "").trim();
  return basePublicObjectUrl(cfg, key, imageBase ? { ...env, S3_PUBLIC_BASE_URL: imageBase } : env);
}

function dataUrlForBinary(binary: { readonly buffer: Buffer; readonly mime: string }): string {
  return `data:${binary.mime};base64,${binary.buffer.toString("base64")}`;
}

function shouldInlineStoredImageForLocalEndpoint(cfg: S3Config, env: NodeJS.ProcessEnv): boolean {
  if (publicBaseFromEnv(env)) return false;
  try {
    const endpoint = new URL(cfg.endpoint);
    return ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  } catch {
    return false;
  }
}

function tryLoadS3(env: NodeJS.ProcessEnv): { readonly cfg: S3Config; readonly s3: ReturnType<typeof makeS3> } | null {
  try {
    const cfg = loadS3Config(env);
    return { cfg, s3: makeS3(cfg) };
  } catch {
    return null;
  }
}

async function fetchRemoteImage(
  url: string,
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ readonly buffer: Buffer; readonly mime: string }> {
  // 下载同样把 body 读取纳入 deadline：卡在下行的连接不该无上限地占着批次。
  return await withImageAttemptDeadline(60_000, signal, async (deadlineSignal) => {
    const response = await fetchWithSignal(fetchFn, url, { method: "GET" }, deadlineSignal);
    if (!response.ok) throw new Error(`image download ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const maxBytes = Number(env.IMAGE_MAX_BYTES) || DEFAULT_IMAGE_MAX_BYTES;
    if (buffer.byteLength > maxBytes) throw new Error("image too large");
    const contentType = response.headers.get("content-type") ?? "image/png";
    return { buffer, mime: contentType.startsWith("image/") ? contentType : "image/png" };
  });
}

export function loadImageGenerationConfig(env: NodeJS.ProcessEnv = process.env): ImageGenerationConfig {
  const model = (env.IMAGE_GENERATION_MODEL ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  return loadImageGenerationConfigForModel(model, env);
}

export function loadImageGenerationConfigForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ImageGenerationConfig {
  if (model === DOUBAO_IMAGE_MODEL || model.toLowerCase().startsWith("doubao")) {
    const apiKey = env.ARK_API_KEY?.trim() || "";
    if (!apiKey) throw new Error("ARK_API_KEY required for doubao image generation");
    return {
      endpoint: env.ARK_IMAGE_ENDPOINT?.trim() || DEFAULT_DOUBAO_IMAGE_ENDPOINT,
      apiKey,
      model,
      protocol: "volcengine",
    };
  }
  if (model === GPT_IMAGE_MODEL) {
    const apiKey = env.GPT_IMAGE_API_KEY?.trim() || "";
    if (!apiKey) throw new Error("GPT_IMAGE_API_KEY required for gpt-image-2");
    return {
      endpoint: env.GPT_IMAGE_GENERATION_ENDPOINT?.trim() || DEFAULT_GPT_IMAGE_GENERATION_ENDPOINT,
      apiKey,
      model: GPT_IMAGE_MODEL,
      protocol: "openai",
    };
  }
  const apiKey = env.IMAGE_API_KEY?.trim()
    || env.BAILIAN_API_KEY?.trim()
    || env.DASHSCOPE_API_KEY?.trim()
    || "";
  if (!apiKey) throw new Error("IMAGE_API_KEY/BAILIAN_API_KEY/DASHSCOPE_API_KEY required");
  return {
    endpoint: model === QWEN_IMAGE_MODEL
      ? qwenImageEndpointFromEnv(env)
      : generationEndpointFromEnv(env),
    apiKey,
    model,
    protocol: "bailian",
  };
}

export function loadImageEditEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  generationEndpoint?: string,
): string {
  const explicit = env.IMAGE_EDIT_ENDPOINT?.trim();
  if (explicit) return explicit;
  return generationEndpoint?.trim() || qwenImageEndpointFromEnv(env);
}

export function loadGptImageEditEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  generationEndpoint = env.GPT_IMAGE_GENERATION_ENDPOINT?.trim() || DEFAULT_GPT_IMAGE_GENERATION_ENDPOINT,
): string {
  const explicit = env.GPT_IMAGE_EDIT_ENDPOINT?.trim();
  if (explicit) return explicit;
  try {
    const url = new URL(generationEndpoint);
    const pathname = trimTrailingSlash(url.pathname);
    if (pathname.endsWith("/generations")) {
      url.pathname = `${pathname.slice(0, -"/generations".length)}/edits`;
    } else if (!pathname.endsWith("/edits")) {
      url.pathname = `${pathname}/edits`;
    }
    return url.toString();
  } catch {
    const endpoint = trimTrailingSlash(generationEndpoint);
    if (endpoint.endsWith("/edits")) return endpoint;
    return endpoint.endsWith("/generations")
      ? `${endpoint.slice(0, -"/generations".length)}/edits`
      : `${endpoint}/edits`;
  }
}

export function imageStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMAGE_UPSTREAM_STREAM?.trim() !== "0";
}

/**
 * 按实际 content-type 分派：中继若忽略 stream 参数直接回 JSON，这里照旧解析，
 * 因此开启流式不会让「不支持流式的上游」失效。
 */
export async function readImagePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return await response.json();
  return (await readImageStream(response)).payload;
}

export function loadImageAttemptTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

export function extractGeneratedImage(payload: unknown): GeneratedImage {
  if (!isObjectLike(payload)) throw new Error("image response invalid");

  // Keep accepting the former OpenAI-compatible response so custom relays do not
  // break while deployments migrate to the native Bailian endpoint.
  if (Array.isArray(payload.data) && payload.data.length > 0) {
    const first = payload.data[0];
    if (!isObjectLike(first)) throw new Error("image response item invalid");
    if (typeof first.url === "string" && first.url.length > 0) return { kind: "url", url: first.url };
    if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
      const mime = typeof first.mime_type === "string" && first.mime_type.startsWith("image/") ? first.mime_type : "image/png";
      return { kind: "b64", b64: first.b64_json, mime };
    }
  }

  const output = payload.output;
  if (isObjectLike(output) && Array.isArray(output.choices)) {
    for (const choice of output.choices) {
      if (!isObjectLike(choice) || !isObjectLike(choice.message) || !Array.isArray(choice.message.content)) continue;
      for (const content of choice.message.content) {
        if (isObjectLike(content) && typeof content.image === "string" && content.image.length > 0) {
          return { kind: "url", url: content.image };
        }
      }
    }
  }
  throw new Error("image response has no generated image URL");
}

export async function retryUntilSuccess<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return await fn();
    } catch (error) {
      if (options.shouldStop?.(error)) throw error;
      if (options.maxAttempts && attempts >= options.maxAttempts) throw error;
      await options.onRetry?.(error, attempts);
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
    }
  }
}

export async function callImageGenerationDetailed(args: CallImageGenerationArgs): Promise<ImageGenerationResult> {
  const requestedQuality = args.quality ?? "auto";
  const requestedFormat = args.outputFormat ?? "png";
  const streamOpenAi = args.config.protocol === "openai" && imageStreamEnabled(args.env);
  const body = args.config.protocol === "openai"
    ? {
        model: args.config.model,
        prompt: args.prompt,
        n: 1,
        size: gptImageSize(args.size),
        quality: requestedQuality,
        output_format: requestedFormat,
        // 流式保活，绕开中继 60s 读超时；详见 image-stream.ts。
        ...(streamOpenAi ? { stream: true, partial_images: IMAGE_STREAM_PARTIAL_IMAGES } : {}),
      }
    : args.config.protocol === "volcengine"
      ? {
          model: args.config.model,
          prompt: args.prompt,
          n: 1,
          size: seedreamSize(args.size),
          response_format: "url",
          watermark: false,
        }
      : {
          model: args.config.model,
          input: {
            messages: [{ role: "user", content: [{ text: args.prompt }] }],
          },
          parameters: qwenImageParameters(args.size),
        };
  // 闸门在派发登记与 deadline 之外：四个域打同一个中继，谁也不许挤掉谁。
  return await withImageDispatchPermit({ endpoint: args.config.endpoint, signal: args.signal, env: args.env }, async () => {
    await args.onRequestDispatching?.();
    // deadline 包住「取响应 + 读 body」：流式出图的 body 阶段才是耗时主体。
    return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(args.env), args.signal, async (deadlineSignal) => {
      const response = await fetchWithSignal(args.fetchFn, args.config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
        body: JSON.stringify(body),
      }, deadlineSignal, args.onRequestSent);
      if (!response.ok) throw await upstreamError(response);
      const payload = await readImagePayload(response);
      return await detailedResult(
        payload,
        { model: args.config.model, size: args.size, quality: requestedQuality },
        imageUpstreamRequestIdFromHeaders(response.headers),
        usesRequestBoundNativeQwenModel(args.config),
      );
    });
  });
}

export async function callImageGeneration(args: CallImageGenerationArgs): Promise<GeneratedImage> {
  return (await callImageGenerationDetailed(args)).image;
}

export async function callImageEditDetailed(args: CallImageEditArgs): Promise<ImageGenerationResult> {
  if (args.referenceImages.length < 1 || args.referenceImages.length > IMAGE_MAX_REFERENCE_COUNT) {
    throw new Error(`image editing requires 1 to ${IMAGE_MAX_REFERENCE_COUNT} reference images`);
  }
  if (args.config.protocol === "volcengine") {
    if (args.mask) throw new Error("Seedream image editing does not support a separate mask input");
    const requestedSize = seedreamSize(args.size?.trim() || "2048x2048");
    const images = args.referenceImages.map((image) => dataUrlForImageInput(image));
    const body = {
      model: args.config.model,
      prompt: args.prompt,
      image: images.length === 1 ? images[0] : images,
      size: requestedSize,
      response_format: "url",
      sequential_image_generation: "disabled",
      watermark: false,
    };
    const endpoint = args.endpoint ?? args.config.endpoint;
    return await withImageDispatchPermit({ endpoint, signal: args.signal, env: args.env }, async () => {
      await args.onRequestDispatching?.();
      return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(args.env), args.signal, async (deadlineSignal) => {
        const response = await fetchWithSignal(args.fetchFn, endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
          body: JSON.stringify(body),
        }, deadlineSignal, args.onRequestSent);
        if (!response.ok) throw await upstreamError(response);
        const payload = await response.json();
        return await detailedResult(
          payload,
          { model: args.config.model, size: requestedSize, quality: args.quality },
          imageUpstreamRequestIdFromHeaders(response.headers),
        );
      });
    });
  }
  if (args.config.protocol === "openai") {
    const env = args.env ?? process.env;
    const endpoint = args.endpoint ?? loadGptImageEditEndpoint(env, args.config.endpoint);
    const apiKey = env.GPT_IMAGE_EDIT_API_KEY?.trim() || args.config.apiKey;
    const requestedSize = gptImageSize(args.size) || "auto";
    const requestedQuality = args.quality ?? "auto";
    const outputFormat = args.outputFormat ?? "png";
    const form = new FormData();
    form.set("model", args.config.model);
    form.set("prompt", args.prompt);
    form.set("size", requestedSize);
    form.set("quality", requestedQuality);
    form.set("output_format", outputFormat);
    if (imageStreamEnabled(env)) {
      // 流式保活，绕开中继 60s 读超时；详见 image-stream.ts。
      form.set("stream", "true");
      form.set("partial_images", String(IMAGE_STREAM_PARTIAL_IMAGES));
    }
    const referenceParts = await Promise.all(args.referenceImages.map((image, index) => (
      openAiEditImagePart(image, `reference image ${index + 1}`, `reference-${index + 1}.png`)
    )));
    referenceParts.forEach(({ bytes, mime, filename }) => {
      form.append("image[]", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    });
    if (args.mask) {
      const { bytes, mime, filename } = await openAiEditImagePart(args.mask, "mask image", "mask.png");
      form.set("mask", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    }
    return await withImageDispatchPermit({ endpoint, signal: args.signal, env }, async () => {
      await args.onRequestDispatching?.();
      return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(env), args.signal, async (deadlineSignal) => {
        const response = await fetchWithSignal(args.fetchFn, endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
        }, deadlineSignal, args.onRequestSent);
        if (!response.ok) throw await upstreamError(response);
        const payload = await readImagePayload(response);
        return await detailedResult(
          payload,
          { model: args.config.model, size: requestedSize, quality: requestedQuality },
          imageUpstreamRequestIdFromHeaders(response.headers),
        );
      });
    });
  }
  if (args.mask) throw new Error("Qwen image editing does not support a separate mask input");
  const content = args.referenceImages.map((image) => ({ image: dataUrlForImageInput(image) }));
  const body = {
    model: args.config.model,
    input: {
      messages: [{ role: "user", content: [...content, { text: args.prompt }] }],
    },
    parameters: qwenImageParameters(args.size),
  };
  const configuredEditEndpoint = args.env?.IMAGE_EDIT_ENDPOINT?.trim();
  const endpoint = args.endpoint ?? configuredEditEndpoint ?? args.config.endpoint;
  return await withImageDispatchPermit({ endpoint, signal: args.signal, env: args.env }, async () => {
    await args.onRequestDispatching?.();
    return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(args.env), args.signal, async (deadlineSignal) => {
      const response = await fetchWithSignal(args.fetchFn, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
        body: JSON.stringify(body),
      }, deadlineSignal, args.onRequestSent);
      if (!response.ok) throw await upstreamError(response);
      const payload = await response.json();
      return await detailedResult(
        payload,
        { model: args.config.model, size: args.size, quality: args.quality },
        imageUpstreamRequestIdFromHeaders(response.headers),
        usesRequestBoundNativeQwenModel(args.config),
      );
    });
  });
}

export async function callImageEdit(args: CallImageEditArgs): Promise<GeneratedImage> {
  return (await callImageEditDetailed(args)).image;
}

/** 量一下真实宽高，量不出来就当没有——上游返回损坏数据不该拦住入库。 */
async function measureBinary(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const sharp = await loadSharp();
    const metadata = await sharp(buffer, { limitInputPixels: GPT_IMAGE_MAX_PIXELS }).metadata();
    return { width: metadata.width ?? null, height: metadata.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

export async function storeWorkflowImage(args: StoreWorkflowImageArgs): Promise<StoredImage> {
  const env = args.env ?? process.env;
  const loaded = tryLoadS3(env);
  if (args.acl === "private" && !loaded) {
    throw new Error("private workflow image storage requires S3 configuration");
  }
  if (args.image.kind === "url" && !loaded) {
    return { originalUrl: args.image.url, thumbnailUrl: args.image.url, mime: "image/png", objectKey: null };
  }
  const binary = args.image.kind === "b64"
    ? { buffer: Buffer.from(args.image.b64, "base64"), mime: args.image.mime }
    : await fetchRemoteImage(args.image.url, args.fetchFn, env, args.signal);
  const measured = await measureBinary(binary.buffer);
  if (!loaded) {
    const dataUrl = dataUrlForBinary(binary);
    return { originalUrl: dataUrl, thumbnailUrl: dataUrl, mime: binary.mime, objectKey: null, ...measured };
  }
  const extension = binary.mime.includes("webp")
    ? "webp"
    : binary.mime.includes("jpeg") || binary.mime.includes("jpg")
      ? "jpg"
      : "png";
  const namespace = args.namespace?.trim().replace(/^\/+|\/+$/g, "") || "workflow/images";
  if (!/^[A-Za-z0-9._/-]+$/.test(namespace) || namespace.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("workflow image namespace is invalid");
  }
  const key = `${namespace}/${args.userId}/${args.requestId}/${args.requestIndex}-${randomUUID()}.${extension}`;
  await putObject(loaded.s3, key, binary.buffer, binary.mime, args.acl === "private" ? {} : { acl: "public-read" });
  const url = args.acl === "private"
    ? ""
    : shouldInlineStoredImageForLocalEndpoint(loaded.cfg, env)
    ? dataUrlForBinary(binary)
    : publicObjectUrl(loaded.cfg, key, env);
  return { originalUrl: url, thumbnailUrl: url, mime: binary.mime, objectKey: key, ...measured };
}
