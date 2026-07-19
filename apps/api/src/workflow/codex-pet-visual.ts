import { Buffer } from "node:buffer";
import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import sharp from "sharp";
import type { DirectionBlindAnswerKey } from "@ai-assistant/codex-pet-pipeline";
import {
  GPT_IMAGE_MODEL,
  callImageEditDetailed,
  callImageGenerationDetailed,
  classifyImageGenerationError,
  loadImageGenerationConfigForModel,
  type ImageBinaryInput,
  type ImageGenerationResult,
} from "./image-service.js";
import {
  CodexPetModelContractError,
  CODEX_PET_VISUAL_QA_MODEL,
  isAllowedCodexPetImageModel,
  isAllowedCodexPetVisualModel,
} from "./codex-pet-model-contract.js";

export const DEFAULT_CODEX_PET_VISUAL_QA_MODEL = CODEX_PET_VISUAL_QA_MODEL;
const DEFAULT_CODEX_PET_VISUAL_QA_BASE_URL = "https://api.ai-pixel.online";

export interface CodexPetVisualModelProvenance {
  readonly requestedModel: string;
  readonly actualModel: string;
  readonly route: "chatgpt_model_route" | "injected_test_client";
}

/** First-version Codex pet visual reasoning is GPT-only by product contract. */
export function resolveCodexPetVisualQaModel(env: NodeJS.ProcessEnv): string {
  const model = env.PET_VISUAL_QA_MODEL?.trim() || DEFAULT_CODEX_PET_VISUAL_QA_MODEL;
  if (model !== DEFAULT_CODEX_PET_VISUAL_QA_MODEL) {
    throw new CodexPetModelContractError(`PET_VISUAL_QA_MODEL must be ${DEFAULT_CODEX_PET_VISUAL_QA_MODEL} for the Codex pet workflow`);
  }
  return model;
}

/**
 * The shared LLM client intentionally falls back to its primary provider when
 * a model route is missing. That is useful for ordinary chat, but unsafe for
 * this GPT-only workflow because the primary provider may be Bailian/Qwen.
 * Fail before accepting work instead of sending a GPT model name to the wrong
 * endpoint.
 */
export function assertCodexPetVisualQaRoute(env: NodeJS.ProcessEnv = process.env): {
  readonly model: string;
  readonly baseURL: string;
} {
  const { model, baseURL } = loadCodexPetVisualQaRoute(env);
  return { model, baseURL };
}

function loadCodexPetVisualQaRoute(env: NodeJS.ProcessEnv): {
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
} {
  const model = resolveCodexPetVisualQaModel(env);
  const configuredModels = env.CHATGPT_MODELS
    ?.split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (configuredModels?.length && !configuredModels.includes(model)) {
    throw new CodexPetModelContractError(`${model} must be present in CHATGPT_MODELS for the Codex pet workflow`);
  }
  const apiKey = env.CHATGPT_API_KEY?.trim() || env.GPT_IMAGE_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new CodexPetModelContractError(`${model} requires CHATGPT_API_KEY or GPT_IMAGE_API_KEY for the Codex pet workflow`);
  }
  const baseURL = env.CHATGPT_BASE_URL?.trim() || DEFAULT_CODEX_PET_VISUAL_QA_BASE_URL;
  let parsed: URL;
  try { parsed = new URL(baseURL); } catch {
    throw new CodexPetModelContractError(`CHATGPT_BASE_URL is invalid for the Codex pet workflow`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CodexPetModelContractError(`CHATGPT_BASE_URL must use HTTP(S) for the Codex pet workflow`);
  }
  return { model, baseURL, apiKey };
}

function codexPetVisualClient(env: NodeJS.ProcessEnv, injected?: Anthropic): {
  readonly client: Anthropic;
  readonly requestedModel: string;
  readonly route: CodexPetVisualModelProvenance["route"];
} {
  const requestedModel = resolveCodexPetVisualQaModel(env);
  if (injected) return { client: injected, requestedModel, route: "injected_test_client" };
  const route = loadCodexPetVisualQaRoute(env);
  return {
    // Use the exact GPT route directly. The shared LLM client intentionally
    // owns a primary-provider fallback (often Bailian/Qwen); that behavior is
    // useful for ordinary chat but is forbidden by the desktop-pet contract.
    client: new Anthropic({ baseURL: route.baseURL, apiKey: route.apiKey }),
    requestedModel,
    route: "chatgpt_model_route",
  };
}

function responseModel(message: Anthropic.Message | string, requestedModel: string, allowMissing = false): string {
  let parsed: unknown = message;
  if (typeof message === "string") {
    try { parsed = JSON.parse(message) as unknown; } catch { parsed = null; }
  }
  const actualModel = parsed && typeof parsed === "object" && typeof (parsed as { model?: unknown }).model === "string"
    ? (parsed as { model: string }).model.trim()
    : "";
  if (!actualModel) {
    if (allowMissing) return requestedModel;
    throw new CodexPetModelContractError(`Codex pet visual response did not report its model for requested ${requestedModel}`);
  }
  if (requestedModel !== CODEX_PET_VISUAL_QA_MODEL || !isAllowedCodexPetVisualModel(actualModel)) {
    throw new CodexPetModelContractError(`Codex pet visual model mismatch: requested ${requestedModel}, received ${actualModel || "unknown"}`);
  }
  return actualModel;
}

function modelProvenance(
  message: Anthropic.Message | string,
  requestedModel: string,
  route: CodexPetVisualModelProvenance["route"],
): CodexPetVisualModelProvenance {
  return {
    requestedModel,
    actualModel: responseModel(message, requestedModel, route === "injected_test_client"),
    route,
  };
}

export interface GeneratedPetVisual {
  readonly buffer: Buffer;
  readonly mime: string;
  readonly provider: ImageGenerationResult;
}

class CodexPetImageModelMismatchError extends CodexPetModelContractError {
  constructor(requested: string, actual: string) {
    super(`Codex pet image model mismatch: requested ${requested}, received ${actual}`);
    this.name = "CodexPetImageModelMismatchError";
  }
}

function assertCodexPetImageModel(result: ImageGenerationResult): void {
  const actual = result.actualModel.trim();
  if (result.requestedModel !== GPT_IMAGE_MODEL
    || !isAllowedCodexPetImageModel(actual)) {
    throw new CodexPetImageModelMismatchError(result.requestedModel, actual || "unknown");
  }
}

export interface PetVisualQaVerdict {
  readonly pass: boolean;
  readonly score: number;
  readonly mirrorSafe: boolean;
  readonly identity: boolean;
  readonly structure: boolean;
  readonly semantics: boolean;
  readonly continuity: boolean;
  readonly warnings: readonly string[];
  readonly failures: readonly string[];
  readonly repairPrompt: string;
  readonly modelProvenance?: CodexPetVisualModelProvenance;
  /**
   * Complete action groups that should be regenerated when this verdict
   * fails.  Older QA providers may omit the field; callers must then infer a
   * conservative repair scope from failures/repairPrompt.
   */
  readonly repairRows?: readonly string[];
}

export interface PetVisualQaConsensus {
  readonly pass: boolean;
  readonly verdicts: readonly PetVisualQaVerdict[];
  readonly score: number;
  readonly mirrorSafe: boolean;
  readonly warnings: readonly string[];
  readonly failures: readonly string[];
  readonly modelProvenance?: {
    readonly requestedModel: string;
    readonly actualModels: readonly string[];
    readonly route: CodexPetVisualModelProvenance["route"];
  };
}

export function codexPetVisualQaVerdictPasses(verdict: PetVisualQaVerdict): boolean {
  return verdict.pass
    && verdict.identity
    && verdict.structure
    && verdict.semantics
    && verdict.continuity;
}

/** Require a strict majority for every hard visual dimension independently. */
export function codexPetVisualQaConsensusPasses(consensus: PetVisualQaConsensus): boolean {
  if (!consensus.pass || consensus.verdicts.length === 0) return false;
  const required = Math.floor(consensus.verdicts.length / 2) + 1;
  const majority = (field: "pass" | "identity" | "structure" | "semantics" | "continuity") => (
    consensus.verdicts.filter((verdict) => verdict[field]).length >= required
  );
  return majority("pass")
    && majority("identity")
    && majority("structure")
    && majority("semantics")
    && majority("continuity");
}

export type BlindDirectionClass = "screen-left" | "screen-right" | "up" | "down" | "ambiguous";
export interface BlindDirectionPairVerdict {
  readonly pair: string;
  readonly A: BlindDirectionClass;
  readonly B: BlindDirectionClass;
  readonly reason: string;
}

export interface BlindDirectionValidation {
  readonly ok: boolean;
  readonly reviewers: readonly { readonly pairs: readonly BlindDirectionPairVerdict[] }[];
  readonly consensus: readonly BlindDirectionPairVerdict[];
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly modelProvenance?: {
    readonly requestedModel: string;
    readonly actualModels: readonly string[];
    readonly route: CodexPetVisualModelProvenance["route"];
  };
}

export interface DirectionSemanticVerdict {
  readonly direction: string;
  readonly verdict: "pass" | "warning" | "fail";
  readonly expected: string;
  readonly observed: string;
  readonly horizontalEvidence: string;
  readonly verticalEvidence: string;
  readonly reason: string;
  readonly modelProvenance?: CodexPetVisualModelProvenance;
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

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
}

function normalizeQaVerdict(value: unknown): PetVisualQaVerdict {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const repairRows = Array.isArray(row.repairRows)
    ? row.repairRows.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 16)
    : [];
  return {
    pass: row.pass === true,
    score: Math.max(0, Math.min(100, typeof row.score === "number" ? row.score : 0)),
    mirrorSafe: row.mirrorSafe === true,
    identity: row.identity === true,
    structure: row.structure === true,
    semantics: row.semantics === true,
    continuity: row.continuity === true,
    warnings: safeStringArray(row.warnings),
    failures: safeStringArray(row.failures),
    repairPrompt: typeof row.repairPrompt === "string" ? row.repairPrompt.slice(0, 1200) : "",
    repairRows,
  };
}

function parseJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("visual QA returned no JSON object");
  return JSON.parse(jsonrepair(stripped.slice(start, end + 1)));
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

export async function generateCodexPetVisual(input: {
  readonly prompt: string;
  readonly references?: readonly ImageBinaryInput[];
  readonly size?: string;
  readonly quality?: "low" | "medium" | "high" | "auto";
  readonly fetchFn?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void> | void;
}): Promise<GeneratedPetVisual> {
  const env = input.env ?? process.env;
  const fetchFn = input.fetchFn ?? fetch;
  const config = loadImageGenerationConfigForModel(GPT_IMAGE_MODEL, env);
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  // Compact deterministic guidance before entering the retry loop.  Without
  // this normalization, direction rows (which carry canonical, cardinal,
  // previous-row and layout references) would send four or five `image[]`
  // parts and be rejected by the shared GPT Image edits adapter before any
  // visual work starts.
  const references = await compactEditReferences(input.references ?? []);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const provider = references.length > 0
        ? await callImageEditDetailed({
            config,
            prompt: input.prompt,
            referenceImages: references,
            size: input.size ?? "1536x1024",
            quality: input.quality ?? "low",
            outputFormat: "png",
            fetchFn,
            env,
            signal: input.signal,
          })
        : await callImageGenerationDetailed({
            config,
            prompt: input.prompt,
            size: input.size ?? "1024x1024",
            quality: input.quality ?? "low",
            outputFormat: "png",
            fetchFn,
            env,
            signal: input.signal,
          });
      assertCodexPetImageModel(provider);
      const binary = await generatedImageBuffer(provider, fetchFn, input.signal);
      const metadata = await sharp(binary.buffer, { limitInputPixels: 40_000_000 }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("image provider returned an unreadable raster");
      return { ...binary, provider: { ...provider, actualSize: `${metadata.width}x${metadata.height}` } };
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

function textFromMessage(message: Anthropic.Message | string): string {
  const parsed = typeof message === "string" ? JSON.parse(message) as Anthropic.Message : message;
  return parsed.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("").trim();
}

export async function runCodexPetVisualQa(input: {
  readonly images: readonly { readonly buffer: Buffer; readonly mime?: string }[];
  readonly prompt: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
}): Promise<PetVisualQaVerdict> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const blocks: Array<Record<string, unknown>> = input.images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mime ?? "image/png", data: image.buffer.toString("base64") },
  }));
  blocks.push({ type: "text", text: input.prompt });
  const raw = await visual.client.messages.create({
    model: visual.requestedModel,
    max_tokens: 1200,
    temperature: 0,
    messages: [{ role: "user", content: blocks as unknown as Anthropic.MessageParam["content"] }],
  }, { signal: input.signal, timeout: 180_000 });
  const message = raw as Anthropic.Message | string;
  return {
    ...normalizeQaVerdict(parseJsonObject(textFromMessage(message))),
    modelProvenance: modelProvenance(message, visual.requestedModel, visual.route),
  };
}

export async function runCodexPetVisualQaConsensus(input: Parameters<typeof runCodexPetVisualQa>[0] & { readonly repetitions?: number }): Promise<PetVisualQaConsensus> {
  const repetitions = Math.max(1, input.repetitions ?? 3);
  const verdicts = await Promise.all(Array.from({ length: repetitions }, () => runCodexPetVisualQa(input)));
  const required = Math.floor(repetitions / 2) + 1;
  const pass = verdicts.filter((verdict) => verdict.pass).length >= required;
  const mirrorSafe = verdicts.filter((verdict) => verdict.mirrorSafe).length >= required;
  const provenance = verdicts.map((verdict) => verdict.modelProvenance).filter((value): value is CodexPetVisualModelProvenance => Boolean(value));
  return {
    pass,
    verdicts,
    score: Math.round(verdicts.reduce((sum, verdict) => sum + verdict.score, 0) / verdicts.length),
    mirrorSafe,
    warnings: [...new Set(verdicts.flatMap((verdict) => verdict.warnings))],
    failures: [...new Set(verdicts.flatMap((verdict) => verdict.failures))],
    ...(provenance.length > 0
      ? {
          modelProvenance: {
            requestedModel: provenance[0]!.requestedModel,
            actualModels: [...new Set(provenance.map((value) => value.actualModel))],
            route: provenance[0]!.route,
          },
        }
      : {}),
  };
}

export async function generateCodexPetLookMechanics(input: {
  readonly prompt: string;
  readonly reference: Buffer;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly onModelProvenance?: (provenance: CodexPetVisualModelProvenance) => void;
}): Promise<string> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const raw = await visual.client.messages.create({
    model: visual.requestedModel,
    max_tokens: 500,
    temperature: 0.2,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.reference.toString("base64") } },
      { type: "text", text: input.prompt },
    ] }],
  }, { signal: input.signal, timeout: 120_000 });
  const message = raw as Anthropic.Message | string;
  const provenance = modelProvenance(message, visual.requestedModel, visual.route);
  input.onModelProvenance?.(provenance);
  const text = textFromMessage(message).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("look-mechanics model returned an empty plan");
  return text.slice(0, 1200);
}

export async function generateCodexPetIdentityGuide(input: {
  readonly reference: Buffer;
  readonly mime?: string;
  /**
   * Original user uploads, in upload order. They may clarify what an
   * ambiguous canonical shape represents, but never override the approved
   * canonical appearance.
   */
  readonly originalReferences?: readonly ImageBinaryInput[];
  readonly characterBrief?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly onModelProvenance?: (provenance: CodexPetVisualModelProvenance) => void;
}): Promise<string> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const supportedMime = (mime?: string) => (
    mime === "image/jpeg"
      || mime === "image/webp"
      || mime === "image/gif"
      || mime === "image/png"
      ? mime
      : "image/png"
  );
  const originalReferences = (input.originalReferences ?? []).slice(0, 3);
  const characterBrief = input.characterBrief?.replace(/\s+/g, " ").trim().slice(0, 1200) || "未提供";
  const imageBlocks = [
    { type: "image", source: { type: "base64", media_type: supportedMime(input.mime), data: input.reference.toString("base64") } },
    ...originalReferences.map((reference) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: supportedMime(reference.mime),
        data: reference.b64,
      },
    })),
  ];
  const referenceContext = originalReferences.length > 0
    ? `Images 2-${originalReferences.length + 1} are the original user references in upload order. Use them only to disambiguate anatomical semantics in the canonical image (for example whether a visible shape is an eye, paw, foot, mouth, or fixed marking). They must not override image 1's visible shape, count, position, palette, proportions, topology, material, markings, clothing, props, or silhouette.`
    : "No original user reference images are available. Report genuinely ambiguous canonical features under 歧义 instead of guessing.";
  const content = [
    ...imageBlocks,
    { type: "text", text: `Analyze these images and write one concise Chinese anatomy/identity guide for later Codex desktop-pet image generation and visual QA. Image 1 is the approved canonical image and is the sole visual source of truth. ${referenceContext}

Character brief (semantic context only; never use it to redesign the canonical appearance): ${characterBrief}

Use these exact labeled fields in one short paragraph: 头、耳、眼、嘴、四肢、尾巴、固定花纹、可动特征、歧义. Explicitly distinguish eyes, paws/feet and mouth from decorative markings; state 数量、位置、颜色、连接关系 or 不可见/无 when applicable. Fixed markings must describe count and topology. 可动特征 is only a permission list: a feature may move when the requested action naturally needs it, but it is not required to move in every animation or every frame. A state is not defective merely because an allowed movable feature remains still. Use the original references and brief only to resolve the semantic identity of ambiguous visible canonical features. Put genuinely uncertain interpretations only under 歧义. Do not invent hidden anatomy, new props, markdown, JSON, or production instructions.` },
  ] as unknown as Anthropic.MessageParam["content"];
  const raw = await visual.client.messages.create({
    model: visual.requestedModel,
    max_tokens: 650,
    temperature: 0,
    messages: [{ role: "user", content }],
  }, { signal: input.signal, timeout: 120_000 });
  const message = raw as Anthropic.Message | string;
  const provenance = modelProvenance(message, visual.requestedModel, visual.route);
  input.onModelProvenance?.(provenance);
  const text = textFromMessage(message).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("identity-guide model returned an empty guide");
  return text.slice(0, 1600);
}

function blindClass(value: unknown): BlindDirectionClass {
  return ["screen-left", "screen-right", "up", "down", "ambiguous"].includes(String(value))
    ? value as BlindDirectionClass
    : "ambiguous";
}

async function oneBlindDirectionReview(input: {
  readonly sheet: Buffer;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly identityGuide?: string;
}): Promise<{ pairs: readonly BlindDirectionPairVerdict[]; modelProvenance: CodexPetVisualModelProvenance }> {
  const visual = codexPetVisualClient(input.env, input.client);
  const raw = await visual.client.messages.create({
    model: visual.requestedModel,
    max_tokens: 2200,
    temperature: 0,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.sheet.toString("base64") } },
      { type: "text", text: `Classify every unlabeled Codex-pet A/B pair. Use only the axis named in each row. For horizontal use screen-left, screen-right, or ambiguous. For vertical use up, down, or ambiguous. Never infer from A/B order.${input.identityGuide?.trim() ? ` Approved canonical anatomy guide: ${input.identityGuide.trim()} Use it only to identify the character's real eyes, mouth and movable anatomy instead of mistaking fixed markings for gaze features. A feature listed as movable is merely allowed to move when a state needs it; do not require it to move in every animation or frame.` : ""} Return only {\"pairs\":[{\"pair\":\"horizontal-1\",\"A\":\"screen-left\",\"B\":\"screen-right\",\"reason\":\"visible landmark\"}]} and include every shown pair.` },
    ] }],
  }, { signal: input.signal, timeout: 180_000 });
  const message = raw as Anthropic.Message | string;
  const parsed = parseJsonObject(textFromMessage(message));
  const pairs = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).pairs)
    ? (parsed as { pairs: unknown[] }).pairs
    : [];
  return {
    pairs: pairs.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        pair: typeof row.pair === "string" ? row.pair : "",
        A: blindClass(row.A),
        B: blindClass(row.B),
        reason: typeof row.reason === "string" ? row.reason.slice(0, 300) : "",
      };
    }).filter((item) => item.pair),
    modelProvenance: modelProvenance(message, visual.requestedModel, visual.route),
  };
}

function majority(values: readonly BlindDirectionClass[]): BlindDirectionClass {
  const counts = new Map<BlindDirectionClass, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted[0] || sorted[0][1] < 2 || sorted[0][1] === sorted[1]?.[1]) return "ambiguous";
  return sorted[0][0];
}

export async function runBlindDirectionQa(input: {
  readonly sheet: Buffer;
  readonly answerKey: DirectionBlindAnswerKey;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly clientFactory?: () => Anthropic;
  readonly identityGuide?: string;
}): Promise<BlindDirectionValidation> {
  const env = input.env ?? process.env;
  const reviewers = await Promise.all(Array.from({ length: 3 }, () => oneBlindDirectionReview({
    sheet: input.sheet,
    env,
    signal: input.signal,
    client: input.clientFactory?.(),
    identityGuide: input.identityGuide,
  })));
  const failures: string[] = [];
  const warnings: string[] = [];
  const consensus = input.answerKey.pairs.map((answer) => {
    const votes = reviewers.map((reviewer) => reviewer.pairs.find((pair) => pair.pair === answer.pair));
    const A = majority(votes.map((vote) => vote?.A ?? "ambiguous"));
    const B = majority(votes.map((vote) => vote?.B ?? "ambiguous"));
    const mismatches = [A !== answer.A.expected ? `A=${A}, expected=${answer.A.expected}` : "", B !== answer.B.expected ? `B=${B}, expected=${answer.B.expected}` : ""].filter(Boolean);
    if (mismatches.length > 0) {
      const message = `${answer.pair}: ${mismatches.join("; ")}`;
      if (answer.cardinal) failures.push(message);
      else warnings.push(message);
    }
    return { pair: answer.pair, A, B, reason: votes.map((vote) => vote?.reason).filter(Boolean).join(" | ").slice(0, 600) };
  });
  const provenance = reviewers.map((reviewer) => reviewer.modelProvenance);
  return {
    ok: failures.length === 0,
    reviewers: reviewers.map(({ pairs }) => ({ pairs })),
    consensus,
    failures,
    warnings,
    modelProvenance: {
      requestedModel: provenance[0]!.requestedModel,
      actualModels: [...new Set(provenance.map((value) => value.actualModel))],
      route: provenance[0]!.route,
    },
  };
}

export async function runLabeledDirectionSemantics(input: {
  readonly sheet: Buffer;
  readonly expectedDirections: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly identityGuide?: string;
}): Promise<readonly DirectionSemanticVerdict[]> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const raw = await visual.client.messages.create({
    model: visual.requestedModel,
    max_tokens: 3000,
    temperature: 0,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.sheet.toString("base64") } },
      { type: "text", text: `Review the labeled neutral plus 16 Codex-pet look poses at displayed size as one clockwise loop. Expected order: ${input.expectedDirections.join(", ")}.${input.identityGuide?.trim() ? ` Approved canonical anatomy guide: ${input.identityGuide.trim()} Use it to identify the real eyes, mouth and movable anatomy; do not interpret fixed markings as gaze features. A feature listed as movable is merely allowed to move when a state needs it; do not require it to move in every animation or frame.` : ""} Return only {"directions":[{"direction":"000","verdict":"pass|warning|fail","expected":"up","observed":"...","horizontalEvidence":"...","verticalEvidence":"...","reason":"..."}]}. Include every direction exactly once. Fail wrong/ambiguous cardinals, wrong quadrant, reversal, visible snap, identity/scale/registration change. Subtle intermediate cues may be warnings.` },
    ] }],
  }, { signal: input.signal, timeout: 180_000 });
  const message = raw as Anthropic.Message | string;
  const provenance = modelProvenance(message, visual.requestedModel, visual.route);
  const parsed = parseJsonObject(textFromMessage(message));
  const rawDirections = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).directions)
    ? (parsed as { directions: unknown[] }).directions
    : [];
  const byDirection = new Map(rawDirections.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const direction = typeof row.direction === "string" ? row.direction : "";
    const verdict = ["pass", "warning", "fail"].includes(String(row.verdict)) ? row.verdict as DirectionSemanticVerdict["verdict"] : "fail";
    const text = (key: string) => typeof row[key] === "string" ? String(row[key]).slice(0, 400) : "";
    return [direction, { direction, verdict, expected: text("expected"), observed: text("observed"), horizontalEvidence: text("horizontalEvidence"), verticalEvidence: text("verticalEvidence"), reason: text("reason"), modelProvenance: provenance }] as const;
  }));
  return input.expectedDirections.map((direction) => byDirection.get(direction) ?? {
    direction,
    verdict: "fail" as const,
    expected: direction,
    observed: "missing verdict",
    horizontalEvidence: "",
    verticalEvidence: "",
    reason: "QA response omitted this direction",
    modelProvenance: provenance,
  });
}
