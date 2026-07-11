import { buildNovelQualityDiagnostics, deriveNovelChapterAssets, splitNovelSentences } from "./novel-text-analysis.js";
import type {
  NovelChapterSummaryPayload,
  NovelConsistencyStatus,
  NovelForeshadowPayload,
  NovelKnowledgeFactPayload,
} from "./novel-workbench-types.js";

const ACTION_HINT_RE = /(发现|得知|看到|进入|离开|追查|追踪|质问|交手|对峙|决定|揭开|暴露|潜入|逃离|收到|确认|锁定|怀疑|救下|袭击|反击|谈判|搜查|击退)/u;

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function keyEventsFromSentences(sentences: readonly string[]): string[] {
  const scored = sentences
    .map((sentence, index) => {
      let score = 0;
      if (ACTION_HINT_RE.test(sentence)) score += 3;
      if (/[？?]/u.test(sentence)) score += 2;
      if (/(但|却|然而|忽然|没想到|最终)/u.test(sentence)) score += 2;
      if (sentence.length >= 14 && sentence.length <= 60) score += 1;
      return { sentence: sentence.slice(0, 180), score, index };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.sentence);
  return dedupe(scored.length ? scored : sentences.slice(0, 3).map((sentence) => sentence.slice(0, 180))).slice(0, 4);
}

export function buildNovelChapterSummaryPayload(content: string): NovelChapterSummaryPayload {
  const normalized = (content || "").replace(/\s+/g, " ").trim();
  if (!normalized) return { summary: "", keyEvents: [], openThreads: [] };
  const sentences = splitNovelSentences(normalized);
  const keyEvents = keyEventsFromSentences(sentences);
  const summaryParts: string[] = [];
  for (const sentence of [...keyEvents, ...sentences]) {
    if (summaryParts.join("").length + sentence.length > 180 && summaryParts.length > 0) break;
    summaryParts.push(sentence);
  }
  return {
    summary: summaryParts.join("").slice(0, 220),
    keyEvents,
    openThreads: dedupe(sentences.filter((sentence) => /[？?]/u.test(sentence))).slice(0, 5),
  };
}

export function buildNovelChapterPostprocessPayload(args: {
  readonly projectTitle: string;
  readonly chapterIndex: number;
  readonly title: string;
  readonly content: string;
  readonly knownCharacters: readonly string[];
  readonly knownLocations: readonly string[];
}): {
  readonly summary: NovelChapterSummaryPayload;
  readonly facts: NovelKnowledgeFactPayload[];
  readonly foreshadowItems: NovelForeshadowPayload[];
  readonly consistencyStatus: NovelConsistencyStatus;
} {
  const sentences = splitNovelSentences(args.content);
  const summary = buildNovelChapterSummaryPayload(args.content);
  const quality = buildNovelQualityDiagnostics(args.content);
  const chapterAssets = deriveNovelChapterAssets({
    content: args.content,
    characters: args.knownCharacters,
    locations: args.knownLocations,
  });
  const facts: NovelKnowledgeFactPayload[] = [
    ...args.knownCharacters.flatMap((name) => {
      const sentence = sentences.find((item) => item.includes(name));
      return sentence ? [{
        chapterIndex: args.chapterIndex,
        subject: name,
        predicate: "本章动向",
        object: `第${args.chapterIndex}章出现`,
        sourceExcerpt: sentence.slice(0, 240),
        confidence: 0.78,
        status: "confirmed" as const,
      }] : [];
    }),
    ...args.knownLocations.flatMap((name) => {
      const sentence = sentences.find((item) => item.includes(name));
      return sentence ? [{
        chapterIndex: args.chapterIndex,
        subject: name,
        predicate: "章节地点",
        object: `第${args.chapterIndex}章涉及`,
        sourceExcerpt: sentence.slice(0, 240),
        confidence: 0.74,
        status: "confirmed" as const,
      }] : [];
    }),
  ].slice(0, 10);
  const fallbackFacts = facts.length ? facts : sentences.slice(0, 1).map((sentence) => ({
    chapterIndex: args.chapterIndex,
    subject: `第${args.chapterIndex}章`,
    predicate: "关键事件",
    object: sentence.slice(0, 80),
    sourceExcerpt: sentence.slice(0, 240),
    confidence: 0.68,
    status: "confirmed" as const,
  }));
  const foreshadowItems = summary.openThreads.map((thread) => ({
    introducedInChapterIndex: args.chapterIndex,
    title: thread.slice(0, 80),
    description: thread.slice(0, 220),
    expectedPayoffChapter: args.chapterIndex + 3,
    status: "open" as const,
    relatedCharacter: "",
  })).slice(0, 5);
  const risks: string[] = [];
  if (quality.metrics.wordCount < 500) risks.push("章节字数偏低，可能影响节奏展开");
  if (args.knownCharacters.length > 0 && !args.knownCharacters.slice(0, 3).some((name) => args.content.includes(name))) risks.push("本章未触达主要角色，可能与主线推进脱节");
  if (args.knownLocations.length > 0 && !args.knownLocations.slice(0, 3).some((name) => args.content.includes(name))) risks.push("本章未引用核心地点信息，世界感可能偏弱");
  risks.push(...quality.issues.slice(0, 4).map((issue) => issue.message));
  return {
    summary,
    facts: fallbackFacts,
    foreshadowItems,
    consistencyStatus: {
      status: risks.length ? "warning" : "ok",
      conflicts: [],
      risks: risks.slice(0, 6),
      checkedEntities: [...args.knownCharacters.slice(0, 5), ...args.knownLocations.slice(0, 5)],
      quality,
      chapterAssets,
    },
  };
}
