/**
 * codex-pet-visual 拆分后的出图链路:参考图压缩、图像模型合同校验、产物下载、
 * 全局派发冷却、重试节奏,以及唯一的对外出图入口 `generateCodexPetVisual`。
 *
 * `CodexPetImageModelMismatchError` 与它唯一的抛出点 `assertCodexPetImageModel`、
 * 唯一的捕获点(`generateCodexPetVisual` 里 `instanceof` 直接放弃重试)必须留在同一个
 * 文件:模型合同违规不是瞬时故障,重试只会把同一个错误再撞一遍,把类挪出去就会出现
 * "两个 instanceof 各指一个类"的隐性回归。
 *
 * `codexPetImageDispatchTail` / `codexPetImageDispatchReadyAt` 是进程级单例状态 ——
 * 全局串行 + 冷却靠它实现。它只能存在于这一个文件里,复制一份等于冷却失效。
 *
 * `compactEditReferences` 存在的原因是 GPT Image edits 最多接三张 multipart 参考图,
 * 而方向行会带上 canonical / cardinals / 上一行 / 布局图。前两张保留成独立权威锚点,
 * 其余折成一张无标签的 contact sheet。
 *
 * 依赖方向:types / seedream → 本文件。不 import client / qa / direction。
 */

import { Buffer } from "node:buffer";
import {
  GPT_IMAGE_MODEL,
  callImageEditDetailed,
  callImageGenerationDetailed,
  classifyImageGenerationError,
  loadImageGenerationConfigForModel,
  type ImageBinaryInput,
  type ImageGenerationResult,
} from "../_shared/image-service.js";
import { createCodexPetUpstreamFetch } from "./codex-pet-network.js";
import { loadSharp } from "../../runtime/resource-limits.js";
import {
  CodexPetModelContractError,
  isAllowedCodexPetImageProvenance,
} from "./codex-pet-model-contract.js";
import type { GeneratedPetVisual } from "./codex-pet-visual-types.js";
import {
  adaptCodexPetPromptForModel,
  normalizeSeedreamChromaMatte,
} from "./codex-pet-visual-seedream.js";

class CodexPetImageModelMismatchError extends CodexPetModelContractError {
  constructor(requested: string, actual: string) {
    super(`Codex pet image model mismatch: requested ${requested}, received ${actual}`);
    this.name = "CodexPetImageModelMismatchError";
  }
}

function assertCodexPetImageModel(result: ImageGenerationResult, requestedModel: string): void {
  const actual = result.actualModel.trim();
  // New runs are constrained before this helper is reached. Keep exact-model
  // verification for legacy persisted artifact tooling without widening the
  // request allowlist used by the Codex pet API/runner.
  if (requestedModel !== GPT_IMAGE_MODEL) {
    if (result.requestedModel !== requestedModel || actual !== requestedModel) {
      throw new CodexPetImageModelMismatchError(result.requestedModel, actual || "unknown");
    }
    return;
  }
  const exactOrRelayAlias = actual === requestedModel
    || (requestedModel === GPT_IMAGE_MODEL && actual === "gpt-image-2-codex");
  if (result.requestedModel !== requestedModel
    || !isAllowedCodexPetImageProvenance(actual)
    || !exactOrRelayAlias) {
    throw new CodexPetImageModelMismatchError(result.requestedModel, actual || "unknown");
  }
}

/**
 * GPT Image edits accepts at most three multipart reference images.  The pet
 * runner deliberately supplies a few deterministic guidance images for the
 * direction rows (canonical character, standard contact, approved cardinals,
 * previous row and layout guide), which can exceed that provider limit.  Keep
 * the first two references as independent authoritative anchors (the pet
 * runner orders these as canonical identity followed by approved cardinals)
 * and fold any remaining guidance into a small, label-free contact sheet.
 * This preserves all of the visual evidence while making the shared image
 * adapter's one-to-three-reference contract explicit for every caller.
 */
async function compactEditReferences(
  references: readonly ImageBinaryInput[],
): Promise<readonly ImageBinaryInput[]> {
  if (references.length <= 3) return references;
  const sharp = await loadSharp();

  const keepCount = Math.min(2, references.length - 1);
  const kept = references.slice(0, keepCount);
  const guidance = references.slice(keepCount);
  const tileSize = 768;
  const columns = Math.min(2, guidance.length);
  const rows = Math.ceil(guidance.length / columns);
  const tiles = await Promise.all(guidance.map(async (reference) => (
    sharp(Buffer.from(reference.b64, "base64"), { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: tileSize, height: tileSize, fit: "contain", background: "#ffffff" })
      .png({ compressionLevel: 9 })
      .toBuffer()
  )));
  const composite = await sharp({
    create: {
      width: columns * tileSize,
      height: rows * tileSize,
      channels: 4,
      background: "#ffffff",
    },
  })
    .composite(tiles.map((tile, index) => ({
      input: tile,
      left: (index % columns) * tileSize,
      top: Math.floor(index / columns) * tileSize,
    })))
    .png({ compressionLevel: 9 })
    .toBuffer();
  return [
    ...kept,
    {
      b64: composite.toString("base64"),
      mime: "image/png",
      filename: "codex-pet-guidance-reference.png",
    },
  ];
}

async function generatedImageBuffer(result: ImageGenerationResult, fetchFn: typeof fetch, signal?: AbortSignal): Promise<{ buffer: Buffer; mime: string }> {
  if (result.image.kind === "b64") {
    const buffer = Buffer.from(result.image.b64, "base64");
    if (buffer.byteLength === 0) throw new Error("image provider returned empty base64");
    return { buffer, mime: result.image.mime };
  }
  const response = await fetchFn(result.image.url, { method: "GET", signal });
  if (!response.ok) throw new Error(`generated image download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 32 * 1024 * 1024) throw new Error("generated image exceeds 32MB");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > 32 * 1024 * 1024) throw new Error("generated image size is invalid");
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  return { buffer, mime: contentType.startsWith("image/") ? contentType : "image/png" };
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

let codexPetImageDispatchTail: Promise<void> = Promise.resolve();
let codexPetImageDispatchReadyAt = 0;

export function codexPetImageDispatchCooldownMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.CODEX_PET_IMAGE_DISPATCH_COOLDOWN_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(300_000, Math.floor(configured))
    : 0;
}

async function withCodexPetImageDispatchCooldown<T>(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly dispatch: () => Promise<T>;
}): Promise<T> {
  const cooldownMs = codexPetImageDispatchCooldownMs(input.env);
  if (cooldownMs === 0) return input.dispatch();

  let release!: () => void;
  const previous = codexPetImageDispatchTail;
  codexPetImageDispatchTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const remainingMs = codexPetImageDispatchReadyAt - Date.now();
    if (remainingMs > 0) await wait(remainingMs, input.signal);
    return await input.dispatch();
  } finally {
    codexPetImageDispatchReadyAt = Date.now() + cooldownMs;
    release();
  }
}

export function codexPetImageRetryDelayMs(attempt: number, env: NodeJS.ProcessEnv): number {
  const configuredBase = Number(env.CODEX_PET_IMAGE_RETRY_BASE_MS);
  const base = Number.isFinite(configuredBase) && configuredBase >= 0
    ? Math.min(60_000, configuredBase)
    : 5_000;
  const configuredMax = Number(env.CODEX_PET_IMAGE_RETRY_MAX_MS);
  const max = Number.isFinite(configuredMax) && configuredMax >= base
    ? Math.min(120_000, configuredMax)
    : 30_000;
  return Math.min(max, base * 3 ** Math.max(0, attempt - 1));
}

export function codexPetImageMaxAttempts(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.CODEX_PET_IMAGE_MAX_ATTEMPTS);
  return Number.isInteger(configured) && configured >= 1
    ? Math.min(3, configured)
    : 3;
}

export async function generateCodexPetVisual(input: {
  readonly prompt: string;
  readonly model?: string;
  readonly references?: readonly ImageBinaryInput[];
  readonly size?: string;
  readonly quality?: "low" | "medium" | "high" | "auto";
  readonly fetchFn?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  readonly onAttempt?: (attempt: number) => Promise<void> | void;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void> | void;
}): Promise<GeneratedPetVisual> {
  const env = input.env ?? process.env;
  const requestedModel = input.model?.trim() || GPT_IMAGE_MODEL;
  const config = loadImageGenerationConfigForModel(requestedModel, env);
  const fetchFn = input.fetchFn ?? createCodexPetUpstreamFetch(config.endpoint, env);
  const prompt = adaptCodexPetPromptForModel(input.prompt, requestedModel);
  // A final real verification can cap provider attempts at one without
  // changing the normal production retry policy. Explicit per-job limits
  // (for example the direction approval gate) may only reduce this cap.
  const maxAttempts = Math.max(1, Math.min(
    input.maxAttempts ?? 3,
    codexPetImageMaxAttempts(env),
  ));
  // Compact deterministic guidance before entering the retry loop.  Without
  // this normalization, direction rows (which carry canonical, cardinal,
  // previous-row and layout references) would send four or five `image[]`
  // parts and be rejected by the shared GPT Image edits adapter before any
  // visual work starts.
  const references = await compactEditReferences(input.references ?? []);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await input.onAttempt?.(attempt);
      const provider = await withCodexPetImageDispatchCooldown({
        env,
        signal: input.signal,
        dispatch: () => references.length > 0
          ? callImageEditDetailed({
              config,
              prompt,
              referenceImages: references,
              size: input.size ?? "1536x1024",
              quality: input.quality ?? "low",
              outputFormat: "png",
              fetchFn,
              env,
              signal: input.signal,
            })
          : callImageGenerationDetailed({
              config,
              prompt,
              size: input.size ?? "1024x1024",
              quality: input.quality ?? "low",
              outputFormat: "png",
              fetchFn,
              env,
              signal: input.signal,
            }),
      });
      assertCodexPetImageModel(provider, requestedModel);
      const binary = await generatedImageBuffer(provider, fetchFn, input.signal);
      const normalized = await normalizeSeedreamChromaMatte(binary.buffer, input.prompt, requestedModel);
      const output = {
        buffer: normalized.buffer,
        mime: normalized.mime || binary.mime,
      };
      const sharp = await loadSharp();
      const metadata = await sharp(output.buffer, { limitInputPixels: 40_000_000 }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("image provider returned an unreadable raster");
      return { ...output, provider: { ...provider, actualSize: `${metadata.width}x${metadata.height}` } };
    } catch (error) {
      lastError = error;
      if (error instanceof CodexPetImageModelMismatchError) throw error;
      const classification = classifyImageGenerationError(error);
      if (attempt >= maxAttempts || !classification.retryable || input.signal?.aborted) throw error;
      await input.onRetry?.(error, attempt);
      // A relay/TLS socket failure often leaves the connection path unhealthy
      // for a few seconds. The previous 1.5s/3s retry burst immediately
      // repeated both base-candidate failures in lockstep. Keep the same
      // bounded two retries, but allow a real recovery window.
      await wait(codexPetImageRetryDelayMs(attempt, env), input.signal);
    }
  }
  throw lastError;
}
