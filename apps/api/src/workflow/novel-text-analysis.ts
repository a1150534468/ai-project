import type {
  NovelChapterAssetSnapshot,
  NovelEventCard,
  NovelMention,
  NovelQualityDiagnostics,
  NovelQualityIssue,
} from "./novel-workbench-types.js";

const SENTENCE_RE = /(?<=[。！？?!])/u;
const NON_WHITESPACE_RE = /\S/gu;
const CHINESE_PHRASE_RE = /[\u4e00-\u9fff]{4,8}/gu;
const DIALOGUE_MARKER_RE = /[“”「」『』"]/u;
const ACTION_HINT_RE = /(发现|进入|离开|追查|追踪|质问|决定|揭开|暴露|潜入|逃离|收到|确认|锁定|怀疑|救下|袭击|反击|调查|谈判|搜查|交手|对峙|得知|看见|看到)/u;
const TENSION_KEYWORDS = ["危险", "危机", "威胁", "真相", "秘密", "追击", "追杀", "冲突", "对峙", "失控", "崩塌", "血", "杀", "爆炸", "质问", "怀疑", "异常", "反击", "暴露"] as const;
const EMOTIONAL_TENSION_RE = /(恐惧|害怕|愤怒|怒火|绝望|痛苦|犹豫|挣扎|背叛|怀疑|质问|对峙|威胁|压迫|紧张|惊惧|心跳|颤抖|沉默|失控)/u;
const PACING_ACTION_RE = /(冲|追|逃|扑|抓|砸|撞|击|杀|躲|闪|爆|断|抢|夺|闯|奔|跃|翻|拔|刺|劈|射|跑|逼近|反击|交手)/u;
export const NOVEL_TENSION_SCORING_VERSION = "density-v2";
const CLICHE_SNIPPETS = ["嘴角微微上扬", "倒吸了一口凉气", "瞳孔骤缩", "心头一震", "不由得", "空气仿佛凝固", "时间仿佛静止", "深吸一口气", "头皮发麻"] as const;

export function splitNovelSentences(content: string): string[] {
  return (content || "").split(SENTENCE_RE).map((part) => part.trim()).filter(Boolean);
}

function compactText(content: string): string {
  return (content || "").replace(/\s+/g, "");
}

function collectRepeatedPhrases(content: string): string[] {
  const normalized = compactText(content);
  if (normalized.length < 24) return [];
  const counts = new Map<string, number>();
  for (const match of normalized.matchAll(CHINESE_PHRASE_RE)) {
    const phrase = match[0];
    if (new Set(Array.from(phrase)).size <= 2) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);
}

function detectCliches(content: string): string[] {
  return CLICHE_SNIPPETS.filter((snippet) => content.includes(snippet)).slice(0, 5);
}

function mentionRows(sentences: readonly string[], names: readonly string[], kind: "character" | "location"): NovelMention[] {
  return names
    .map((name) => {
      const matched = sentences.filter((sentence) => sentence.includes(name));
      return matched.length > 0 ? { name, kind, count: matched.length, evidence: matched[0].slice(0, 180) } : null;
    })
    .filter((item): item is NovelMention => item !== null)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, 8);
}

function eventType(sentence: string): NovelEventCard["eventType"] {
  if (/[追打杀战交手突袭反击冲出逃离]/u.test(sentence)) return "action";
  if (/(发现|真相|秘密|揭开|得知|暴露|线索)/u.test(sentence)) return "reveal";
  if (/(调查|追查|搜查|试探|潜入|锁定|怀疑)/u.test(sentence)) return "investigation";
  if (/(质问|对峙|争吵|谈判|冲突|逼问)/u.test(sentence)) return "conflict";
  if (/(心头|沉默|犹豫|悲伤|愤怒|和解|告白)/u.test(sentence)) return "emotion";
  return "progress";
}

function buildEventCards(sentences: readonly string[], characters: readonly string[], locations: readonly string[]): NovelEventCard[] {
  const rows = sentences.flatMap((sentence, index) => {
    const text = sentence.trim();
    if (text.length < 8) return [];
    const actors = characters.filter((name) => text.includes(name)).slice(0, 3);
    const places = locations.filter((name) => text.includes(name)).slice(0, 2);
    let score = 0;
    if (ACTION_HINT_RE.test(text)) score += 3;
    if (/(发现|真相|秘密|揭开|得知|线索|密信)/u.test(text)) score += 3;
    score += Math.min(actors.length, 2) * 2;
    if (places.length) score += 1;
    if (/[？?]/u.test(text)) score += 2;
    if (TENSION_KEYWORDS.some((keyword) => text.includes(keyword))) score += 2;
    if (/(但|却|然而|忽然|最终|没想到)/u.test(text)) score += 1;
    if (score <= 0) return [];
    return [{
      score,
      index,
      card: {
        label: `${text.slice(0, 32)}${text.length > 32 ? "..." : ""}`,
        eventType: eventType(text),
        tensionLevel: score >= 6 ? "high" : score >= 3 ? "medium" : "low",
        actors,
        locations: places,
        evidence: text.slice(0, 180),
      } satisfies NovelEventCard,
    }];
  });
  const seen = new Set<string>();
  return rows
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .flatMap((row) => {
      if (seen.has(row.card.label)) return [];
      seen.add(row.card.label);
      return [row.card];
    })
    .slice(0, 4);
}

export function deriveNovelChapterAssets(args: {
  readonly content: string;
  readonly characters: readonly string[];
  readonly locations: readonly string[];
}): NovelChapterAssetSnapshot {
  const sentences = splitNovelSentences(args.content);
  return {
    eventCards: buildEventCards(sentences, args.characters, args.locations),
    characterMentions: mentionRows(sentences, args.characters, "character"),
    locationMentions: mentionRows(sentences, args.locations, "location"),
  };
}

export function buildNovelQualityDiagnostics(content: string): NovelQualityDiagnostics {
  const normalized = content || "";
  const sentences = splitNovelSentences(normalized);
  const paragraphs = normalized.split(/\n{1,}/u).map((part) => part.trim()).filter(Boolean);
  const wordCount = [...normalized.matchAll(NON_WHITESPACE_RE)].length;
  const sentenceLengths = sentences.length ? sentences.map((sentence) => Array.from(sentence).length) : [0];
  const averageSentenceLength = Number((sentenceLengths.reduce((sum, value) => sum + value, 0) / sentenceLengths.length).toFixed(2));
  const longSentenceCount = sentenceLengths.filter((length) => length >= 38).length;
  const questionCount = (normalized.match(/[？?]/gu) ?? []).length;
  const exclamationCount = (normalized.match(/[！!]/gu) ?? []).length;
  const dialogueSentenceCount = sentences.filter((sentence) => DIALOGUE_MARKER_RE.test(sentence)).length;
  const dialogueRatio = Number((dialogueSentenceCount / Math.max(sentences.length, 1)).toFixed(2));
  const sentenceCounts = new Map<string, number>();
  for (const sentence of sentences) sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
  const duplicateSentenceCount = [...sentenceCounts.entries()].reduce((sum, [sentence, count]) => sum + (sentence.length >= 12 && count > 1 ? count - 1 : 0), 0);
  const repeatedPhrases = collectRepeatedPhrases(normalized);
  const clicheHits = detectCliches(normalized);
  const endingWindow = sentences.length ? sentences.slice(-2).join("") : normalized.slice(-120);
  const endingHook = /[？?！!]|却|然而|没想到/u.test(endingWindow);
  const tensionHits = TENSION_KEYWORDS.reduce((sum, keyword) => sum + (normalized.split(keyword).length - 1), 0);
  const safeSentences = Math.max(sentences.length, 1);
  const safeThousands = Math.max(wordCount / 1000, 0.35);
  const ratio = (value: number, target: number) => Math.min(1, Math.max(0, value / target));
  const tensionKeywordDensity = tensionHits / safeThousands;
  const actionSentenceRatio = sentences.filter((sentence) => PACING_ACTION_RE.test(sentence)).length / safeSentences;
  const emotionalSentenceRatio = sentences.filter((sentence) => EMOTIONAL_TENSION_RE.test(sentence)).length / safeSentences;
  const questionRatio = questionCount / safeSentences;
  const exclamationRatio = exclamationCount / safeSentences;
  const punctuationPressure = (questionCount + exclamationCount) / safeSentences;
  const shortSentenceRatio = sentenceLengths.filter((length) => length > 0 && length <= 12).length / safeSentences;
  const paragraphDensity = paragraphs.length / safeSentences;
  const plotTension = Math.round(18
    + ratio(tensionKeywordDensity, 10) * 30
    + ratio(actionSentenceRatio, 0.24) * 24
    + ratio(questionRatio, 0.16) * 10
    + (endingHook ? 12 : 0));
  const emotionalTension = Math.round(18
    + ratio(emotionalSentenceRatio, 0.2) * 30
    + ratio(questionRatio, 0.16) * 18
    + ratio(exclamationRatio, 0.14) * 12
    + ratio(dialogueRatio, 0.45) * 12);
  const pacingTension = Math.round(18
    + ratio(actionSentenceRatio, 0.24) * 30
    + ratio(punctuationPressure, 0.25) * 18
    + ratio(shortSentenceRatio, 0.28) * 14
    + ratio(paragraphDensity, 0.65) * 10);
  const tensionScore = Math.round(plotTension * 0.45 + emotionalTension * 0.3 + pacingTension * 0.25);
  const issues: NovelQualityIssue[] = [];
  if (wordCount < 800) issues.push({ code: "low_word_count", severity: "high", message: "章节偏短，情节推进和场景展开可能不足。", suggestion: "补足动作反应、环境细节或人物决策链，避免只给结论。" });
  if (paragraphs.length <= 1 && wordCount >= 500) issues.push({ code: "flat_paragraphs", severity: "medium", message: "段落切分过少，阅读节奏偏闷。", suggestion: "按动作、对话和情绪转折拆段，给读者留出呼吸点。" });
  if (averageSentenceLength >= 38 && longSentenceCount / Math.max(sentenceLengths.length, 1) >= 0.35) issues.push({ code: "long_sentences", severity: "medium", message: "长句占比偏高，叙述容易拖慢节奏。", suggestion: "把关键动作和判断拆成短句，减少多层并列信息堆叠。" });
  if (dialogueRatio < 0.08 && wordCount >= 1000) issues.push({ code: "low_dialogue_density", severity: "medium", message: "对话密度偏低，人物关系和冲突不够具象。", suggestion: "让冲突落到对话、试探和反问中，不要只写旁白总结。" });
  if (duplicateSentenceCount >= 2 || repeatedPhrases.length > 0) issues.push({ code: "repetition_risk", severity: duplicateSentenceCount >= 3 ? "high" : "medium", message: "存在重复表达，章节语言可能显得机械。", suggestion: "替换高频短语，压缩重复句式，让信息推进而不是原地复述。" });
  if (clicheHits.length >= 2) issues.push({ code: "cliche_risk", severity: "medium", message: "套话痕迹偏明显，文风辨识度不足。", suggestion: "优先改写套话句，换成角色专属反应和更具体的感官细节。" });
  if (!endingHook && sentences.length >= 3) issues.push({ code: "weak_ending_hook", severity: "medium", message: "收尾钩子偏弱，读者继续追更的驱动力不够。", suggestion: "结尾留一个未解问题、代价升级，或明确抛出下一步压力。" });
  const score = Math.max(18, issues.reduce((value, issue) => value - (issue.severity === "high" ? 18 : issue.severity === "medium" ? 10 : 6), 100));
  return {
    score,
    tensionScore,
    tensionDimensions: {
      plot: plotTension,
      emotional: emotionalTension,
      pacing: pacingTension,
      scoringVersion: NOVEL_TENSION_SCORING_VERSION,
    },
    rhythmStatus: score >= 80 ? "steady" : score >= 60 ? "needs_tune" : "unstable",
    styleRisk: issues.some((issue) => issue.severity === "high") ? "high" : issues.length ? "medium" : "low",
    endingHook,
    repeatedPhrases,
    clicheHits,
    issues,
    metrics: {
      wordCount,
      paragraphCount: paragraphs.length,
      sentenceCount: sentences.length,
      averageSentenceLength,
      dialogueRatio,
      questionCount,
      exclamationCount,
      duplicateSentenceCount,
    },
  };
}
