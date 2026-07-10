import type { NovelStageKind, NovelTargetKind } from "./novel-types.js";

export const NOVEL_STAGE_LABELS: Record<NovelStageKind, string> = {
  settings: "设定",
  macro: "宏观",
  world: "世界观",
  chars: "角色",
  volumes: "卷纲",
  outline: "拆章",
  draft: "正文",
  style: "写法",
};

const STAGE_GUIDANCE: Record<NovelStageKind, string> = {
  settings: "提炼题材、受众、主线卖点、叙事视角、情绪基调和禁忌边界。",
  macro: "设计长篇主线、核心冲突、阶段转折、升级节奏和结局方向。",
  world: "构建地理、势力、规则、资源、历史事件和日常生活细节。",
  chars: "创建主角、关键配角、反派和关系网，包含动机、弧光与秘密。",
  volumes: "拆分卷结构，给出每卷主题、目标、高潮、反转和承接关系。",
  outline: "按章节列出标题、剧情目的、冲突、伏笔、结尾钩子和预计字数。",
  draft: "基于长篇记忆、卷纲与章节目标，规划正文写作顺序和章节正文要点。",
  style: "从样文中提取写法名、句式、节奏、视角、叙述偏好和可复用特征池。",
};

const STAGE_OUTPUT_FIELDS: Record<NovelStageKind, string> = {
  settings: "核心要求、频道、平台、题材、视角、文风模式、年代、是否金手指、风格标签、语言、章节规划、卖点、目标读者、前30章承诺",
  macro: "故事引擎、主线、长期对立、节奏底盘、前30章承诺",
  world: "世界手册、规则、势力、地点、关系",
  chars: "角色、关系网",
  volumes: "分卷",
  outline: "章节列表",
  draft: "长篇记忆",
  style: "样文、写法名、特征池",
};

export interface NovelPromptInput {
  readonly targetKind: NovelTargetKind;
  readonly projectTitle: string;
  readonly genre?: string;
  readonly userPrompt?: string;
  readonly contextText?: string;
  readonly chapterTitle?: string;
  readonly chapterSummary?: string;
  readonly chapterIndex?: number;
  readonly targetChars?: number;
  readonly targetCount?: number;
}

function targetCountLine(kind: NovelStageKind, targetCount?: number): string {
  if (!targetCount) return "";
  if (kind === "chars") return `数量要求：请生成 ${targetCount} 个角色。`;
  if (kind === "volumes") return `数量要求：请生成 ${targetCount} 卷。`;
  if (kind === "outline") return `数量要求：请生成 ${targetCount} 个章节。`;
  return "";
}

export function buildNovelSystemPrompt(targetKind: NovelTargetKind): string {
  if (targetKind === "chapter") {
    return "你是中文长篇小说写作助手。只输出章节正文，若使用 JSON 也只能包含 title 和 content 字段，不要解释，不要 Markdown。";
  }
  return [
    "你是中文长篇小说策划助手。",
    "只输出可被产品展示的 JSON，不要 Markdown，不要解释。",
    "JSON 键名应简短稳定，值中写给读者/作者看的中文内容。",
  ].join("");
}

export function buildNovelUserPrompt(input: NovelPromptInput): string {
  if (input.targetKind === "chapter") {
    return [
      `项目：${input.projectTitle}`,
      input.genre ? `题材：${input.genre}` : "",
      input.chapterIndex ? `章节序号：第 ${input.chapterIndex} 章` : "",
      input.chapterTitle ? `章节标题：${input.chapterTitle}` : "",
      input.chapterSummary ? `章节要求：${input.chapterSummary}` : "",
      input.contextText ? `已定设定与大纲：\n${input.contextText}` : "",
      `目标长度：约 ${input.targetChars ?? 3000} 个汉字。`,
      "请输出节奏完整、可直接展示给用户的正文。",
    ].filter(Boolean).join("\n\n");
  }

  const label = NOVEL_STAGE_LABELS[input.targetKind];
  return [
    `项目：${input.projectTitle}`,
    input.genre ? `题材：${input.genre}` : "",
    `当前阶段：${label}`,
    `阶段目标：${STAGE_GUIDANCE[input.targetKind]}`,
    `输出字段：${STAGE_OUTPUT_FIELDS[input.targetKind]}`,
    targetCountLine(input.targetKind, input.targetCount),
    input.userPrompt ? `用户补充：${input.userPrompt}` : "",
    input.contextText ? `已有上下文：\n${input.contextText}` : "",
    "请严格输出一个 JSON 对象，键名只使用“输出字段”里列出的中文字段名；不要输出项目名、阶段名、Markdown 或解释。",
    "每个字段的值必须是可直接填入表单的中文内容；列表类字段用字符串数组。",
  ].filter(Boolean).join("\n\n");
}
