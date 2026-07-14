export const NOVEL_STORY_PHASES = ["opening", "development", "convergence", "ending"] as const;
export type NovelStoryPhase = (typeof NOVEL_STORY_PHASES)[number];

export interface NovelStoryPhasePolicy {
  readonly phase: NovelStoryPhase;
  readonly progress: number;
  readonly allowNewForeshadow: boolean;
  readonly allowNewStoryline: boolean;
  readonly maximumRevealLevel: "hint" | "partial" | "major" | "final";
}

export function resolveNovelStoryPhase(completedChapters: number, targetChapters: number): NovelStoryPhasePolicy {
  const safeTarget = Math.max(1, Math.floor(targetChapters));
  const progress = Math.min(1, Math.max(0, completedChapters / safeTarget));
  if (progress < 0.25) {
    return { phase: "opening", progress, allowNewForeshadow: true, allowNewStoryline: true, maximumRevealLevel: "hint" };
  }
  if (progress < 0.75) {
    return { phase: "development", progress, allowNewForeshadow: true, allowNewStoryline: true, maximumRevealLevel: "partial" };
  }
  if (progress < 0.9) {
    return { phase: "convergence", progress, allowNewForeshadow: false, allowNewStoryline: false, maximumRevealLevel: "major" };
  }
  return { phase: "ending", progress, allowNewForeshadow: false, allowNewStoryline: false, maximumRevealLevel: "final" };
}
