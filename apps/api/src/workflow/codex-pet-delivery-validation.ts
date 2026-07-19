import { LOOK_DIRECTIONS } from "@ai-assistant/codex-pet-pipeline";
import {
  CODEX_PET_MODEL_CONTRACT_VERSION,
  CODEX_PET_VISUAL_QA_MODEL,
  isAllowedCodexPetImageModel,
  isAllowedCodexPetVisualModel,
} from "./codex-pet-model-contract.js";

type JsonRecord = Record<string, unknown>;

const REQUIRED_OK_GATES = [
  "deterministic",
  "standardAtlasValidation",
  "packagedSpritesheet",
  "chromaDespill",
  "directionRegistration",
  "directionContinuity",
  "blindDirectionValidation",
] as const;

const REQUIRED_PASSED_GATES = [
  "row9PreGenerationGate",
  "row10PreGenerationGate",
] as const;

const EXPECTED_DIRECTIONS = new Set<string>(LOOK_DIRECTIONS);
const REQUIRED_IMAGE_MODEL = "gpt-image-2";
const REQUIRED_VISUAL_QA_MODEL = CODEX_PET_VISUAL_QA_MODEL;

function recordOf(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function hasContradictoryFailure(value: JsonRecord): boolean {
  return value.ok === false
    || value.pass === false
    || value.passed === false
    || value.status === "failed"
    || value.validationStatus === "failed";
}

/**
 * The durable delivery contract shared by knowledge archival, install links,
 * downloads, and signed install-image reads. It deliberately accepts only the
 * complete report currently emitted by the runner; a legacy/minimal
 * `{ ok: true, spriteVersionNumber: 2 }` report is not delivery evidence.
 */
export function codexPetValidationPassed(report: unknown): boolean {
  const value = recordOf(report);
  if (value.ok !== true
    || value.spriteVersionNumber !== 2
    || value.modelContractVersion !== CODEX_PET_MODEL_CONTRACT_VERSION
    || hasContradictoryFailure(value)) return false;

  const provenance = recordOf(value.modelProvenance);
  const imageGeneration = recordOf(provenance.imageGeneration);
  const visualQa = recordOf(provenance.visualQa);
  const imageActualModels = Array.isArray(imageGeneration.actualModels)
    ? imageGeneration.actualModels.filter((model): model is string => typeof model === "string")
    : [];
  const visualActualModels = Array.isArray(visualQa.actualModels)
    ? visualQa.actualModels.filter((model): model is string => typeof model === "string")
    : [];
  const visualRoutes = Array.isArray(visualQa.routes)
    ? visualQa.routes.filter((route): route is string => typeof route === "string")
    : [];
  if (imageGeneration.requestedModel !== REQUIRED_IMAGE_MODEL
    || imageActualModels.length === 0
    || imageActualModels.some((model) => !isAllowedCodexPetImageModel(model))
    || visualQa.requestedModel !== REQUIRED_VISUAL_QA_MODEL
    || visualActualModels.length === 0
    || visualActualModels.some((model) => !isAllowedCodexPetVisualModel(model))
    || visualRoutes.length === 0
    || visualRoutes.some((route) => route !== "chatgpt_model_route")) return false;

  for (const key of REQUIRED_OK_GATES) {
    const gate = recordOf(value[key]);
    if (gate.ok !== true || hasContradictoryFailure(gate)) return false;
  }

  for (const key of REQUIRED_PASSED_GATES) {
    const gate = recordOf(value[key]);
    if (gate.passed !== true || hasContradictoryFailure(gate)) return false;
  }

  const finalVisualQa = recordOf(value.finalVisualQa);
  if (finalVisualQa.pass !== true
    || finalVisualQa.identity !== true
    || finalVisualQa.structure !== true
    || finalVisualQa.semantics !== true
    || finalVisualQa.continuity !== true
    || hasContradictoryFailure(finalVisualQa)) return false;

  const semantics = value.directionSemantics;
  if (!Array.isArray(semantics) || semantics.length !== LOOK_DIRECTIONS.length) return false;

  const seen = new Set<string>();
  for (const rawEntry of semantics) {
    const entry = recordOf(rawEntry);
    const direction = entry.direction;
    const verdict = entry.verdict;
    if (typeof direction !== "string"
      || !EXPECTED_DIRECTIONS.has(direction)
      || seen.has(direction)
      || (verdict !== "pass" && verdict !== "warning")) return false;
    seen.add(direction);
  }

  return seen.size === LOOK_DIRECTIONS.length;
}
