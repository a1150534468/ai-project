export type NovelContextLayer = "contract" | "chapterPlan" | "world" | "characters" | "recent" | "memory" | "foreshadow" | "style";

export interface NovelContextCandidate {
  readonly id: string;
  readonly layer: NovelContextLayer;
  readonly content: string;
  readonly estimatedTokens: number;
  readonly required?: boolean;
  readonly score?: number;
}

const LAYER_WEIGHT: Record<NovelContextLayer, number> = {
  contract: 800,
  chapterPlan: 700,
  world: 600,
  characters: 550,
  recent: 500,
  memory: 350,
  foreshadow: 450,
  style: 650,
};

export function allocateNovelContext(candidates: readonly NovelContextCandidate[], tokenBudget: number): NovelContextCandidate[] {
  const budget = Math.max(0, Math.floor(tokenBudget));
  const ordered = [...candidates].sort((a, b) => {
    if (Boolean(a.required) !== Boolean(b.required)) return a.required ? -1 : 1;
    return (LAYER_WEIGHT[b.layer] + (b.score ?? 0)) - (LAYER_WEIGHT[a.layer] + (a.score ?? 0));
  });
  const selected: NovelContextCandidate[] = [];
  let used = 0;
  for (const candidate of ordered) {
    const tokens = Math.max(0, Math.floor(candidate.estimatedTokens));
    if (!candidate.required && used + tokens > budget) continue;
    selected.push(candidate);
    used += tokens;
  }
  return selected;
}
