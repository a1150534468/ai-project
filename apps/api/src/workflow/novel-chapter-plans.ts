export interface NovelChapterPlan {
  readonly chapterIndex: number;
  readonly title: string;
  readonly summary: string;
}

const MAX_CHAPTER_PLANS = 500;
const INDEX_ALIASES = ["index", "chapterIndex", "chapterNo", "chapterNumber", "number", "序号", "章节序号", "章号", "章节", "chapter", "章序"] as const;
const TITLE_ALIASES = ["title", "name", "标题", "章节标题"] as const;
const SUMMARY_ALIASES = ["summary", "摘要", "概要", "剧情", "内容", "chapterSummary"] as const;
const GOAL_ALIASES = ["goal", "chapterGoal", "objective", "本章目标", "本章目的", "目的", "目标"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join("\n");
  if (isRecord(value)) return Object.values(value).map(compactValue).filter(Boolean).join("\n");
  return "";
}

function firstAliasedValue(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  const aliasSet = new Set(aliases.map(normalizeKey));
  return Object.entries(record).find(([key]) => aliasSet.has(normalizeKey(key)))?.[1];
}

function parseChapterIndex(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const match = compactValue(value).match(/\d+/u);
  const parsed = match ? Number.parseInt(match[0], 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function chapterPlanFromRecord(record: Record<string, unknown>, fallbackIndex: number): NovelChapterPlan {
  const chapterIndex = parseChapterIndex(firstAliasedValue(record, INDEX_ALIASES), fallbackIndex);
  const title = compactValue(firstAliasedValue(record, TITLE_ALIASES)) || `第 ${chapterIndex} 章`;
  const summary = compactValue(firstAliasedValue(record, SUMMARY_ALIASES));
  const goal = compactValue(firstAliasedValue(record, GOAL_ALIASES));
  return {
    chapterIndex,
    title,
    summary: [summary, goal ? `本章目标：${goal}` : ""].filter(Boolean).join("\n"),
  };
}

function collectAliasedNodes(value: unknown, aliases: readonly string[]): unknown[] {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const visit = (current: unknown): unknown[] => {
    if (Array.isArray(current)) return current.flatMap(visit);
    if (!isRecord(current)) return [];
    return Object.entries(current).flatMap(([key, child]) => {
      if (aliasSet.has(normalizeKey(key))) return Array.isArray(child) ? child : [child];
      return visit(child);
    });
  };
  return visit(value);
}

function dedupePlans(plans: readonly NovelChapterPlan[]): readonly NovelChapterPlan[] {
  const seen = new Set<number>();
  const output: NovelChapterPlan[] = [];
  for (const plan of plans) {
    if (seen.has(plan.chapterIndex)) continue;
    seen.add(plan.chapterIndex);
    output.push(plan);
    if (output.length >= MAX_CHAPTER_PLANS) break;
  }
  return output;
}

export function chapterPlansFromOutlineValue(value: unknown): readonly NovelChapterPlan[] {
  const nodes = collectAliasedNodes(value, ["章节列表", "chapters", "chapterList", "outline"]);
  const source = nodes.length > 0 ? nodes : Array.isArray(value) ? value : [];
  return dedupePlans(source.flatMap((node, index) => isRecord(node) ? [chapterPlanFromRecord(node, index + 1)] : []));
}

function outlineBody(text: string): string {
  const marker = "【章节列表】";
  const markerIndex = text.indexOf(marker);
  return markerIndex >= 0 ? text.slice(markerIndex + marker.length).trim() : text.trim();
}

function parseLineBlock(block: string, fallbackIndex: number): NovelChapterPlan | null {
  const fields = new Map<string, string[]>();
  let currentKey = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^第\s*\d+\s*(个)?章(节)?$/u.test(line)) continue;
    const match = line.match(/^(.{1,20}?)\s*[：:]\s*(.*)$/u);
    if (match) {
      currentKey = normalizeKey(match[1]);
      fields.set(currentKey, [...(fields.get(currentKey) ?? []), match[2]]);
      continue;
    }
    if (currentKey) fields.set(currentKey, [...(fields.get(currentKey) ?? []), line]);
  }
  const read = (aliases: readonly string[]): string => {
    for (const alias of aliases) {
      const value = fields.get(normalizeKey(alias))?.join("\n").trim();
      if (value) return value;
    }
    return "";
  };
  const chapterIndex = parseChapterIndex(read(INDEX_ALIASES), fallbackIndex);
  const explicitTitle = read(TITLE_ALIASES) || block.match(/第\s*\d+\s*章\s*([^\n]+)/u)?.[1]?.trim() || "";
  const summary = read(SUMMARY_ALIASES);
  const goal = read(GOAL_ALIASES);
  if (!explicitTitle && !summary && !goal) return null;
  return {
    chapterIndex,
    title: explicitTitle || `第 ${chapterIndex} 章`,
    summary: [summary, goal ? `本章目标：${goal}` : ""].filter(Boolean).join("\n"),
  };
}

export function chapterPlansFromOutlineText(text: string): readonly NovelChapterPlan[] {
  const body = outlineBody(text);
  if (!body) return [];
  return dedupePlans(body
    .split(/\n\s*\n+/u)
    .map((block, index) => parseLineBlock(block, index + 1))
    .filter((plan): plan is NovelChapterPlan => plan !== null));
}

export function chapterPlansFromOutline(args: { readonly displayText: string; readonly structuredJson: unknown }): readonly NovelChapterPlan[] {
  const fromJson = chapterPlansFromOutlineValue(args.structuredJson);
  return fromJson.length > 0 ? fromJson : chapterPlansFromOutlineText(args.displayText);
}
