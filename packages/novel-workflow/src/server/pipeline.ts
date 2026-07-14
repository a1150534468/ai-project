import type { NovelPipelineStepKind, NovelRunMode, NovelRunStatus } from "../contracts.js";

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

export function pipelineForMode(_mode: NovelRunMode, _includePlanning = false): readonly NovelPipelineStepKind[] {
  return ASSISTED_PIPELINE;
}

export function nextPipelineStep(
  mode: NovelRunMode,
  current: NovelPipelineStepKind,
  includePlanning: boolean,
): NovelPipelineStepKind | null {
  const pipeline = pipelineForMode(mode, includePlanning);
  const index = pipeline.indexOf(current);
  return index >= 0 && index + 1 < pipeline.length ? pipeline[index + 1]! : null;
}
