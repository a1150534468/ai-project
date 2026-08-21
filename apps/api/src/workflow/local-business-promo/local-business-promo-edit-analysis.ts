import type Anthropic from "@anthropic-ai/sdk";
import {
  callMiniMaxMessages,
  type ContentBlock,
} from "../_shared/video-multimodal.js";
import type {
  LocalBusinessPromoShotPlanEntry,
} from "./local-business-promo-core.js";
import { buildFallbackShotAnalysis, pickVideoRange } from "./local-business-promo-edit-analysis-fallback.js";
import { buildLocalBusinessPromoAnalysisBlocks } from "./local-business-promo-edit-analysis-media.js";
import {
  analysisSystemPrompt,
  clampSelectedVideoRange,
  parseShotAnalysis,
  type AnalyzeLocalBusinessPromoShotInput,
  type LocalBusinessPromoEditPlanSnapshot,
  type LocalBusinessPromoShotAnalysis,
} from "./local-business-promo-edit-analysis-types.js";

const EDIT_ANALYSIS_MAX_TOKENS = 2200;
const ANALYSIS_RETRY_ATTEMPTS = 2;
const ANALYSIS_ATTEMPT_TIMEOUT_MS = 20_000;
const ANALYSIS_RETRY_DELAY_MS = 1_500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalAnalysisTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("local-business-promo shot analysis timed out");
}

async function callShotAnalysisRequest(args: {
  readonly client: Anthropic;
  readonly system: string;
  readonly blocks: ContentBlock[];
}): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYSIS_ATTEMPT_TIMEOUT_MS);
  try {
    return await callMiniMaxMessages({
      client: args.client,
      system: args.system,
      blocks: args.blocks,
      maxTokens: EDIT_ANALYSIS_MAX_TOKENS,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("local-business-promo shot analysis timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeLocalBusinessPromoShot(
  input: AnalyzeLocalBusinessPromoShotInput,
): Promise<{
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly snapshot: LocalBusinessPromoEditPlanSnapshot["shots"][number];
}> {
  if (input.shot.materials.length === 0) {
    throw new Error(`镜头「${input.shot.label}」缺少可用素材`);
  }
  const blocks = await buildLocalBusinessPromoAnalysisBlocks({
    materials: input.shot.materials,
    fetchFn: input.fetchFn,
  });
  let lastError: unknown;
  let analysis: LocalBusinessPromoShotAnalysis | null = null;
  for (let attempt = 1; attempt <= ANALYSIS_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await callShotAnalysisRequest({
        client: input.client,
        system: analysisSystemPrompt(input),
        blocks,
      });
      analysis = parseShotAnalysis(response.text);
      break;
    } catch (error) {
      lastError = error;
      if (isLocalAnalysisTimeout(error)) break;
      if (attempt < ANALYSIS_RETRY_ATTEMPTS) {
        await wait(ANALYSIS_RETRY_DELAY_MS * attempt);
      }
    }
  }
  if (!analysis) {
    analysis = buildFallbackShotAnalysis(input.shot, lastError, input.priorSelections ?? []);
  }
  let selectedMaterial = input.shot.materials[analysis.selectedIndex - 1];
  if (!selectedMaterial) {
    analysis = buildFallbackShotAnalysis(
      input.shot,
      new Error(`镜头「${input.shot.label}」的素材选择结果无效`),
      input.priorSelections ?? [],
    );
    selectedMaterial = input.shot.materials[analysis.selectedIndex - 1];
  }
  if (!selectedMaterial) {
    throw new Error(`镜头「${input.shot.label}」缺少可执行素材`);
  }
  if (selectedMaterial.mime.startsWith("video/")) {
    const clamped = clampSelectedVideoRange(selectedMaterial, input.shot.durationSec, analysis);
    const deduped = pickVideoRange({
      material: selectedMaterial,
      shot: input.shot,
      priorSelections: input.priorSelections ?? [],
      preferredStartSec: clamped.sourceStartSec,
    });
    return {
      shot: {
        ...input.shot,
        selectedMaterialUrl: selectedMaterial.url,
        selectedMaterialName: selectedMaterial.name,
        selectedMaterialMime: selectedMaterial.mime,
        sourceStartSec: deduped.start,
        sourceEndSec: deduped.end,
        renderMode: "video-cut",
        subtitlePlacement: analysis.subtitlePlacement,
      },
      snapshot: {
        shotId: input.shot.shotId,
        rationale: analysis.rationale,
        materialNotes: analysis.materialNotes,
      },
    };
  }
  return {
    shot: {
      ...input.shot,
      selectedMaterialUrl: selectedMaterial.url,
      selectedMaterialName: selectedMaterial.name,
        selectedMaterialMime: selectedMaterial.mime,
        sourceStartSec: 0,
        sourceEndSec: 0,
        renderMode: "image-pan",
        subtitlePlacement: analysis.subtitlePlacement,
      },
      snapshot: {
        shotId: input.shot.shotId,
        rationale: analysis.rationale,
      materialNotes: analysis.materialNotes,
    },
  };
}

export { buildLocalBusinessPromoAnalysisBlocks };
export type {
  AnalyzeLocalBusinessPromoShotInput,
  LocalBusinessPromoEditPlanSnapshot,
  LocalBusinessPromoShotAnalysis,
} from "./local-business-promo-edit-analysis-types.js";
