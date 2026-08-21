import type { NovelSetupTargetKind, NovelTargetKind } from "./novel-types.js";

const SETUP_GUIDANCE: Record<NovelSetupTargetKind, string> = {
  setupBible: "基于故事梗概先确定文风公约，再构建核心法则、地理生态、社会结构、历史文化、日常生活五维世界观。",
  setupCharacters: "基于已锁定的梗概和世界观创建主要人物、心理锚点、人物弧光、秘密、声线以及人物关系。",
  setupLocations: "从世界观与人物行动路径中提取可持续使用的地点系统，包含空间关系、场景规则、风险与叙事用途。",
  setupPlot: "规划主线、支线与暗线、汇流点，并构建部卷幕章故事树和逐章可执行大纲。",
};

const SETUP_OUTPUT_FIELDS: Record<NovelSetupTargetKind, string> = {
  setupBible: "styleGuide（含narrativeVoice、sentenceRhythm、dialogue、sensory、avoid、sample）、worldbuilding（含coreRules、geography、society、culture、dailyLife；每维含summary与details）",
  setupCharacters: "characters（每项含name、role、gender、age、description、appearance、personality、publicProfile、coreBelief、coreMotivation、innerLack、moralTaboos、voiceStyle）、relations（含from、to、relationType、description、strength）",
  setupLocations: "locations（每项含name、description、rules、region、risk、narrativeFunction、connections）",
  setupPlot: "storylines（含title、storylineType、goal、conflict、promiseTags、milestones）、volumes（含number、title、summary、startChapter、endChapter、acts；幕含number、title、summary、chapters；章含number、title、outline、goal、endingHook、targetWords）",
};

function isSetupTarget(kind: NovelTargetKind): kind is NovelSetupTargetKind {
  return kind === "setupBible" || kind === "setupCharacters" || kind === "setupLocations" || kind === "setupPlot";
}

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
  readonly promptOverride?: string;
  readonly modelOverride?: string;
  readonly temperatureOverride?: number;
  readonly onRequestPrepared?: (request: NovelPreparedRequest) => Promise<void>;
  readonly onChunk?: (chunk: string) => Promise<void>;
}

export interface NovelPreparedRequest {
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export function buildNovelSystemPrompt(targetKind: NovelTargetKind): string {
  if (targetKind === "chapter") {
    return "你是中文长篇小说写作助手。第一行必须是“标题：具体章名”，空一行后输出章节正文；章名需为2到20字且不得使用“第N章”占位名。不要解释，不要 Markdown 或 JSON。";
  }
  if (targetKind === "chapterRewrite") {
    return "你是中文长篇小说精修助手。只输出改写后的选区正文，不要标题、解释、Markdown 或 JSON；必须保持与选区前后文自然衔接。";
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
      `目标长度：约 ${input.targetChars ?? 3000} 个汉字；正文不得少于 ${Math.round((input.targetChars ?? 3000) * 0.9)} 个汉字，建议控制在 ${input.targetChars ?? 3000}–${Math.round((input.targetChars ?? 3000) * 1.1)} 个汉字。`,
      "请输出节奏完整、可直接展示给用户的正文。",
    ].filter(Boolean).join("\n\n");
  }

  if (input.targetKind === "chapterRewrite") {
    return [
      `作品：${input.projectTitle}`,
      input.chapterIndex ? `章节：第 ${input.chapterIndex} 章 ${input.chapterTitle || ""}` : "",
      input.userPrompt ? `改写要求：${input.userPrompt}` : "改写要求：提升表达与叙事张力。",
      input.chapterSummary ? `待改写选区：\n${input.chapterSummary}` : "",
      input.contextText ? `章节上下文与硬约束：\n${input.contextText}` : "",
      `目标长度：约 ${input.targetChars ?? 500} 字，不要明显偏离原选区长度。`,
      "只返回可直接替换选区的正文。",
    ].filter(Boolean).join("\n\n");
  }

  if (isSetupTarget(input.targetKind)) {
    return [
      `作品：${input.projectTitle}`,
      input.genre ? `锁定类型：${input.genre}` : "",
      `设置步骤：${input.targetKind}`,
      `生成目标：${SETUP_GUIDANCE[input.targetKind]}`,
      `输出结构：${SETUP_OUTPUT_FIELDS[input.targetKind]}`,
      input.targetKind === "setupPlot" && input.targetCount ? `目标章节总数：${input.targetCount} 章。volumes 内的 chapters 必须从第 1 章连续覆盖到第 ${input.targetCount} 章，不得缺章、跳号或提前写“大结局”；每章必须有具体 title。` : "",
      input.userPrompt ? `作者补充：${input.userPrompt}` : "",
      input.contextText ? `已确认资料：\n${input.contextText}` : "",
      "严格输出一个完整 JSON 对象；键名使用输出结构指定的英文键，不要 Markdown、注释或解释。",
      "所有字段内容使用中文；不得改变已锁定的故事梗概、类型与世界规则。",
    ].filter(Boolean).join("\n\n");
  }

  return "";
}
