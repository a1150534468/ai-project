import {
  GPT_IMAGE_MODEL,
  loadGptImageEditEndpoint,
  loadImageGenerationConfigForModel,
} from "./image-service.js";

export const CODEX_PET_MODEL_CONTRACT_VERSION = "gpt-only-v1";
export const CODEX_PET_VISUAL_QA_MODEL = "gpt-5.6-sol";

/**
 * A non-retryable violation of the workflow's persisted GPT-only contract.
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
 * such as `gpt-image-2-qwen-fallback`, defeating the product's GPT-only
 * contract and making persisted provenance untrustworthy.
 */
export const CODEX_PET_IMAGE_MODEL_ALLOWLIST = new Set<string>([
  GPT_IMAGE_MODEL,
  "gpt-image-2-codex",
]);

export const CODEX_PET_VISUAL_MODEL_ALLOWLIST = new Set<string>([
  CODEX_PET_VISUAL_QA_MODEL,
]);

export function isAllowedCodexPetImageModel(model: string): boolean {
  return CODEX_PET_IMAGE_MODEL_ALLOWLIST.has(model.trim());
}

export function isAllowedCodexPetVisualModel(model: string): boolean {
  return CODEX_PET_VISUAL_MODEL_ALLOWLIST.has(model.trim());
}

export function assertCodexPetImageRoute(env: NodeJS.ProcessEnv = process.env): {
  readonly model: string;
  readonly generationEndpoint: string;
  readonly editEndpoint: string;
} {
  const config = loadImageGenerationConfigForModel(GPT_IMAGE_MODEL, env);
  const editApiKey = env.GPT_IMAGE_EDIT_API_KEY?.trim() || config.apiKey;
  if (!editApiKey) throw new CodexPetModelContractError("GPT_IMAGE_EDIT_API_KEY or GPT_IMAGE_API_KEY is required for Codex pet edits");
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
