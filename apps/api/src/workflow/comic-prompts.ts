export interface ComicBiblePromptProject {
  readonly title: string;
  readonly logline: string;
  readonly style: string;
}

export interface ComicBiblePromptEpisode {
  readonly title: string;
  readonly summary: string;
  readonly targetDurationSec: number;
}

export interface ComicBiblePromptEntry {
  readonly category: string;
  readonly title: string;
  readonly content: string;
}

export interface BuildComicBiblePromptContextArgs {
  readonly project: ComicBiblePromptProject;
  readonly episode?: ComicBiblePromptEpisode;
  readonly bibleEntries: readonly ComicBiblePromptEntry[];
}

export interface BuildComicScriptPromptArgs {
  readonly projectTitle: string;
  readonly bibleContext: string;
  readonly userPrompt: string;
  readonly targetDurationSec: number;
}

const COMIC_FORBIDDEN_TERMS = [
  `white${"Model"}`,
  `white-${"model"}`,
  `shot_${"white"}_${"model"}`,
  `Blen${"der"}`,
  `blen${"der"}`,
  `白${"模"}`,
] as const;

function compactLines(lines: readonly string[]): string {
  return lines.map((line) => line.trim()).filter(Boolean).join("\n");
}

export function containsComicForbiddenTerms(text: string): boolean {
  return COMIC_FORBIDDEN_TERMS.some((term) => text.includes(term));
}

export function buildComicBiblePromptContext(args: BuildComicBiblePromptContextArgs): string {
  const entryLines = args.bibleEntries.map((entry) => `- ${entry.category}｜${entry.title}：${entry.content}`);
  return compactLines([
    `项目：${args.project.title}`,
    args.project.logline ? `一句话：${args.project.logline}` : "",
    args.project.style ? `视觉风格：${args.project.style}` : "",
    args.episode ? `当前剧集：${args.episode.title}` : "",
    args.episode?.summary ? `剧集摘要：${args.episode.summary}` : "",
    args.episode ? `目标时长：${args.episode.targetDurationSec} 秒` : "",
    entryLines.length > 0 ? "设定资料：" : "",
    ...entryLines,
  ]);
}

export function buildComicScriptPrompt(args: BuildComicScriptPromptArgs): string {
  return compactLines([
    "你是漫剧编剧，请输出适合图片分镜与图生视频生产的剧集脚本。",
    `项目：${args.projectTitle}`,
    `目标时长：${args.targetDurationSec} 秒`,
    "设定上下文：",
    args.bibleContext,
    "用户要求：",
    args.userPrompt,
    "输出要求：包含场景、角色动作、对白、镜头节奏；不要输出额外解释。",
  ]);
}
