import type { NovelTargetKind } from "./novel-types.js";

type SectionField = {
  readonly heading: string;
  readonly aliases: readonly string[];
};

type PlainSectionEntry = {
  readonly field: SectionField;
  readonly text: string;
};

const STRUCTURAL_KEYS = new Set(["genre", "kind", "project", "projecttitle", "projectname", "stage", "title"]);
const ROLE_NAME_KEYS = ["name", "名字", "名称", "角色名", "名"] as const;
const ROLE_FIELD_GROUPS = [
  { label: "身份锚点", aliases: ["身份锚点", "identityAnchor", "identity_anchor", "identity", "身份", "定位", "身份信息"] },
  { label: "动机", aliases: ["动机", "动", "motivation", "motive", "goal", "goals", "目标", "核心动机"] },
  { label: "关系", aliases: ["关系", "relationship", "relationships", "relations", "关系网"] },
] as const;
const VOLUME_FIELD_GROUPS = [
  { label: "标题", aliases: ["title", "name", "标题", "卷名", "名称"] },
  { label: "战略", aliases: ["strategy", "战略", "主题", "目标", "卷目标", "主线目标", "核心目标", "arc", "volumeGoal", "mainGoal"] },
  { label: "骨架", aliases: ["skeleton", "骨架", "核心事件", "章节设计", "结构", "大纲", "outline", "概要", "summary", "beats", "events"] },
] as const;
const CHAPTER_FIELD_GROUPS = [
  { label: "序号", aliases: ["index", "chapterIndex", "chapterNo", "chapterNumber", "number", "序号", "章节序号", "章号", "章节", "chapter", "章序"] },
  { label: "标题", aliases: ["title", "name", "标题", "章节标题"] },
  { label: "摘要", aliases: ["summary", "摘要", "概要", "剧情", "内容", "chapterSummary"] },
  { label: "本章目标", aliases: ["goal", "chapterGoal", "objective", "本章目标", "本章目的", "目的", "目标"] },
] as const;

const SECTION_FIELDS = {
  settings: [
    { heading: "核心要求", aliases: ["核心要求", "corerequirement", "requirements", "brief"] },
    { heading: "频道", aliases: ["频道", "channel"] },
    { heading: "平台", aliases: ["平台", "platform", "platforms"] },
    { heading: "题材", aliases: ["题材", "topic", "topics", "genre", "genres", "theme", "themes"] },
    { heading: "视角", aliases: ["视角", "perspective", "pointofview", "pov"] },
    { heading: "文风模式", aliases: ["文风模式", "stylemode", "tone", "writingmode"] },
    { heading: "年代", aliases: ["年代", "era", "period", "age"] },
    { heading: "是否金手指", aliases: ["是否金手指", "hascheat", "cheat", "goldfinger"] },
    { heading: "风格标签", aliases: ["风格标签", "styletags", "tags"] },
    { heading: "语言", aliases: ["语言", "language", "lang"] },
    { heading: "章节规划", aliases: ["章节规划", "chapterplan", "chapterplanning", "chaptercount", "chapterchars", "chapters"] },
    { heading: "卖点", aliases: ["卖点", "sellingpoints", "sellpoints", "coresellingpoint", "hook", "hooks", "highlights"] },
    { heading: "目标读者", aliases: ["目标读者", "targetreaders", "audience", "reader", "readers"] },
    { heading: "前30章承诺", aliases: ["前30章承诺", "first30chapters", "chapterpromises", "promises", "thirtychapterpromises"] },
  ],
  macro: [
    { heading: "故事引擎", aliases: ["故事引擎", "storyengine", "engine"] },
    { heading: "主线", aliases: ["主线", "mainline", "plot", "throughline"] },
    { heading: "长期对立", aliases: ["长期对立", "longconflict", "conflict", "opposition"] },
    { heading: "节奏底盘", aliases: ["节奏底盘", "rhythm", "pace", "pacing", "cycle"] },
    { heading: "前30章承诺", aliases: ["前30章承诺", "first30chapters", "chapterpromises", "promises", "thirtychapterpromises"] },
  ],
  world: [
    { heading: "世界手册", aliases: ["世界手册", "worldmanual", "worldbook", "overview", "setting", "background"] },
    { heading: "规则", aliases: ["规则", "rules", "laws"] },
    { heading: "势力", aliases: ["势力", "forces", "factions", "organizations", "groups"] },
    { heading: "地点", aliases: ["地点", "locations", "places", "regions"] },
    { heading: "关系", aliases: ["关系", "relationships", "relations"] },
  ],
  chars: [
    { heading: "角色", aliases: ["角色", "characters", "chars", "cast"] },
    { heading: "关系网", aliases: ["关系网", "relationshipmap", "relationships", "relations"] },
  ],
  volumes: [
    { heading: "分卷", aliases: ["分卷", "volumes", "volume", "arcs"] },
  ],
  outline: [
    { heading: "章节列表", aliases: ["章节列表", "chapters", "chapterlist", "outline"] },
  ],
  draft: [
    { heading: "长篇记忆", aliases: ["长篇记忆", "longmemory", "memory", "continuity"] },
  ],
  style: [
    { heading: "样文", aliases: ["样文", "sample", "samples", "sampletext"] },
    { heading: "写法名", aliases: ["写法名", "stylename", "methodname", "name"] },
    { heading: "特征池", aliases: ["特征池", "features", "featurepool", "traits"] },
  ],
} as const satisfies Partial<Record<NovelTargetKind, readonly SectionField[]>>;

function fieldsForKind(kind: NovelTargetKind): readonly SectionField[] {
  if (kind === "chapter") return [];
  return SECTION_FIELDS[kind] ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonFragment(text: string): string {
  const candidate = text.trim();
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart)) {
    return candidate.slice(arrayStart, arrayEnd + 1);
  }
  if (objectStart >= 0 && objectEnd > objectStart) {
    return candidate.slice(objectStart, objectEnd + 1);
  }
  return candidate;
}

export function parseGeneratedNovelValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (!text) return "";
  try {
    return JSON.parse(jsonFragment(text));
  } catch {
    return text;
  }
}

export class InvalidGeneratedNovelJsonError extends Error {
  constructor() {
    super("AI 生成结果不是完整 JSON，已取消保存，请重新生成。");
    this.name = "InvalidGeneratedNovelJsonError";
  }
}

export function parseRequiredGeneratedNovelValue(kind: NovelTargetKind, raw: unknown): unknown {
  const parsed = parseGeneratedNovelValue(raw);
  if (kind !== "chapter" && typeof parsed === "string") {
    throw new InvalidGeneratedNovelJsonError();
  }
  return parsed;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function normalizeFieldLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[【】#*_`\s_\-:：/、，,]/g, "");
}

function collectDisplayValues(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectDisplayValues);
  if (isRecord(value)) return Object.values(value).flatMap(collectDisplayValues);
  return [];
}

function plainHeading(line: string, fields: readonly SectionField[]): { readonly field: SectionField; readonly rest: string } | null {
  const cleaned = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .trim();
  if (!cleaned) return null;

  const findField = (label: string): SectionField | undefined => {
    const normalized = normalizeFieldLabel(label);
    return fields.find((field) => [field.heading, ...field.aliases].some((alias) => normalizeFieldLabel(alias) === normalized));
  };

  const bracket = cleaned.match(/^【(.+?)】\s*(.*)$/);
  if (bracket) {
    const field = findField(bracket[1]);
    if (field) return { field, rest: bracket[2].replace(/^[：:]\s*/, "") };
  }

  const colon = cleaned.match(/^(.{1,40}?)\s*[：:]\s*(.*)$/);
  if (colon) {
    const field = findField(colon[1]);
    if (field) return { field, rest: colon[2] };
  }

  const field = findField(cleaned);
  return field ? { field, rest: "" } : null;
}

function plainSectionEntries(kind: NovelTargetKind, text: string): PlainSectionEntry[] {
  const fields = fieldsForKind(kind);
  if (fields.length === 0) return [];
  const values = new Map<string, string[]>();
  let currentHeading = "";
  let matched = false;

  for (const line of text.split("\n")) {
    const heading = plainHeading(line, fields);
    if (heading) {
      currentHeading = heading.field.heading;
      matched = true;
      if (heading.rest.trim()) values.set(currentHeading, [...(values.get(currentHeading) ?? []), heading.rest]);
      continue;
    }
    if (currentHeading) values.set(currentHeading, [...(values.get(currentHeading) ?? []), line]);
  }

  if (!matched) return [];
  return fields.flatMap((field) => {
    const textValue = (values.get(field.heading) ?? []).join("\n").trim();
    return textValue ? [{ field, text: textValue }] : [];
  });
}

function plainSectionValues(kind: NovelTargetKind, text: string): string[] {
  return plainSectionEntries(kind, text).map((entry) => entry.text);
}

function plainSectionBlocks(kind: NovelTargetKind, text: string): string[] {
  return plainSectionEntries(kind, text).map((entry) => `【${entry.field.heading}】\n${entry.text}`);
}

function collectSectionValues(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectSectionValues);
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      STRUCTURAL_KEYS.has(normalizeKey(key)) ? [] : collectSectionValues(child),
    );
  }
  return [];
}

function uniqueNonEmpty(values: readonly string[]): string[] {
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

function collectAliasedValues(value: unknown, aliases: readonly string[]): string[] {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const visit = (current: unknown): string[] => {
    if (Array.isArray(current)) return current.flatMap(visit);
    if (!isRecord(current)) return [];
    return Object.entries(current).flatMap(([key, child]) => {
      const normalized = normalizeKey(key);
      if (aliasSet.has(normalized)) return collectSectionValues(child);
      if (STRUCTURAL_KEYS.has(normalized)) return [];
      return visit(child);
    });
  };
  return uniqueNonEmpty(visit(value));
}

function collectAliasedNodes(value: unknown, aliases: readonly string[]): unknown[] {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const visit = (current: unknown): unknown[] => {
    if (Array.isArray(current)) return current.flatMap(visit);
    if (!isRecord(current)) return [];
    return Object.entries(current).flatMap(([key, child]) => {
      const normalized = normalizeKey(key);
      if (aliasSet.has(normalized)) return [child];
      if (STRUCTURAL_KEYS.has(normalized)) return [];
      return visit(child);
    });
  };
  return visit(value);
}

function compactDisplayValue(value: unknown): string {
  return collectDisplayValues(value).join("、").trim();
}

function firstAliasedEntry(record: Record<string, unknown>, aliases: readonly string[]) {
  const aliasSet = new Set(aliases.map(normalizeKey));
  return Object.entries(record).find(([key]) => aliasSet.has(normalizeKey(key)));
}

function formatRoleRecord(record: Record<string, unknown>): string {
  const used = new Set<string>();
  const nameEntry = firstAliasedEntry(record, ROLE_NAME_KEYS);
  if (nameEntry) used.add(nameEntry[0]);
  const lines: string[] = [];
  const name = nameEntry ? compactDisplayValue(nameEntry[1]) : "";
  if (name) lines.push(name);

  for (const group of ROLE_FIELD_GROUPS) {
    const entry = firstAliasedEntry(record, group.aliases);
    if (!entry) continue;
    used.add(entry[0]);
    const value = compactDisplayValue(entry[1]);
    if (value) lines.push(`${group.label}：${value}`);
  }

  for (const [key, value] of Object.entries(record)) {
    if (used.has(key) || STRUCTURAL_KEYS.has(normalizeKey(key))) continue;
    const text = compactDisplayValue(value);
    if (text) lines.push(`${key}：${text}`);
  }
  return lines.join("\n").trim();
}

function formatRoleNodes(nodes: readonly unknown[]): string {
  return uniqueNonEmpty(nodes.flatMap((node) => {
    const values = Array.isArray(node) ? node : [node];
    return values.map((item) => isRecord(item) ? formatRoleRecord(item) : compactDisplayValue(item));
  })).join("\n\n");
}

function formatGroupedRecord(record: Record<string, unknown>, groups: readonly { readonly label: string; readonly aliases: readonly string[] }[]): string {
  const used = new Set<string>();
  const lines: string[] = [];
  for (const group of groups) {
    const entry = firstAliasedEntry(record, group.aliases);
    if (!entry) continue;
    used.add(entry[0]);
    const value = compactDisplayValue(entry[1]);
    if (value) lines.push(`${group.label}：${value}`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (used.has(key) || STRUCTURAL_KEYS.has(normalizeKey(key))) continue;
    const text = compactDisplayValue(value);
    if (text) lines.push(`${key}：${text}`);
  }
  return lines.join("\n").trim();
}

function formatGroupedNodes(nodes: readonly unknown[], groups: readonly { readonly label: string; readonly aliases: readonly string[] }[]): string {
  return uniqueNonEmpty(nodes.flatMap((node) => {
    const values = Array.isArray(node) ? node : [node];
    return values.map((item) => isRecord(item) ? formatGroupedRecord(item, groups) : compactDisplayValue(item));
  })).join("\n\n");
}

function characterDisplayBlocks(value: unknown): string[] {
  const blocks: string[] = [];
  const roleNodes = collectAliasedNodes(value, ["角色", "characters", "chars", "cast"]);
  const roles = formatRoleNodes(roleNodes.length > 0 ? roleNodes : Array.isArray(value) ? value : []);
  if (roles) blocks.push(`【角色】\n${roles}`);
  const relationshipEntry = isRecord(value) ? firstAliasedEntry(value, ["关系网", "relationshipMap", "relationship_map", "relationships", "relations"]) : undefined;
  const relationships = relationshipEntry ? collectDisplayValues(relationshipEntry[1]).join("\n").trim() : "";
  if (relationships) blocks.push(`【关系网】\n${relationships}`);
  return blocks;
}

function volumeDisplayBlocks(value: unknown): string[] {
  const nodes = collectAliasedNodes(value, ["分卷", "volumes", "volume", "arcs"]);
  const volumes = formatGroupedNodes(nodes.length > 0 ? nodes : Array.isArray(value) ? value : [], VOLUME_FIELD_GROUPS);
  return volumes ? [`【分卷】\n${volumes}`] : [];
}

function outlineDisplayBlocks(value: unknown): string[] {
  const nodes = collectAliasedNodes(value, ["章节列表", "chapters", "chapterList", "outline"]);
  const chapters = formatGroupedNodes(nodes.length > 0 ? nodes : Array.isArray(value) ? value : [], CHAPTER_FIELD_GROUPS);
  return chapters ? [`【章节列表】\n${chapters}`] : [];
}

function sectionValues(kind: NovelTargetKind, value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = plainSectionValues(kind, value);
    return parsed.length > 0 ? parsed : collectSectionValues(value);
  }
  const fields = fieldsForKind(kind);
  const matched = uniqueNonEmpty(fields.flatMap((field) => collectAliasedValues(value, field.aliases)));
  return matched.length > 0 ? matched : uniqueNonEmpty(collectSectionValues(value));
}

function chapterDisplayText(value: unknown): string {
  if (isRecord(value) && typeof value.content === "string") return value.content.trim();
  return collectDisplayValues(value).join("\n").trim();
}

export function visibleCharCount(text: string): number {
  return Array.from(text).filter((char) => !/\s/u.test(char)).length;
}

export function extractBillableText(kind: NovelTargetKind, raw: unknown): string {
  const value = parseGeneratedNovelValue(raw);
  if (kind === "chapter") return chapterDisplayText(value);
  return sectionValues(kind, value).join("\n").trim();
}

export function billableCharCount(kind: NovelTargetKind, raw: unknown): number {
  return visibleCharCount(extractBillableText(kind, raw));
}

export function formatGeneratedNovelDisplayText(kind: NovelTargetKind, raw: unknown): string {
  const value = parseGeneratedNovelValue(raw);
  if (kind === "chapter") return chapterDisplayText(value);
  if (typeof value === "string") {
    const blocks = plainSectionBlocks(kind, value);
    return (blocks.length > 0 ? blocks.join("\n\n") : value).trim();
  }
  if (kind === "chars") {
    const blocks = characterDisplayBlocks(value);
    if (blocks.length > 0) return blocks.join("\n\n");
  }
  if (kind === "volumes") {
    const blocks = volumeDisplayBlocks(value);
    if (blocks.length > 0) return blocks.join("\n\n");
  }
  if (kind === "outline") {
    const blocks = outlineDisplayBlocks(value);
    if (blocks.length > 0) return blocks.join("\n\n");
  }
  const fields = fieldsForKind(kind);
  const blocks = fields.flatMap((field) => {
    const text = collectAliasedValues(value, field.aliases).join("\n").trim();
    return text ? [`【${field.heading}】\n${text}`] : [];
  });
  return (blocks.length > 0 ? blocks : sectionValues(kind, value)).join("\n\n").trim();
}
