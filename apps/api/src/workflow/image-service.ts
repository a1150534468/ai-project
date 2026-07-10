import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { loadS3Config, makeS3, putObject, type S3Config } from "../storage/s3.js";
import { publicObjectUrl as basePublicObjectUrl } from "../storage/public-url.js";
import { upstreamImageOptions } from "./image-upstream-options.js";

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
const DEFAULT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const IMAGE_GENERATIONS_PATH = "/images/generations";
const IMAGE_EDITS_PATH = "/images/edits";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageGenerationConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
}

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

function endpointFromBase(baseURL: string, path: string): string {
  const base = trimTrailingSlash(baseURL);
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
}

function baseURLFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.IMAGE_BASE_URL ?? env.LLM_BASE_URL ?? "").trim();
}

function deriveEditEndpoint(generationEndpoint: string): string | null {
  if (generationEndpoint.endsWith(IMAGE_GENERATIONS_PATH)) return `${generationEndpoint.slice(0, -IMAGE_GENERATIONS_PATH.length)}${IMAGE_EDITS_PATH}`;
  if (/\/generations\/?$/.test(generationEndpoint)) return generationEndpoint.replace(/\/generations\/?$/, "/edits");
  return null;
}

function generationEndpointFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.IMAGE_GENERATION_ENDPOINT?.trim();
  if (explicit) return explicit;
  const baseURL = baseURLFromEnv(env);
  if (!baseURL) throw new Error("IMAGE_BASE_URL/LLM_BASE_URL required");
  return endpointFromBase(baseURL, IMAGE_GENERATIONS_PATH);
}

function hasImageEditEndpointInputs(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.IMAGE_EDIT_ENDPOINT?.trim() || env.IMAGE_GENERATION_ENDPOINT?.trim() || baseURLFromEnv(env));
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

function appendBinaryImage(form: FormData, fieldName: string, image: ImageBinaryInput, fallbackName: string): void {
  const mime = image.mime?.trim().startsWith("image/") ? image.mime.trim() : "image/png";
  const filename = image.filename?.trim() || fallbackName;
form.append(fieldName, new Blob([Buffer.from(image.b64, "base64")], { type: mime }), filename);
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
  const apiKey = (env.IMAGE_API_KEY ?? env.LLM_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("IMAGE_API_KEY/LLM_API_KEY required");
  return {
    endpoint: generationEndpointFromEnv(env),
    apiKey,
    model: (env.IMAGE_GENERATION_MODEL ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL,
  };
}

export function loadImageEditEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.IMAGE_EDIT_ENDPOINT?.trim();
  if (explicit) return explicit;
  const generationEndpoint = generationEndpointFromEnv(env);
  const derived = deriveEditEndpoint(generationEndpoint);
  if (derived) return derived;
  throw new Error("IMAGE_EDIT_ENDPOINT required when IMAGE_GENERATION_ENDPOINT is not a recognized images/generations endpoint");
}

export function loadImageAttemptTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

export function extractGeneratedImage(payload: unknown): GeneratedImage {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) throw new Error("image response missing data");
  const first = payload.data[0];
  if (!isRecord(first)) throw new Error("image response item invalid");
  if (typeof first.url === "string" && first.url.length > 0) return { kind: "url", url: first.url };
  if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
    const mime = typeof first.mime_type === "string" && first.mime_type.startsWith("image/") ? first.mime_type : "image/png";
    return { kind: "b64", b64: first.b64_json, mime };
  }
  throw new Error("image response has no url or b64_json");
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
  const body: Record<string, string | number> = { model: args.config.model, prompt: args.prompt, n: 1, response_format: "b64_json" };
  const upstreamOptions = upstreamImageOptions(args.size);
  if (upstreamOptions.size !== "auto") body.size = upstreamOptions.size;
  if (upstreamOptions.resolution) body.resolution = upstreamOptions.resolution;
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
  const form = new FormData();
  form.set("model", args.config.model);
  form.set("prompt", args.prompt);
  form.set("n", "1");
  if (args.size) form.set("size", args.size);
  args.referenceImages.forEach((image, index) => appendBinaryImage(form, "image[]", image, `reference-${index + 1}.png`));
  if (args.mask) appendBinaryImage(form, "mask", args.mask, "mask.png");
  const derivedEndpoint = deriveEditEndpoint(args.config.endpoint);
  const endpoint = args.endpoint ?? derivedEndpoint ?? (args.env && hasImageEditEndpointInputs(args.env) ? loadImageEditEndpoint(args.env) : null);
  if (!endpoint) {
    throw new Error("image edit endpoint is not derivable from config.endpoint; pass endpoint or use IMAGE_EDIT_ENDPOINT");
  }
  const response = await fetchWithTimeout(args.fetchFn, endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${args.config.apiKey}` },
    body: form,
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
