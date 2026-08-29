/**
 * image-service 拆分后的上游适配层：端点解析（env → base → 具体 path）、按模型选配置，
 * 以及各家上游各自的尺寸/参数整形（qwen 的 size 白名单、gpt 的边长与宽高比、seedream 的像素档）。
 *
 * 依赖方向：constants / types → 本文件 → calls。不许 import upstream 或 storage——
 * 这里全是纯函数与 env 读取，一旦反向依赖就把「配置解析」和「网络交互」焊死在一起。
 */

import { Buffer } from "node:buffer";
import { loadSharp } from "../../runtime/resource-limits.js";
import { trimTrailingSlash } from "../../runtime/url.js";
import { imageResolutionFromSize } from "./image-upstream-options.js";
import {
  BAILIAN_IMAGE_GENERATION_PATH,
  DEFAULT_BAILIAN_REGION,
  DEFAULT_DOUBAO_IMAGE_ENDPOINT,
  DEFAULT_GPT_IMAGE_GENERATION_ENDPOINT,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_QWEN_IMAGE_ENDPOINT,
  DOUBAO_IMAGE_MODEL,
  GPT_IMAGE_MAX_ASPECT_RATIO,
  GPT_IMAGE_MAX_EDGE,
  GPT_IMAGE_MAX_PIXELS,
  GPT_IMAGE_MIN_PIXELS,
  GPT_IMAGE_MODEL,
  IMAGE_REFERENCE_MAX_BYTES,
  QWEN_IMAGE_MAX_PIXELS,
  QWEN_IMAGE_MIN_PIXELS,
  QWEN_IMAGE_MODEL,
  SEEDREAM_MAX_ASPECT_RATIO,
  SEEDREAM_MAX_PIXELS,
  SEEDREAM_MIN_PIXELS,
} from "./image-service-constants.js";
import type { ImageBinaryInput, ImageGenerationConfig } from "./image-service-types.js";

export function endpointFromBase(baseURL: string): string {
  const base = trimTrailingSlash(baseURL);
  if (base.endsWith(BAILIAN_IMAGE_GENERATION_PATH)) return base;
  if (base.endsWith("/api/v1")) return `${base}${BAILIAN_IMAGE_GENERATION_PATH.slice("/api/v1".length)}`;
  return `${base}${BAILIAN_IMAGE_GENERATION_PATH}`;
}

export function baseURLFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.IMAGE_BASE_URL ?? "").trim();
}

export function workspaceImageEndpoint(env: NodeJS.ProcessEnv): string | null {
  const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim();
  if (!workspaceId) return null;
  const region = env.BAILIAN_REGION?.trim() || DEFAULT_BAILIAN_REGION;
  return `https://${workspaceId}.${region}.maas.aliyuncs.com${BAILIAN_IMAGE_GENERATION_PATH}`;
}

export function generationEndpointFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.IMAGE_GENERATION_ENDPOINT?.trim();
  if (explicit) return explicit;
  const baseURL = baseURLFromEnv(env);
  if (baseURL) return endpointFromBase(baseURL);
  const workspaceEndpoint = workspaceImageEndpoint(env);
  if (workspaceEndpoint) return workspaceEndpoint;
  throw new Error("BAILIAN_WORKSPACE_ID or IMAGE_GENERATION_ENDPOINT/IMAGE_BASE_URL required for image generation");
}

export function qwenImageEndpointFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.IMAGE_GENERATION_ENDPOINT?.trim();
  if (explicit) return explicit;
  const baseURL = baseURLFromEnv(env);
  if (baseURL) return endpointFromBase(baseURL);
  return DEFAULT_QWEN_IMAGE_ENDPOINT;
}

export function usesRequestBoundNativeQwenModel(config: ImageGenerationConfig): boolean {
  if (config.protocol !== "bailian" || config.model !== QWEN_IMAGE_MODEL) return false;
  try {
    const hostname = new URL(config.endpoint).hostname.toLowerCase();
    return hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".maas.aliyuncs.com");
  } catch {
    return false;
  }
}

export function seedreamSize(size: string): string {
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
export function validatedImageInput(image: ImageBinaryInput, label: string): { readonly bytes: Buffer; readonly mime: string } {
  const mime = image.mime?.trim().startsWith("image/") ? image.mime.trim() : "image/png";
  const bytes = Buffer.from(image.b64, "base64");
  if (bytes.byteLength <= 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) {
    throw new Error(`${label} must be between 1 byte and ${IMAGE_REFERENCE_MAX_BYTES} bytes`);
  }
  return { bytes, mime };
}

export const OPENAI_EDIT_NATIVE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export async function openAiEditImagePart(
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

export function dataUrlForImageInput(image: ImageBinaryInput): string {
  const { bytes, mime } = validatedImageInput(image, "Qwen image input");
  // Re-encode decoded bytes so malformed or whitespace-heavy base64 never gets
  // forwarded verbatim to the provider.
  const b64 = bytes.toString("base64");
  return `data:${mime};base64,${b64}`;
}

export function qwenImageSize(size: string | undefined): string | undefined {
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

export function qwenImageParameters(size: string | undefined): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    n: 1,
    prompt_extend: true,
    watermark: false,
  };
  const qwenSize = qwenImageSize(size);
  if (qwenSize) parameters.size = qwenSize;
  return parameters;
}

export function gptImageSize(size: string | undefined): string | undefined {
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
