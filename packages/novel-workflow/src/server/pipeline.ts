import type { NovelPipelineStepKind, NovelRunStatus } from "../contracts.js";

export const ASSISTED_PIPELINE: readonly NovelPipelineStepKind[] = [
  "prepareChapter",
  "assembleContext",
  "writeChapter",
  "validateContent",
  "auditVoice",
  "postprocessChapter",
  "scoreTension",
  "finalizeChapter",
];

export function runStatusForStep(step: NovelPipelineStepKind): NovelRunStatus {
  if (step === "prepareChapter" || step === "assembleContext") return "planning";
  if (step === "writeChapter") return "writing";
  if (step === "validateContent" || step === "auditVoice" || step === "scoreTension") return "validating";
  return "postprocessing";
}

export function pipelineForMode(): readonly NovelPipelineStepKind[] {
  return ASSISTED_PIPELINE;
}

export function nextPipelineStep(
  current: NovelPipelineStepKind,
): NovelPipelineStepKind | null {
  const pipeline = pipelineForMode();
  const index = pipeline.indexOf(current);
  return index >= 0 && index + 1 < pipeline.length ? pipeline[index + 1]! : null;
}
