import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { loadS3Config, makeS3, putObject, type S3Config } from "../storage/s3.js";
import { publicObjectUrl as basePublicObjectUrl } from "../storage/public-url.js";

export const QWEN_IMAGE_MODEL = "qwen-image-2.0-pro-2026-04-22";
export const GPT_IMAGE_MODEL = "gpt-image-2";
export const IMAGE_GENERATION_MODELS = [QWEN_IMAGE_MODEL, GPT_IMAGE_MODEL] as const;
const DEFAULT_IMAGE_MODEL = QWEN_IMAGE_MODEL;
const DEFAULT_GPT_IMAGE_GENERATION_ENDPOINT = "https://api.ai-pixel.online/v1/images/generations";
const DEFAULT_BAILIAN_REGION = "cn-beijing";
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
const DEFAULT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const BAILIAN_IMAGE_GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const QWEN_IMAGE_MIN_PIXELS = 512 * 512;
const QWEN_IMAGE_MAX_PIXELS = 2048 * 2048;
const QWEN_IMAGE_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const GPT_IMAGE_MIN_PIXELS = 655_360;
const GPT_IMAGE_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_MAX_EDGE = 3_840;
const GPT_IMAGE_MAX_ASPECT_RATIO = 3;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageGenerationConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly protocol: "bailian" | "openai";
}

export type ImageGenerationModel = typeof IMAGE_GENERATION_MODELS[number];

export type GeneratedImage = { readonly kind: "url"; readonly url: string } | { readonly kind: "b64"; readonly b64: string; readonly mime: string };

export interface StoredImage { readonly originalUrl: string; readonly thumbnailUrl: string; readonly mime: string; readonly objectKey: string | null; }

export interface RetryOptions {
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void>;
  readonly shouldStop?: (error: unknown) => boolean;
}

interface ImageBinaryInput {
  readonly b64: string;
  readonly mime?: string;
  readonly filename?: string;
}

interface CallImageGenerationArgs {
  readonly config: ImageGenerationConfig;
  readonly prompt: string;
  readonly size: string;
  readonly fetchFn: FetchLike;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

interface CallImageEditArgs {
  readonly config: ImageGenerationConfig;
  readonly prompt: string;
  readonly referenceImages: readonly ImageBinaryInput[];
  readonly fetchFn: FetchLike;
  readonly size?: string;
  readonly mask?: ImageBinaryInput;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly endpoint?: string;
}

interface StoreWorkflowImageArgs {
  readonly image: GeneratedImage;
  readonly userId: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly fetchFn: FetchLike;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

function dataUrlForImageInput(image: ImageBinaryInput): string {
  const mime = image.mime?.trim().startsWith("image/") ? image.mime.trim() : "image/png";
  const bytes = Buffer.from(image.b64, "base64");
  if (bytes.byteLength > QWEN_IMAGE_MAX_INPUT_BYTES) throw new Error("Qwen image input must not exceed 10MB");
  return `data:${mime};base64,${image.b64}`;
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
  const response = await fetchWithTimeout(fetchFn, url, { method: "GET" }, 60_000, signal);
  if (!response.ok) throw new Error(`image download ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const maxBytes = Number(env.IMAGE_MAX_BYTES) || DEFAULT_IMAGE_MAX_BYTES;
  if (buffer.byteLength > maxBytes) throw new Error("image too large");
  const contentType = response.headers.get("content-type") ?? "image/png";
  return { buffer, mime: contentType.startsWith("image/") ? contentType : "image/png" };
}

export function loadImageGenerationConfig(env: NodeJS.ProcessEnv = process.env): ImageGenerationConfig {
  const model = (env.IMAGE_GENERATION_MODEL ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  return loadImageGenerationConfigForModel(model, env);
}

export function loadImageGenerationConfigForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ImageGenerationConfig {
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
    endpoint: generationEndpointFromEnv(env),
    apiKey,
    model,
    protocol: "bailian",
  };
}

export function loadImageEditEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.IMAGE_EDIT_ENDPOINT?.trim();
  if (explicit) return explicit;
  return generationEndpointFromEnv(env);
}

export function loadImageAttemptTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

export function extractGeneratedImage(payload: unknown): GeneratedImage {
  if (!isRecord(payload)) throw new Error("image response invalid");

  // Keep accepting the former OpenAI-compatible response so custom relays do not
  // break while deployments migrate to the native Bailian endpoint.
  if (Array.isArray(payload.data) && payload.data.length > 0) {
    const first = payload.data[0];
    if (!isRecord(first)) throw new Error("image response item invalid");
    if (typeof first.url === "string" && first.url.length > 0) return { kind: "url", url: first.url };
    if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
      const mime = typeof first.mime_type === "string" && first.mime_type.startsWith("image/") ? first.mime_type : "image/png";
      return { kind: "b64", b64: first.b64_json, mime };
    }
  }

  const output = payload.output;
  if (isRecord(output) && Array.isArray(output.choices)) {
    for (const choice of output.choices) {
      if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.content)) continue;
      for (const content of choice.message.content) {
        if (isRecord(content) && typeof content.image === "string" && content.image.length > 0) {
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

export async function callImageGeneration(args: CallImageGenerationArgs): Promise<GeneratedImage> {
  const body = args.config.protocol === "openai"
    ? {
        model: args.config.model,
        prompt: args.prompt,
        n: 1,
        size: gptImageSize(args.size),
      }
    : {
        model: args.config.model,
        input: {
          messages: [{ role: "user", content: [{ text: args.prompt }] }],
        },
        parameters: qwenImageParameters(args.size),
      };
  const response = await fetchWithTimeout(args.fetchFn, args.config.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
    body: JSON.stringify(body),
  }, loadImageAttemptTimeoutMs(args.env), args.signal);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`image relay ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`);
  }
  return extractGeneratedImage(await response.json());
}

export async function callImageEdit(args: CallImageEditArgs): Promise<GeneratedImage> {
  if (args.config.protocol !== "bailian") {
    throw new Error("gpt-image-2 reference editing is not configured; use Qwen Image for reference images");
  }
  if (args.referenceImages.length < 1 || args.referenceImages.length > 3) {
    throw new Error("Qwen image editing requires 1 to 3 reference images");
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
  const response = await fetchWithTimeout(args.fetchFn, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
    body: JSON.stringify(body),
  }, loadImageAttemptTimeoutMs(args.env), args.signal);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`image relay ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`);
  }
  return extractGeneratedImage(await response.json());
}

export async function storeWorkflowImage(args: StoreWorkflowImageArgs): Promise<StoredImage> {
  const env = args.env ?? process.env;
  const loaded = tryLoadS3(env);
  if (args.image.kind === "url" && !loaded) {
    return { originalUrl: args.image.url, thumbnailUrl: args.image.url, mime: "image/png", objectKey: null };
  }
  const binary = args.image.kind === "b64"
    ? { buffer: Buffer.from(args.image.b64, "base64"), mime: args.image.mime }
    : await fetchRemoteImage(args.image.url, args.fetchFn, env, args.signal);
  if (!loaded) {
    const dataUrl = dataUrlForBinary(binary);
    return { originalUrl: dataUrl, thumbnailUrl: dataUrl, mime: binary.mime, objectKey: null };
  }
  const extension = binary.mime.includes("jpeg") || binary.mime.includes("jpg") ? "jpg" : "png";
  const key = `workflow/images/${args.userId}/${args.requestId}/${args.requestIndex}-${randomUUID()}.${extension}`;
  await putObject(loaded.s3, key, binary.buffer, binary.mime, { acl: "public-read" });
  const url = shouldInlineStoredImageForLocalEndpoint(loaded.cfg, env)
    ? dataUrlForBinary(binary)
    : publicObjectUrl(loaded.cfg, key, env);
  return { originalUrl: url, thumbnailUrl: url, mime: binary.mime, objectKey: key };
}
