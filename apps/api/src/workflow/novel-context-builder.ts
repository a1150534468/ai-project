import type {
  NovelContinuityAlert,
  NovelForeshadowPayload,
  NovelGenerationContextPayload,
  NovelKnowledgeFactPayload,
  NovelMicroBeat,
  NovelWorkflowGate,
} from "./novel-workbench-types.js";
import { allocateNovelContext, type NovelContextCandidate } from "@ai-assistant/novel-workflow";

type ChapterLike = {
  readonly id: string;
  readonly chapterIndex: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly openThreads?: unknown;
};
type ReviewFeedbackLike = { readonly chapterIndex: number; readonly status: string; readonly reviewNotes: string; readonly aiReview: string; readonly aiActionItems: readonly string[]; readonly modificationRate: number };

function compact(text: string, max = 240): string {
  const value = (text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${Array.from(value).slice(0, max - 3).join("")}...` : value;
}

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function evaluateWorkflowGate(args: { readonly chapterIndex: number; readonly previousChapters: readonly ChapterLike[]; readonly reviewFeedback: readonly ReviewFeedbackLike[] }): NovelWorkflowGate {
  const latestChapter = [...args.previousChapters].filter((chapter) => chapter.chapterIndex < args.chapterIndex).sort((a, b) => b.chapterIndex - a.chapterIndex)[0];
  if (!latestChapter) return { allowed: true, status: "ok", summary: "当前还没有历史章节，可以直接开始生成。", checkedChapter: null, blockingReasons: [], warnings: [], minimumModificationRate: 0 };
  const latestReview = args.reviewFeedback.find((review) => review.chapterIndex === latestChapter.chapterIndex);
  const blockingReasons = latestReview?.status === "revise" ? [{ code: "review_revise", level: "critical" as const, title: "上一章仍需修订", detail: `第${latestChapter.chapterIndex}章审阅状态为“需修订”，应先处理审阅意见再继续生成。` }] : [];
  const warnings = [
    ...(!latestReview ? [{ code: "review_missing", level: "warning" as const, title: "上一章缺少审阅记录", detail: `第${latestChapter.chapterIndex}章还没有正式审阅记录，建议先补审后再继续。` }] : []),
    ...(latestReview?.status === "pending" ? [{ code: "review_pending", level: "warning" as const, title: "上一章尚未审定", detail: `第${latestChapter.chapterIndex}章还未完成正式审阅，继续生成有承接风险。` }] : []),
  ];
  return {
    allowed: blockingReasons.length === 0,
    status: blockingReasons.length ? "blocked" : warnings.length ? "warning" : "ok",
    summary: blockingReasons[0]?.detail ?? warnings[0]?.detail ?? `第${latestChapter.chapterIndex}章已满足继续生成条件。`,
    checkedChapter: { id: latestChapter.id, chapterIndex: latestChapter.chapterIndex, title: latestChapter.title || `第${latestChapter.chapterIndex}章`, status: "ready", reviewStatus: latestReview?.status ?? "missing", modificationRate: latestReview?.modificationRate ?? 0 },
    blockingReasons,
    warnings,
    minimumModificationRate: 0,
  };
}

function buildMicroBeats(chapterIndex: number, mission: string, conflict: string, endingHook: string): NovelMicroBeat[] {
  const totalWords = chapterIndex <= 3 ? 2800 : 3200;
  const rows = [
    { label: "场景落位", focus: "sensory" as const, objective: "用环境与人物状态快速完成开场定位。", ratio: 0.2 },
    { label: "主任务推进", focus: "dialogue" as const, objective: `围绕本章目标推进核心事件：${compact(mission, 80)}`, ratio: 0.32 },
    { label: "阻力显形", focus: "action" as const, objective: `中段必须出现阻力、误差或压力源。当前冲突核心：${compact(conflict, 80)}`, ratio: 0.26 },
    { label: "钩子收尾", focus: "emotion" as const, objective: `章节尾部挂出下一步问题：${compact(endingHook, 80)}`, ratio: 0.22 },
  ];
  return rows.map((row, index) => ({ index: index + 1, label: row.label, focus: row.focus, objective: row.objective, targetWords: Math.max(240, Math.round(totalWords * row.ratio)) }));
}

function buildAlerts(args: { readonly chapterIndex: number; readonly openThreads: readonly string[]; readonly dueForeshadow: readonly NovelForeshadowPayload[]; readonly facts: readonly NovelKnowledgeFactPayload[]; readonly reviewFeedback: readonly ReviewFeedbackLike[] }): NovelContinuityAlert[] {
  const alerts: NovelContinuityAlert[] = [];
  if (args.dueForeshadow.length) alerts.push({ level: "warning", title: "伏笔接近回收窗口", detail: `第${args.chapterIndex}章附近应优先处理：${args.dueForeshadow.slice(0, 3).map((item) => item.title).join("；")}` });
  if (args.openThreads.length >= 5) alerts.push({ level: "warning", title: "开放线索偏多", detail: "近期未收束线索已经堆积，本章更适合回收或聚焦，而不是继续扩坑。" });
  if (args.facts.length === 0) alerts.push({ level: "info", title: "稳定事实较少", detail: "本章写作时尽量复用既有设定锚点，避免一次性引入太多新世界规则。" });
  const latestFeedback = args.reviewFeedback[0];
  if (latestFeedback?.status === "revise") alerts.push({ level: "critical", title: "上一章仍需修订", detail: `第${latestFeedback.chapterIndex}章审阅状态为“需修订”，应先处理：${compact(latestFeedback.reviewNotes || latestFeedback.aiReview || "补齐审阅意见", 90)}` });
  return alerts;
}

export function buildNovelGenerationContext(args: {
  readonly project: { readonly id: string; readonly title: string; readonly genre: string };
  readonly chapterIndex: number;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
  readonly conflictAnchor?: string;
  readonly styleProfileText?: string;
  readonly previousChapters: readonly ChapterLike[];
  readonly facts: readonly NovelKnowledgeFactPayload[];
  readonly foreshadowItems: readonly NovelForeshadowPayload[];
  readonly reviewFeedback: readonly ReviewFeedbackLike[];
  readonly structuredContext?: {
    readonly contract?: readonly string[];
    readonly world?: readonly string[];
    readonly characters?: readonly string[];
    readonly continuity?: readonly string[];
  };
}): NovelGenerationContextPayload {
  const recentSummaries = args.previousChapters.slice(-5).map((chapter) => ({
    summary: compact(chapter.summary || chapter.content, 220),
    keyEvents: [],
    openThreads: stringArray(chapter.openThreads),
  }));
  const openThreads = dedupe(recentSummaries.flatMap((summary) => summary.openThreads));
  const dueForeshadow = args.foreshadowItems.filter((item) => item.status !== "resolved" && (item.expectedPayoffChapter || args.chapterIndex) <= args.chapterIndex + 1).slice(0, 4);
  const mission = args.chapterSummary || args.chapterTitle || "推进主线，并在本章留下明确的新压力。";
  const conflict = compact(args.conflictAnchor ?? "", 420) || "让角色在推进目标时必须付出代价。";
  const endingHook = openThreads[0] || dueForeshadow[0]?.title || "让下一章目标自然浮出水面。";
  const focusCard = {
    chapterNumber: args.chapterIndex,
    mission,
    conflict,
    keyTurn: args.chapterSummary || "在章节后半段给出足以改变下一步行动的转折。",
    emotionalNote: compact(args.styleProfileText ?? "", 420) || "情绪推进要贴着动作和对话走，不要空转抒情。",
    endingHook,
    mustKeep: args.facts.slice(0, 4).map((item) => `${item.subject} ${item.predicate} ${item.object}`),
    mustPayoff: dueForeshadow.slice(0, 3).map((item) => item.title),
    mustFix: args.reviewFeedback.flatMap((item) => [...item.aiActionItems, item.reviewNotes || item.aiReview]).filter(Boolean).slice(0, 3),
    avoid: ["不要一次性解决所有开放线索", "不要引入未经铺垫的新设定替代现有冲突", "不要让角色动机与前文已确认事实脱节", "不要用总结性旁白替代具体场景推进"],
  };
  const workflowGate = evaluateWorkflowGate({ chapterIndex: args.chapterIndex, previousChapters: args.previousChapters, reviewFeedback: args.reviewFeedback });
  const structuredContext = {
    contract: dedupe(args.structuredContext?.contract ?? []),
    world: dedupe(args.structuredContext?.world ?? []),
    characters: dedupe(args.structuredContext?.characters ?? []),
    continuity: dedupe(args.structuredContext?.continuity ?? []),
  };
  return {
    project: args.project,
    chapterNumber: args.chapterIndex,
    chapterGoal: args.chapterSummary,
    recentSummaries,
    structuredContext,
    knowledgeFacts: args.facts.slice(0, 12),
    foreshadowItems: args.foreshadowItems.slice(0, 8),
    styleProfile: { content: compact(args.styleProfileText ?? "", 1200), structuredData: {} },
    workflowGate,
    focusCard,
    microBeats: buildMicroBeats(args.chapterIndex, mission, conflict, endingHook),
    continuityAlerts: buildAlerts({ chapterIndex: args.chapterIndex, openThreads, dueForeshadow, facts: args.facts, reviewFeedback: args.reviewFeedback }),
    contextLayers: {
      foundation: dedupe([...structuredContext.contract, ...structuredContext.world, ...structuredContext.characters]),
      continuity: dedupe([...structuredContext.continuity, ...recentSummaries.slice(0, 3).map((item, index) => `前文摘要${index + 1}：${item.summary}`), openThreads.length ? `开放线索：${openThreads.slice(0, 5).join("；")}` : "", ...args.facts.slice(0, 5).map((item) => `稳定事实：${item.subject} ${item.predicate} ${item.object}`), dueForeshadow.length ? `待回收伏笔：${dueForeshadow.map((item) => item.title).join("；")}` : ""]),
      tactical: dedupe([`本章任务：${focusCard.mission}`, `当前冲突：${focusCard.conflict}`, `关键转折：${focusCard.keyTurn}`, `收尾钩子：${focusCard.endingHook}`, focusCard.mustFix.length ? `优先修复：${focusCard.mustFix.join("；")}` : ""]),
    },
  };
}

function bulletBlock(title: string, items: readonly string[]): string {
  const rows = items.map((item) => item.trim()).filter(Boolean).map((item) => `- ${item}`);
  return rows.length ? `${title}\n${rows.join("\n")}` : "";
}

export function buildNovelEnhancedContextText(payload: NovelGenerationContextPayload): string {
  const candidates = [
    {
      id: "hard-constraints",
      layer: "contract",
      required: true,
      content: bulletBlock("【硬性写作规则】", [
      "只输出正文，不要输出标题、说明、提纲、分析、标签或自我解释。",
      "严格延续既有设定与稳定事实，禁止凭空改写人物关系、能力、地点规则和已发生事件。",
      "节奏遵循任务卡与微节拍，每个节拍必须落到可见动作、对话、心理反应或环境细节。",
      "不要用大段总结替代场景推进，不要把冲突轻易化解。",
      "如果埋新伏笔，必须与已有主线、开放线索或当前冲突直接相关。",
      ]),
      estimatedTokens: 150,
    },
    {
      id: "project-and-plan",
      layer: "chapterPlan",
      required: true,
      content: [
        `【项目卡】\n书名：${payload.project.title}\n题材：${payload.project.genre || "未指定"}\n章节：第${payload.chapterNumber}章`,
        `【章节任务卡】\n- 主任务：${payload.focusCard.mission}\n- 核心冲突：${payload.focusCard.conflict}\n- 关键转折：${payload.focusCard.keyTurn}\n- 情绪提示：${payload.focusCard.emotionalNote}\n- 收尾钩子：${payload.focusCard.endingHook}`,
        bulletBlock("【战术层】", payload.contextLayers.tactical),
        payload.microBeats.length ? `【微节拍】\n${payload.microBeats.map((beat) => `${beat.index}. ${beat.label} (${beat.focus} / ${beat.targetWords}字)：${beat.objective}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n"),
      estimatedTokens: 700,
    },
    { id: "foundation", layer: "world", content: bulletBlock("【世界与契约】", payload.contextLayers.foundation), estimatedTokens: 1800 },
    { id: "characters", layer: "characters", content: bulletBlock("【人物状态与关系】", payload.structuredContext.characters), estimatedTokens: 1400 },
    { id: "recent", layer: "recent", content: bulletBlock("【近期连续性】", payload.contextLayers.continuity), estimatedTokens: 1800 },
    { id: "facts", layer: "memory", content: bulletBlock("【稳定事实】", payload.knowledgeFacts.map((item) => `${item.subject} ${item.predicate} ${item.object}`)), estimatedTokens: 1000 },
    { id: "foreshadow", layer: "foreshadow", content: bulletBlock("【伏笔账本】", payload.foreshadowItems.map((item) => `${item.title}（${item.status}，回收章 ${item.expectedPayoffChapter}）：${item.description}`)), estimatedTokens: 900 },
    { id: "alerts", layer: "recent", content: bulletBlock("【连续性警报】", payload.continuityAlerts.map((item) => `[${item.level}] ${item.title}: ${item.detail}`)), estimatedTokens: 500, score: 100 },
    { id: "style", layer: "style", content: payload.styleProfile.content ? `【文风指纹】\n${payload.styleProfile.content}` : "", estimatedTokens: 700 },
  ] satisfies NovelContextCandidate[];
  const blocks = candidates.filter((item) => Boolean(item.content));
  return allocateNovelContext(blocks, 10_000).map((item) => item.content).join("\n\n");
}
