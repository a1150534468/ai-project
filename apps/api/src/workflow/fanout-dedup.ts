function grams(text: string): Set<string> {
  const s = text.replace(/\s+/g, "");
  const set = new Set<string>();
  if (s.length < 3) {
    if (s.length > 0) set.add(s);
    return set;
  }
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
  return set;
}

export function jaccard3gram(a: string, b: string): number {
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 返回每条与已接受集合的最高相似度
export function maxSimilarity(text: string, accepted: readonly string[]): number {
  let max = 0;
  for (const a of accepted) {
    const s = jaccard3gram(text, a);
    if (s > max) max = s;
  }
  return max;
}

export interface DedupResult {
  readonly accepted: string[];  // 新接受的文本（不含 seed）
  readonly dropped: number[];   // candidates 中被丢弃的下标
  readonly similarities: number[]; // 每个 candidate 的最高相似度（丢弃的也记录）
}

export function filterByDedup(
  candidates: readonly string[],
  seed: readonly string[],
  threshold: number,
): DedupResult {
  const pool = [...seed];
  const accepted: string[] = [];
  const dropped: number[] = [];
  const similarities: number[] = [];
  candidates.forEach((text, i) => {
    const sim = maxSimilarity(text, pool);
    similarities.push(sim);
    if (sim > threshold) {
      dropped.push(i);
    } else {
      accepted.push(text);
      pool.push(text);
    }
  });
  return { accepted, dropped, similarities };
}
