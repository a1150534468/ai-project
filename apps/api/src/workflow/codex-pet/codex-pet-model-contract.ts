import { parseChatgptModelList } from "@ai-assistant/llm";
import {
  GPT_IMAGE_MODEL,
  loadGptImageEditEndpoint,
  loadImageGenerationConfigForModel,
} from "../_shared/image-service.js";

export const CODEX_PET_MODEL_CONTRACT_VERSION = "gpt-only-quality-optional-v3";
export const CODEX_PET_VISUAL_QA_MODEL = "gpt-5.6-sol";
export const CODEX_PET_BAILIAN_VISUAL_QA_MODEL = "qwen3.6-flash";
export const CODEX_PET_VISUAL_QA_MODELS = [
  CODEX_PET_VISUAL_QA_MODEL,
  CODEX_PET_BAILIAN_VISUAL_QA_MODEL,
] as const;
export type CodexPetVisualQaModel = typeof CODEX_PET_VISUAL_QA_MODELS[number];
export type CodexPetVisualQaRoute = "chatgpt_model_route" | "bailian_model_route";

/**
 * A non-retryable violation of the workflow's persisted model-selection contract.
 * Callers use this distinction to avoid repeating an image or QA task against
 * a provider that reported the wrong (or no) model.
 */
export class CodexPetModelContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPetModelContractError";
  }
}

/**
 * Keep relay aliases explicit. Prefix matching would accept misleading names
 * such as `gpt-image-2-qwen-fallback`, defeating the selected-model contract
 * and making persisted provenance untrustworthy.
 */
export const CODEX_PET_IMAGE_MODELS = [GPT_IMAGE_MODEL] as const;
export const CODEX_PET_IMAGE_MODEL_ALLOWLIST = new Set<string>(CODEX_PET_IMAGE_MODELS);
export const CODEX_PET_IMAGE_PROVENANCE_ALLOWLIST = new Set<string>([
  GPT_IMAGE_MODEL,
  "gpt-image-2-codex",
]);

export const CODEX_PET_VISUAL_MODEL_ALLOWLIST = new Set<string>([
  ...CODEX_PET_VISUAL_QA_MODELS,
]);

export function isAllowedCodexPetImageModel(model: string): boolean {
  return CODEX_PET_IMAGE_MODEL_ALLOWLIST.has(model.trim());
}

export function isAllowedCodexPetImageProvenance(model: string): boolean {
  return CODEX_PET_IMAGE_PROVENANCE_ALLOWLIST.has(model.trim());
}

export function isAllowedCodexPetVisualModel(model: string): boolean {
  const normalized = model.trim();
  // The marketplace is the source of truth for selectable visual models. The
  // only hard exclusion here is qwen3.7, whose local quota is unavailable and
  // must never be selected accidentally by an old/default configuration.
  return normalized.length > 0
    && normalized.length <= 128
    && !normalized.toLowerCase().includes("embedding")
    && !normalized.toLowerCase().startsWith("qwen3.7");
}

export function codexPetVisualQaRouteForModel(model: string, env: NodeJS.ProcessEnv = process.env): CodexPetVisualQaRoute {
  const normalized = model.trim();
  if (!isAllowedCodexPetVisualModel(normalized)) {
    throw new CodexPetModelContractError(`Unsupported Codex pet visual model: ${normalized || "empty"}`);
  }
  const gptModels = parseChatgptModelList(env);
  if (gptModels.includes(normalized)
    || normalized === CODEX_PET_VISUAL_QA_MODEL
    || normalized === "codex-auto-review"
    || normalized.startsWith("gpt-")) {
    return "chatgpt_model_route";
  }
  return "bailian_model_route";
}

export function assertCodexPetImageRoute(env: NodeJS.ProcessEnv = process.env, requestedModel = GPT_IMAGE_MODEL): {
  readonly model: string;
  readonly generationEndpoint: string;
  readonly editEndpoint: string;
} {
  if (!isAllowedCodexPetImageModel(requestedModel)) {
    throw new CodexPetModelContractError(`Unsupported Codex pet image model: ${requestedModel}`);
  }
  const config = loadImageGenerationConfigForModel(requestedModel, env);
  const editApiKey = env.GPT_IMAGE_EDIT_API_KEY?.trim() || config.apiKey;
  if (!editApiKey) throw new CodexPetModelContractError("图片编辑所需的模型 API Key 未配置");
  const editEndpoint = loadGptImageEditEndpoint(env, config.endpoint);
  for (const [label, endpoint] of [["generation", config.endpoint], ["edit", editEndpoint]] as const) {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new CodexPetModelContractError(`Codex pet GPT Image ${label} endpoint is invalid`); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new CodexPetModelContractError(`Codex pet GPT Image ${label} endpoint must use HTTP(S)`);
    }
  }
  return { model: config.model, generationEndpoint: config.endpoint, editEndpoint };
}
