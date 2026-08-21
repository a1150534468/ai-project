import { Buffer } from "node:buffer";
import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import { buildBailianBaseURL } from "@ai-assistant/llm";
import type { DirectionBlindAnswerKey } from "@ai-assistant/codex-pet-pipeline";
import {
  DOUBAO_IMAGE_MODEL,
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

let petPipelineModule: Promise<typeof import("@ai-assistant/codex-pet-pipeline")> | null = null;

function loadPetPipeline(): Promise<typeof import("@ai-assistant/codex-pet-pipeline")> {
  petPipelineModule ??= import("@ai-assistant/codex-pet-pipeline");
  return petPipelineModule;
}

const SEEDREAM_CHROMA_NAMES: Readonly<Record<string, string>> = {
  "#ff00ff": "a perfectly flat solid hot-magenta chroma-key background",
  "#00ff00": "a perfectly flat solid bright-green chroma-key background",
  "#0000ff": "a perfectly flat solid pure-blue chroma-key background",
};

/** Seedream tends to render literal hex tokens as visible text. Keep those
 * tokens in the provider-neutral prompt for GPT/Qwen, but use natural-language
 * color instructions for Seedream while retaining the persisted key color. */
export function adaptCodexPetPromptForModel(prompt: string, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  if (model !== DOUBAO_IMAGE_MODEL && !normalizedModel.startsWith("doubao")) return prompt;
  const adapted = prompt.replace(/#[0-9a-f]{6}/gi, (value) => (
    SEEDREAM_CHROMA_NAMES[value.toLowerCase()] ?? "a perfectly flat solid chroma-key background"
  ));
  return `${adapted}\nSeedream production constraint: the chroma-key matte is only a background-removal aid. Never draw or print the color name, hex code, RGB values, labels, symbols, or any other text anywhere in the image. Do not add a ground plane, floor strip, contact shadow, cast shadow, glow, vignette, gradient, texture, lighting variation, or decorative background detail.`;
}
import {
  CodexPetModelContractError,
  CODEX_PET_VISUAL_QA_MODEL,
  codexPetVisualQaRouteForModel,
  isAllowedCodexPetImageProvenance,
  isAllowedCodexPetVisualModel,
  type CodexPetVisualQaRoute,
} from "./codex-pet-model-contract.js";
import { CODEX_PET_CARDINAL_APPEARANCE_CONTRACT } from "./codex-pet-prompts.js";

export const DEFAULT_CODEX_PET_VISUAL_QA_MODEL = CODEX_PET_VISUAL_QA_MODEL;
const DEFAULT_CODEX_PET_VISUAL_QA_BASE_URL = "https://api.ai-pixel.online";

export interface CodexPetVisualModelProvenance {
  readonly requestedModel: string;
  readonly actualModel: string;
  readonly route: CodexPetVisualQaRoute | "injected_test_client";
}

/** Resolve and validate the project-selected visual reasoning model. */
export function resolveCodexPetVisualQaModel(env: NodeJS.ProcessEnv, requestedModel?: string): string {
  const model = requestedModel?.trim()
    || env.PET_VISUAL_QA_MODEL?.trim()
    || DEFAULT_CODEX_PET_VISUAL_QA_MODEL;
  if (!isAllowedCodexPetVisualModel(model)) {
    throw new CodexPetModelContractError("PET_VISUAL_QA_MODEL must be an enabled non-qwen3.7 marketplace model");
  }
  return model;
}

/**
 * The shared LLM client intentionally falls back to its primary provider when
 * a model route is missing. That is useful for ordinary chat, but unsafe for
 * this selectable-model workflow because the primary provider may not match
 * the frozen model route. Fail before accepting work instead of sending a
 * selected model name to the wrong endpoint.
 */
export function assertCodexPetVisualQaRoute(env: NodeJS.ProcessEnv = process.env, requestedModel?: string): {
  readonly model: string;
  readonly baseURL: string;
} {
  const { model, baseURL } = loadCodexPetVisualQaRoute(env, requestedModel);
  return { model, baseURL };
}

function loadCodexPetVisualQaRoute(env: NodeJS.ProcessEnv, requestedModel?: string): {
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly route: CodexPetVisualQaRoute;
} {
  const model = resolveCodexPetVisualQaModel(env, requestedModel);
  const route = codexPetVisualQaRouteForModel(model, env);
  if (route === "bailian_model_route") {
    const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim() || "";
    const baseURL = env.BAILIAN_BASE_URL?.trim()
      || (workspaceId ? buildBailianBaseURL(workspaceId, env.BAILIAN_REGION ?? "cn-beijing") : "");
    const apiKey = env.BAILIAN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim() || "";
    if (!baseURL) throw new CodexPetModelContractError(`${model} requires BAILIAN_WORKSPACE_ID or BAILIAN_BASE_URL`);
    if (!apiKey) throw new CodexPetModelContractError(`${model} requires BAILIAN_API_KEY or DASHSCOPE_API_KEY`);
    assertHttpModelRoute(baseURL, "Bailian visual model route");
    return { model, baseURL, apiKey, route };
  }
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
  assertHttpModelRoute(baseURL, "CHATGPT_BASE_URL");
  return { model, baseURL, apiKey, route };
}

function assertHttpModelRoute(baseURL: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(baseURL); } catch {
    throw new CodexPetModelContractError(`${label} is invalid for the Codex pet workflow`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CodexPetModelContractError(`${label} must use HTTP(S) for the Codex pet workflow`);
  }
}

function codexPetVisualClient(env: NodeJS.ProcessEnv, injected?: Anthropic): {
  readonly client: Anthropic;
  readonly requestedModel: string;
  readonly route: CodexPetVisualModelProvenance["route"];
} {
  const requestedModel = resolveCodexPetVisualQaModel(env);
  if (injected) return { client: injected, requestedModel, route: "injected_test_client" };
  const route = loadCodexPetVisualQaRoute(env, requestedModel);
  return {
    // Use the exact selected route directly. The shared LLM client intentionally
    // owns a primary-provider fallback; that behavior is useful for ordinary
    // chat but is forbidden by the desktop-pet contract.
    client: new Anthropic({ baseURL: route.baseURL, apiKey: route.apiKey }),
    requestedModel,
    route: route.route,
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
  if (!isAllowedCodexPetVisualModel(requestedModel)
    || !isAllowedCodexPetVisualModel(actualModel)
    || actualModel !== requestedModel) {
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

function contradictsCardinalAppearance(direction: string, expected: string, observed: string): boolean {
  const statement = `${expected} ${observed}`.toLowerCase();
  const observedText = observed.toLowerCase();
  switch (direction) {
    case "000":
      return /\bfront(?:[- ]?(?:facing|view|portrait))\b|正面|正视/.test(statement)
        || /\bfront\b|正面|正视/.test(expected.toLowerCase())
        || /\bfront\b|正面|正视/.test(observedText);
    case "090":
      return /\b(?:screen[- ]?left|left[- ]?(?:facing|view|profile))\b|朝左|向左|左侧/.test(statement)
        || /\bleft\b|左侧|向左|朝左/.test(expected.toLowerCase())
        || /\bleft\b|左侧|向左|朝左/.test(observedText);
    case "180":
      return /\b(?:back|rear)(?:[- ]?(?:facing|view|portrait))\b|背面|后视/.test(statement)
        || /\b(?:back|rear)\b|背面|后视/.test(expected.toLowerCase())
        || /\b(?:back|rear)\b|背面|后视/.test(observedText);
    case "270":
      return /\b(?:screen[- ]?right|right[- ]?(?:facing|view|profile))\b|朝右|向右|右侧/.test(statement)
        || /\bright\b|右侧|向右|朝右/.test(expected.toLowerCase())
        || /\bright\b|右侧|向右|朝右/.test(observedText);
    default:
      return false;
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

export async function normalizeSeedreamChromaMatte(
  input: Buffer,
  originalPrompt: string,
  model: string,
): Promise<{ readonly buffer: Buffer; readonly mime: string }> {
  if (model !== DOUBAO_IMAGE_MODEL && !model.trim().toLowerCase().startsWith("doubao")) {
    return { buffer: input, mime: "" };
  }
  const keyToken = originalPrompt.match(/#[0-9a-f]{6}/i)?.[0];
  if (!keyToken) return { buffer: input, mime: "" };
  const sharp = await loadSharp();
  const { colorDistance, parseHexColor, removeChroma } = await loadPetPipeline();
  const key = parseHexColor(keyToken);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const border = Math.max(1, Math.floor(Math.min(info.width, info.height) * 0.02));
  const distances: number[] = [];
  const sample = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    distances.push(colorDistance({ r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! }, key));
  };
  const stride = Math.max(1, Math.floor(Math.max(info.width, info.height) / 512));
  for (let y = 0; y < info.height; y += stride) {
    for (let x = 0; x < info.width; x += stride) {
      if (x < border || x >= info.width - border || y < border || y >= info.height - border) sample(x, y);
    }
  }
  distances.sort((a, b) => a - b);
  const edgeDistance = distances[Math.floor(Math.max(0, distances.length - 1) * 0.995)] ?? 86;
  const threshold = Math.min(380, Math.max(86, Math.ceil(edgeDistance + 12)));
  const removed = await removeChroma(input, { key, threshold, feather: 20 });
  const coverage = removed.totalPixels > 0
    ? (removed.removedPixels + removed.softenedPixels) / removed.totalPixels
    : 0;
  if (coverage < 0.05 || coverage > 0.95) {
    throw new Error(`Seedream chroma normalization produced unsafe coverage: ${coverage.toFixed(4)}`);
  }
  const layout = originalPrompt.match(/(\d+)\s*columns?\s*[×x]\s*(\d+)\s*rows?/i)
    ?? originalPrompt.match(/(\d+)\s*[×x]\s*(\d+)\s*(?:pose\s+)?board/i);
  const columns = layout ? Number(layout[1]) : null;
  const rows = layout ? Number(layout[2]) : null;
  const targetWidth = info.width;
  const targetHeight = columns && rows && columns > 0 && rows > 0
    ? Math.max(1, Math.round(targetWidth * rows / columns))
    : info.height;
  let buffer: Buffer;
  if (columns && rows) {
    const composites: Array<{ readonly input: Buffer; readonly left: number; readonly top: number }> = [];
    const slotWidth = targetWidth / columns;
    const slotHeight = targetHeight / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const sourceLeft = Math.floor(column * info.width / columns);
        const sourceTop = Math.floor(row * info.height / rows);
        const sourceRight = Math.floor((column + 1) * info.width / columns);
        const sourceBottom = Math.floor((row + 1) * info.height / rows);
        const tile = await sharp(removed.image).extract({
          left: sourceLeft,
          top: sourceTop,
          width: sourceRight - sourceLeft,
          height: sourceBottom - sourceTop,
        }).png().toBuffer();
        const contentWidth = Math.max(1, Math.floor(slotWidth * 0.82));
        const contentHeight = Math.max(1, Math.floor(slotHeight * 0.82));
        const resized = await sharp(tile).resize({
          width: contentWidth,
          height: contentHeight,
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        }).png().toBuffer();
        composites.push({
          input: resized,
          left: Math.round(column * slotWidth + (slotWidth - contentWidth) / 2),
          top: Math.round(row * slotHeight + (slotHeight - contentHeight) / 2),
        });
      }
    }
    buffer = await sharp({
      create: { width: targetWidth, height: targetHeight, channels: 4, background: keyToken },
    }).composite(composites).png().toBuffer();
  } else {
    const resized = await sharp(removed.image).png().toBuffer();
    buffer = await sharp({
      create: { width: targetWidth, height: targetHeight, channels: 4, background: keyToken },
    }).composite([{ input: resized }]).png().toBuffer();
  }
  return { buffer, mime: "image/png" };
}

/**
 * Seedream frequently copies labels and dashed borders from a conventional
 * layout guide. Give it a safe, label-free construction reference instead:
 * one complete approved character per target slot on the real chroma matte.
 * This is guidance only; the generation prompt still owns every action pose.
 */
export async function createSeedreamPoseBoardScaffold(input: {
  readonly canonical: Buffer;
  /** Optional already-paid pose phases used only as construction evidence. */
  readonly poseVariants?: readonly Buffer[];
  /** Zero-based variant index for each target slot; defaults to round-robin. */
  readonly variantSequence?: readonly number[];
  readonly chromaKey: string;
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
  readonly width?: number;
  readonly height?: number;
}): Promise<Buffer> {
  const sharp = await loadSharp();
  const { parseHexColor, removeChroma } = await loadPetPipeline();
  // Seedream preserves the prompt's square target slots much more reliably
  // when the construction reference uses the same columns:rows aspect ratio.
  // A fixed 1536x1024 canvas is correct for 3x2 idle, but it turns a 4x2 gait
  // board into 3:2 and can make the provider split each character across rows.
  const width = input.width
    ?? (input.height ? Math.round(input.height * input.columns / input.rows) : 1536);
  const height = input.height ?? Math.round(width * input.rows / input.columns);
  if (!Number.isInteger(input.columns) || input.columns < 1
    || !Number.isInteger(input.rows) || input.rows < 1
    || !Number.isInteger(input.frameCount) || input.frameCount < 1
    || input.frameCount > input.columns * input.rows
    || !Number.isInteger(width) || width < 1
    || !Number.isInteger(height) || height < 1) {
    throw new Error("Seedream scaffold requires a valid positive layout and frame count");
  }
  if (Math.abs(width / input.columns - height / input.rows) > 1) {
    throw new Error("Seedream scaffold must use square slots matching the requested columns:rows aspect ratio");
  }
  const sources = input.poseVariants?.length ? [...input.poseVariants] : [input.canonical];
  const sequence = input.variantSequence
    ? [...input.variantSequence]
    : Array.from({ length: input.frameCount }, (_, index) => index % sources.length);
  if (sequence.length !== input.frameCount
    || sequence.some((value) => !Number.isInteger(value) || value < 0 || value >= sources.length)) {
    throw new Error("Seedream scaffold variant sequence must select one available pose per frame");
  }

  const trimmedVariants = await Promise.all(sources.map(async (source) => {
    const removed = await removeChroma(source, {
      key: parseHexColor(input.chromaKey),
      threshold: 96,
      feather: 16,
    });
    return sharp(removed.image)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }));
  const composites: Array<{ readonly input: Buffer; readonly left: number; readonly top: number }> = [];
  for (let index = 0; index < input.frameCount; index += 1) {
    const column = index % input.columns;
    const row = Math.floor(index / input.columns);
    const slotLeft = Math.floor(column * width / input.columns);
    const slotRight = Math.floor((column + 1) * width / input.columns);
    const slotTop = Math.floor(row * height / input.rows);
    const slotBottom = Math.floor((row + 1) * height / input.rows);
    const slotWidth = slotRight - slotLeft;
    const slotHeight = slotBottom - slotTop;
    const contentWidth = Math.max(1, Math.floor(slotWidth * 0.64));
    const contentHeight = Math.max(1, Math.floor(slotHeight * 0.72));
    const sprite = await sharp(trimmedVariants[sequence[index]!]!).resize({
      width: contentWidth,
      height: contentHeight,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png({ compressionLevel: 9 }).toBuffer();
    composites.push({
      input: sprite,
      left: slotLeft + Math.floor((slotWidth - contentWidth) / 2),
      top: slotTop + Math.floor(slotHeight * 0.1),
    });
  }
  return sharp({
    create: { width, height, channels: 4, background: input.chromaKey },
  }).composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

/** Pick one stable first phase and the most visually distinct paid phase. */
export async function selectSeedreamGaitScaffoldVariants(
  frames: readonly Buffer[],
): Promise<readonly [Buffer, Buffer]> {
  if (frames.length < 2) throw new Error("Seedream gait scaffold requires at least two source phases");
  const sharp = await loadSharp();
  const decoded = await Promise.all(frames.map((frame) => (
    sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  )));
  const anchor = decoded[0]!;
  let selectedIndex = 1;
  let selectedScore = -1;
  for (let index = 1; index < decoded.length; index += 1) {
    const candidate = decoded[index]!;
    if (candidate.info.width !== anchor.info.width
      || candidate.info.height !== anchor.info.height
      || candidate.info.channels !== anchor.info.channels) {
      throw new Error("Seedream gait scaffold phases must share one normalized geometry");
    }
    let score = 0;
    for (let offset = 0; offset < anchor.data.length; offset += 1) {
      score += Math.abs(anchor.data[offset]! - candidate.data[offset]!);
    }
    if (score > selectedScore) {
      selectedScore = score;
      selectedIndex = index;
    }
  }
  return [frames[0]!, frames[selectedIndex]!];
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
  readonly onRequestDispatching?: (attempt: number) => Promise<void> | void;
  readonly onRequestSent?: (attempt: number) => Promise<void> | void;
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
              onRequestDispatching: () => input.onRequestDispatching?.(attempt),
              onRequestSent: () => input.onRequestSent?.(attempt),
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
              onRequestDispatching: () => input.onRequestDispatching?.(attempt),
              onRequestSent: () => input.onRequestSent?.(attempt),
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

function textFromMessage(message: Anthropic.Message | string): string {
  const parsed = typeof message === "string" ? JSON.parse(message) as Anthropic.Message : message;
  return parsed.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("").trim();
}

function retryableCodexPetVisualError(error: unknown): boolean {
  if (error instanceof CodexPetModelContractError) return false;
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; status?: unknown; code?: unknown };
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const status = typeof record.status === "number" ? record.status : null;
  if (status !== null) return status === 408 || status === 409 || status === 429 || status >= 500;
  return name.includes("connection")
    || name.includes("timeout")
    || code.includes("timeout")
    || ["econnreset", "econnrefused", "enotfound", "eai_again"].includes(code);
}

function codexPetVisualRetryDelayMs(attempt: number, env: NodeJS.ProcessEnv): number {
  const configured = Number(env.CODEX_PET_VISUAL_RETRY_BASE_MS);
  const base = Number.isFinite(configured) && configured >= 0 ? Math.min(30_000, configured) : 5_000;
  return Math.min(30_000, base * 3 ** Math.max(0, attempt - 1));
}

async function createCodexPetVisualMessage(
  visual: ReturnType<typeof codexPetVisualClient>,
  params: Parameters<Anthropic["messages"]["create"]>[0],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeout: number;
  },
): Promise<Anthropic.Message | string> {
  const configuredAttempts = Number(options.env.CODEX_PET_VISUAL_MAX_ATTEMPTS);
  const maxAttempts = Number.isInteger(configuredAttempts) && configuredAttempts > 0
    ? Math.min(3, configuredAttempts)
    : 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await visual.client.messages.create(params, {
        signal: options.signal,
        timeout: options.timeout,
        maxRetries: 0,
      }) as Anthropic.Message | string;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || options.signal?.aborted || !retryableCodexPetVisualError(error)) throw error;
      await wait(codexPetVisualRetryDelayMs(attempt, options.env), options.signal);
    }
  }
  throw lastError;
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
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 1200,
    temperature: 0,
    messages: [{ role: "user", content: blocks as unknown as Anthropic.MessageParam["content"] }],
  }, { env, signal: input.signal, timeout: 180_000 });
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
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 500,
    temperature: 0.2,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.reference.toString("base64") } },
      { type: "text", text: input.prompt },
    ] }],
  }, { env, signal: input.signal, timeout: 120_000 });
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
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 650,
    temperature: 0,
    messages: [{ role: "user", content }],
  }, { env, signal: input.signal, timeout: 120_000 });
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
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 2200,
    temperature: 0,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.sheet.toString("base64") } },
      { type: "text", text: `Classify every unlabeled Codex-pet A/B pair. Use only the axis named in each row. For horizontal use screen-left, screen-right, or ambiguous. For vertical use up, down, or ambiguous. Never infer from A/B order.${input.identityGuide?.trim() ? ` Approved canonical anatomy guide: ${input.identityGuide.trim()} Use it only to identify the character's real eyes, mouth and movable anatomy instead of mistaking fixed markings for gaze features. A feature listed as movable is merely allowed to move when a state needs it; do not require it to move in every animation or frame.` : ""} Return only {\"pairs\":[{\"pair\":\"horizontal-1\",\"A\":\"screen-left\",\"B\":\"screen-right\",\"reason\":\"visible landmark\"}]} and include every shown pair.` },
    ] }],
  }, { env: input.env, signal: input.signal, timeout: 180_000 });
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
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 3000,
    temperature: 0,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.sheet.toString("base64") } },
      { type: "text", text: `Review the labeled neutral plus 16 Codex-pet look poses at displayed size as one clockwise loop. Expected order: ${input.expectedDirections.join(", ")}. ${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT}${input.identityGuide?.trim() ? ` Approved canonical anatomy guide: ${input.identityGuide.trim()} Use it to identify the real eyes, mouth and movable anatomy; do not interpret fixed markings as gaze features. A feature listed as movable is merely allowed to move when a state needs it; do not require it to move in every animation or frame.` : ""} Return only {"directions":[{"direction":"000","verdict":"pass|warning|fail","expected":"up","observed":"...","horizontalEvidence":"...","verticalEvidence":"...","reason":"..."}]}. Include every direction exactly once. Fail wrong/ambiguous cardinals, wrong quadrant, reversal, visible snap, identity/scale/registration change. Subtle intermediate cues may be warnings.` },
    ] }],
  }, { env, signal: input.signal, timeout: 180_000 });
  const provenance = modelProvenance(message, visual.requestedModel, visual.route);
  const parsed = parseJsonObject(textFromMessage(message));
  const rawDirections = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).directions)
    ? (parsed as { directions: unknown[] }).directions
    : [];
  const byDirection = new Map(rawDirections.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const direction = typeof row.direction === "string" ? row.direction : "";
    const text = (key: string) => typeof row[key] === "string" ? String(row[key]).slice(0, 400) : "";
    const expected = text("expected");
    const observed = text("observed");
    const reportedVerdict = ["pass", "warning", "fail"].includes(String(row.verdict))
      ? row.verdict as DirectionSemanticVerdict["verdict"]
      : "fail";
    const contradiction = contradictsCardinalAppearance(direction, expected, observed);
    const reason = contradiction
      ? `Rejected stale cardinal semantics for ${direction}: ${text("reason") || observed}`.slice(0, 400)
      : text("reason");
    return [direction, {
      direction,
      verdict: contradiction ? "fail" as const : reportedVerdict,
      expected,
      observed,
      horizontalEvidence: text("horizontalEvidence"),
      verticalEvidence: text("verticalEvidence"),
      reason,
      modelProvenance: provenance,
    }] as const;
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
