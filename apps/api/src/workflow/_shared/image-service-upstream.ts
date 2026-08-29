/**
 * image-service 拆分后的上游交互层：错误类、失败分类、请求 ID 提取、超时/取消包装、
 * 响应体读取与图片抽取。
 *
 * 错误类与分类函数必须留在同一个文件：`ImageGenerationUpstreamError` 的构造函数里就调
 * `sanitizeImageUpstreamRequestId` 与 `classifyUpstreamFailure`，而 `classifyImageGenerationError`
 * 又要 instanceof 这两个类。拆开就是一个即刻成立的循环导入。
 *
 * 依赖方向：constants / types → 本文件 → storage / calls。不许反向 import providers。
 */

import { Buffer } from "node:buffer";
import { loadSharp } from "../../runtime/resource-limits.js";
import { isObjectLike } from "../../runtime/records.js";
import { readImageStream } from "./image-stream.js";
import { withImageStreamDispatcher } from "./image-stream-dispatcher.js";
import { DEFAULT_ATTEMPT_TIMEOUT_MS, GPT_IMAGE_MAX_PIXELS } from "./image-service-constants.js";
import type {
  FetchLike,
  GeneratedImage,
  ImageGenerationErrorCategory,
  ImageGenerationErrorClassification,
  ImageGenerationResult,
  ImageGenerationUsage,
} from "./image-service-types.js";

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

export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const IMAGE_UPSTREAM_REQUEST_ID_HEADERS = [
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

export const IMAGE_TRANSPORT_CODES = new Set([
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

export function classifyUpstreamFailure(
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

export function errorName(error: unknown): string {
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

export function usageFromPayload(payload: unknown): ImageGenerationUsage | null {
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

export async function decodedImageSize(image: GeneratedImage): Promise<string | null> {
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

export async function detailedResult(
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

export async function upstreamError(response: Response): Promise<ImageGenerationUpstreamError> {
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

export async function fetchWithSignal(
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
export async function withImageAttemptDeadline<T>(
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

export async function fetchWithTimeout(
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
