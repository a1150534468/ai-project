import { buildNovelQualityDiagnostics, deriveNovelChapterAssets, splitNovelSentences } from "./novel-text-analysis.js";
import type {
  NovelChapterSummaryPayload,
  NovelConsistencyStatus,
  NovelForeshadowPayload,
  NovelKnowledgeFactPayload,
} from "./novel-workbench-types.js";

const ACTION_HINT_RE = /(发现|得知|看到|进入|离开|追查|追踪|质问|交手|对峙|决定|揭开|暴露|潜入|逃离|收到|确认|锁定|怀疑|救下|袭击|反击|谈判|搜查|击退)/u;
const OPEN_THREAD_HINT_RE = /(谁|为何|为什么|究竟|真相|秘密|目的|身份|何处|哪里|怎么会|如何|什么)/u;
const DURABLE_UNKNOWN_RE = /(真相|秘密|身份|目的|幕后|未知|谜底|无法.{0,8}(?:解析|理解|确认)|尚未|仍未|未被回收|究竟|为何|为什么)/u;
const FUTURE_PRESSURE_RE = /(必须|即将|将要|要彻底|准备再次|真正的.{0,10}(?:猎手|敌人)|刚刚才露出|才刚刚开始|猎杀.{0,8}开始|倒计时|覆写全人类|物理锚点)/u;
const STORY_OBJECT_RE = /(逻辑锁|锚点|协议|源码|代码|碎片|节点|猎手|猎杀|架构师|覆写|意识|神经元|苏明|哥哥)/u;
const EXPLICIT_MISSION_RE = /(必须|要彻底).{0,100}(?:锚点|救出|切断|前往|进入|解开)/u;
const LOW_VALUE_THREAD_RE = /(真写啊|敢接这单悬赏|他在干嘛|就这|想杀我|想抹杀我|你懂硬件|有Bug，就必须被修复|逻辑风暴，才刚刚开始)/u;

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

function durableOpenThreads(sentences: readonly string[]): string[] {
  const tail = sentences.slice(-12);
  const candidates = tail.map((sentence, index) => {
    const compact = sentence.replace(/\s+/gu, " ").trim();
    if (LOW_VALUE_THREAD_RE.test(compact) || compact.length < 8) return { sentence: compact, score: -1, index };
    let score = 0;
    if (/[？?]/u.test(compact) && OPEN_THREAD_HINT_RE.test(compact)) score += 4;
    if (DURABLE_UNKNOWN_RE.test(compact)) score += 3;
    if (FUTURE_PRESSURE_RE.test(compact)) score += 3;
    if (STORY_OBJECT_RE.test(compact)) score += 1;
    if (EXPLICIT_MISSION_RE.test(compact)) score += 2;
    if (score >= 4 && index >= tail.length - 3) score += 1;
    return { sentence: compact.slice(0, 220), score, index };
  }).filter((item) => item.score >= 4).sort((a, b) => b.score - a.score || b.index - a.index);
  return dedupe(candidates.map((item) => item.sentence)).slice(0, 1);
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
    // Only a high-signal ending question, unresolved reveal, or explicit future pressure
    // becomes a durable thread. Routine dialogue and recurring catchphrases are excluded.
    openThreads: durableOpenThreads(sentences),
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
    expectedPayoffChapter: args.chapterIndex + (/[？?]/u.test(thread) ? 3 : 5),
    status: "open" as const,
    relatedCharacter: "",
  })).slice(0, 1);
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
