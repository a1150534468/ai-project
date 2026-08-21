import type {
  LocalBusinessPromoMaterial,
  LocalBusinessPromoShotPlanEntry,
  LocalBusinessPromoSubtitlePlacement,
} from "./local-business-promo-core.js";
import type { LocalBusinessPromoShotAnalysis } from "./local-business-promo-edit-analysis-types.js";

function fallbackStartRatio(materialGroup: LocalBusinessPromoShotPlanEntry["materialGroup"]): number {
  if (materialGroup === "opening") return 0.08;
  if (materialGroup === "process") return 0.38;
  if (materialGroup === "environment") return 0.22;
  return 0.68;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd) - 0.2;
}

function sameMaterial(
  selection: Pick<LocalBusinessPromoShotPlanEntry, "selectedMaterialUrl" | "selectedMaterialMime">,
  material: LocalBusinessPromoMaterial,
): boolean {
  return selection.selectedMaterialUrl === material.url && selection.selectedMaterialMime === material.mime;
}

function usedSelectionsForMaterial(
  material: LocalBusinessPromoMaterial,
  priorSelections: readonly LocalBusinessPromoShotPlanEntry[],
): readonly LocalBusinessPromoShotPlanEntry[] {
  return priorSelections.filter((selection) => sameMaterial(selection, material));
}

function videoRangePenalty(args: {
  readonly start: number;
  readonly end: number;
  readonly usedSelections: readonly LocalBusinessPromoShotPlanEntry[];
}): number {
  return args.usedSelections.reduce((score, selection) => {
    if (selection.renderMode !== "video-cut") return score;
    const usedStart = Math.max(0, selection.sourceStartSec ?? 0);
    const usedEnd = Math.max(usedStart + 0.5, selection.sourceEndSec ?? usedStart + 0.5);
    if (!rangesOverlap(args.start, args.end, usedStart, usedEnd)) return score;
    return score + Math.min(args.end, usedEnd) - Math.max(args.start, usedStart) + 1;
  }, 0);
}

function preferredStartRatios(shot: LocalBusinessPromoShotPlanEntry): number[] {
  const base = fallbackStartRatio(shot.materialGroup);
  const presets = shot.materialGroup === "opening"
    ? [base, 0.18, 0.32, 0.5, 0.72]
    : shot.materialGroup === "process"
      ? [base, 0.5, 0.24, 0.68, 0.82]
      : shot.materialGroup === "environment"
        ? [base, 0.12, 0.46, 0.66, 0.84]
        : [base, 0.72, 0.52, 0.32, 0.12];
  return Array.from(new Set(presets.map((value) => Number(value.toFixed(2)))));
}

function gapAnchors(durationSec: number, usedSelections: readonly LocalBusinessPromoShotPlanEntry[]): number[] {
  const videoRanges = usedSelections
    .filter((selection) => selection.renderMode === "video-cut")
    .map((selection) => ({
      start: Math.max(0, selection.sourceStartSec ?? 0),
      end: Math.max((selection.sourceStartSec ?? 0) + 0.5, selection.sourceEndSec ?? 0),
    }))
    .sort((left, right) => left.start - right.start);
  if (videoRanges.length === 0) return [];
  const anchors: number[] = [];
  let cursor = 0;
  for (const range of videoRanges) {
    if (range.start - cursor >= 0.75) {
      anchors.push(Number(((cursor + range.start) / 2).toFixed(2)));
    }
    cursor = Math.max(cursor, range.end);
  }
  if (durationSec - cursor >= 0.75) {
    anchors.push(Number(((cursor + durationSec) / 2).toFixed(2)));
  }
  return anchors;
}

export function pickVideoRange(args: {
  readonly material: LocalBusinessPromoMaterial;
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly priorSelections: readonly LocalBusinessPromoShotPlanEntry[];
  readonly preferredStartSec?: number | null;
}): { start: number; end: number; overlapPenalty: number } {
  const durationSec = Math.max(0, args.material.durationSec || 0);
  if (durationSec <= 0) {
    return { start: 0, end: 0, overlapPenalty: 0 };
  }
  const clipDuration = Math.max(0.5, Math.min(args.shot.durationSec, durationSec));
  const maxStart = Math.max(0, durationSec - clipDuration);
  const usedSelections = usedSelectionsForMaterial(args.material, args.priorSelections);
  const anchors = [
    ...(args.preferredStartSec != null ? [args.preferredStartSec] : []),
    ...preferredStartRatios(args.shot).map((ratio) => maxStart * ratio),
    ...gapAnchors(durationSec, usedSelections),
    0,
    maxStart,
  ];
  const uniqueAnchors = Array.from(new Set(anchors.map((value) => Number(Math.max(0, Math.min(maxStart, value)).toFixed(2)))));
  let best: { start: number; end: number; overlapPenalty: number; distance: number } | null = null;
  for (const candidateStart of uniqueAnchors) {
    const candidateEnd = Number(Math.min(durationSec, Math.max(candidateStart + 0.5, candidateStart + clipDuration)).toFixed(2));
    const penalty = videoRangePenalty({ start: candidateStart, end: candidateEnd, usedSelections });
    const distance = args.preferredStartSec == null ? 0 : Math.abs(candidateStart - args.preferredStartSec);
    if (!best
      || penalty < best.overlapPenalty
      || (penalty === best.overlapPenalty && distance < best.distance)
      || (penalty === best.overlapPenalty && distance === best.distance && candidateStart < best.start)) {
      best = { start: candidateStart, end: candidateEnd, overlapPenalty: penalty, distance };
    }
  }
  return {
    start: best?.start ?? 0,
    end: best?.end ?? Number(Math.min(durationSec, clipDuration).toFixed(2)),
    overlapPenalty: best?.overlapPenalty ?? 0,
  };
}

function scoreFallbackMaterial(args: {
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly material: LocalBusinessPromoMaterial;
  readonly index: number;
  readonly priorSelections: readonly LocalBusinessPromoShotPlanEntry[];
}): number {
  const orderedScore = Math.max(0, (args.shot.materials.length - args.index) * 5);
  const usedSelections = usedSelectionsForMaterial(args.material, args.priorSelections);
  if (args.material.mime.startsWith("video/")) {
    const clip = pickVideoRange({
      material: args.material,
      shot: args.shot,
      priorSelections: args.priorSelections,
    });
    const durationBonus = Math.min(6, Math.max(0, (args.material.durationSec || 0) - args.shot.durationSec + 2));
    return orderedScore + 16 + durationBonus - (usedSelections.length * 7) - (clip.overlapPenalty * 10);
  }
  return orderedScore + 4 - (usedSelections.length * 12);
}

function fallbackMaterialNotes(materials: readonly LocalBusinessPromoMaterial[]): LocalBusinessPromoShotAnalysis["materialNotes"] {
  return materials.map((material, index) => ({
    index: index + 1,
    description: `${material.mime.startsWith("video/") ? "视频" : "图片"}「${material.name.trim() || `素材${index + 1}`}」`,
  }));
}

function fallbackSubtitlePlacement(shot: LocalBusinessPromoShotPlanEntry): LocalBusinessPromoSubtitlePlacement {
  if (shot.materialGroup === "process" || shot.materialGroup === "result") return "top";
  return "bottom";
}

export function buildFallbackShotAnalysis(
  shot: LocalBusinessPromoShotPlanEntry,
  error: unknown,
  priorSelections: readonly LocalBusinessPromoShotPlanEntry[] = [],
): LocalBusinessPromoShotAnalysis {
  const rankedMaterials = shot.materials
    .map((material, index) => ({
      material,
      index: index + 1,
      score: scoreFallbackMaterial({
        shot,
        material,
        index,
        priorSelections,
      }),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selectedIndex = rankedMaterials[0]?.index ?? 1;
  const selectedMaterial = shot.materials[selectedIndex - 1] ?? shot.materials[0];
  const materialNotes = fallbackMaterialNotes(shot.materials);
  const reason = error instanceof Error ? error.message : "多模态分析不可用";
  if (selectedMaterial?.mime.startsWith("video/")) {
    const clip = pickVideoRange({
      material: selectedMaterial,
      shot,
      priorSelections,
    });
    return {
      materialNotes,
      selectedIndex,
      sourceStartSec: clip.start,
      sourceEndSec: clip.end,
      renderMode: "video-cut",
      subtitlePlacement: fallbackSubtitlePlacement(shot),
      rationale: `多模态分析暂不可用，已回退到本地选段策略（${reason.slice(0, 120)}）。`,
    };
  }
  return {
    materialNotes,
    selectedIndex,
    sourceStartSec: 0,
    sourceEndSec: 0,
    renderMode: "image-pan",
    subtitlePlacement: fallbackSubtitlePlacement(shot),
    rationale: `多模态分析暂不可用，已回退到本地素材选择（${reason.slice(0, 120)}）。`,
  };
}
