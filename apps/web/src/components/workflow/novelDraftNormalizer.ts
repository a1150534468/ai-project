import type { NovelStageKind } from "../../api";

const FIELD_ALIASES: Partial<Record<NovelStageKind, Partial<Record<string, readonly string[]>>>> = {
  settings: {
    核心要求: ["coreRequirement", "core_requirement", "requirements", "brief"],
    频道: ["channel"],
    平台: ["platform", "platforms"],
    题材: ["topic", "topics", "genre", "genres", "theme", "themes"],
    视角: ["perspective", "pointOfView", "pov"],
    文风模式: ["styleMode", "tone", "writingMode"],
    年代: ["era", "period", "age"],
    是否金手指: ["hasCheat", "cheat", "goldFinger"],
    风格标签: ["styleTags", "tags"],
    语言: ["language", "lang"],
    章节规划: ["chapterPlan", "chapterPlanning", "chapterCount", "chapterChars", "chapters"],
    卖点: ["sellingPoints", "sellPoints", "coreSellingPoint", "hook", "hooks", "highlights"],
    目标读者: ["targetReaders", "audience", "reader", "readers"],
    前30章承诺: ["first30Chapters", "chapterPromises", "promises", "thirtyChapterPromises"],
  },
  macro: {
    故事引擎: ["storyEngine", "story_engine", "engine"],
    主线: ["mainLine", "main_line", "plot", "throughline"],
    长期对立: ["longConflict", "long_conflict", "conflict", "opposition"],
    节奏底盘: ["rhythm", "pace", "pacing", "cycle"],
    前30章承诺: ["first30Chapters", "first_30_chapters", "chapterPromises", "promises", "thirtyChapterPromises"],
  },
  world: {
    世界手册: ["worldManual", "worldbook", "overview", "setting", "background"],
    规则: ["rules", "laws"],
    势力: ["forces", "factions", "organizations", "groups"],
    地点: ["locations", "places", "regions"],
    关系: ["relationships", "relations"],
  },
  chars: {
    角色: ["characters", "chars", "cast"],
    关系网: ["relationshipMap", "relationships", "relations"],
  },
  volumes: {
    分卷: ["volumes", "volume", "arcs"],
  },
  outline: {
    章节列表: ["chapters", "chapterList", "outline"],
  },
  draft: {
    长篇记忆: ["longMemory", "memory", "continuity"],
  },
  style: {
    样文: ["sample", "samples", "sampleText"],
    写法名: ["styleName", "methodName", "name"],
    特征池: ["features", "featurePool", "traits"],
  },
};

const STRUCTURAL_JSON_KEYS = new Set(["genre", "kind", "project", "projectname", "projecttitle", "stage", "title"]);
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
const INCOMPLETE_JSON_NOTICE = "生成结果不完整，请重新生成。";

function normalizeJsonKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function normalizeFieldLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[【】#*_`\s_\-:：/、，,]/g, "");
}

function parseLegacyJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = jsonFragment(fenced?.[1] ?? trimmed);
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function jsonFragment(text: string): string {
  const candidate = text.trim();
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (objectStart >= 0 && objectEnd > objectStart && (arrayStart < 0 || objectStart < arrayStart)) {
    return candidate.slice(objectStart, objectEnd + 1);
  }
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return candidate.slice(arrayStart, arrayEnd + 1);
  }
  return candidate;
}

function looksLikeJsonText(text: string): boolean {
  const candidate = jsonFragment(text).trim();
  return candidate.startsWith("{") || candidate.startsWith("[");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldLabelMap(kind: NovelStageKind, fieldKeys: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const fieldKey of fieldKeys) {
    for (const alias of [fieldKey, ...(FIELD_ALIASES[kind]?.[fieldKey] ?? [])]) {
      map.set(normalizeFieldLabel(alias), fieldKey);
    }
  }
  return map;
}

function parsePlainHeading(line: string, labels: ReadonlyMap<string, string>): { readonly key: string; readonly rest: string } | null {
  const cleaned = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .trim();
  if (!cleaned) return null;

  const bracket = cleaned.match(/^【(.+?)】\s*(.*)$/);
  if (bracket) {
    const key = labels.get(normalizeFieldLabel(bracket[1]));
    if (key) return { key, rest: bracket[2].replace(/^[：:]\s*/, "") };
  }

  const colon = cleaned.match(/^(.{1,40}?)\s*[：:]\s*(.*)$/);
  if (colon) {
    const key = labels.get(normalizeFieldLabel(colon[1]));
    if (key) return { key, rest: colon[2] };
  }

  const key = labels.get(normalizeFieldLabel(cleaned));
  return key ? { key, rest: "" } : null;
}

function parsePlainFieldValues(kind: NovelStageKind, text: string, fieldKeys: readonly string[]) {
  const labels = fieldLabelMap(kind, fieldKeys);
  const values = new Map<string, string[]>();
  let currentKey = "";
  let matched = false;

  for (const line of text.split("\n")) {
    const heading = parsePlainHeading(line, labels);
    if (heading) {
      currentKey = heading.key;
      matched = true;
      if (heading.rest.trim()) values.set(currentKey, [...(values.get(currentKey) ?? []), heading.rest]);
      continue;
    }
    if (currentKey) values.set(currentKey, [...(values.get(currentKey) ?? []), line]);
  }

  return { matched, values } as const;
}

function parsePlainFieldBlocks(kind: NovelStageKind, text: string, fieldKeys: readonly string[]): string {
  const parsed = parsePlainFieldValues(kind, text, fieldKeys);
  if (!parsed.matched) return "";
  return fieldKeys
    .flatMap((fieldKey) => {
      const fieldText = (parsed.values.get(fieldKey) ?? []).join("\n").trim();
      return fieldText ? [`【${fieldKey}】\n${fieldText}`] : [];
    })
    .join("\n\n");
}

function collectJsonText(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectJsonText);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      STRUCTURAL_JSON_KEYS.has(normalizeJsonKey(key)) ? [] : collectJsonText(child),
    );
  }
  return [];
}

function uniqueText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function collectAliasedJsonText(value: unknown, aliases: readonly string[]): string[] {
  const aliasSet = new Set(aliases.map(normalizeJsonKey));
  const visit = (current: unknown): string[] => {
    if (Array.isArray(current)) return current.flatMap(visit);
    if (typeof current !== "object" || current === null) return [];
    return Object.entries(current).flatMap(([key, child]) => {
      const normalized = normalizeJsonKey(key);
      if (aliasSet.has(normalized)) return collectJsonText(child);
      if (STRUCTURAL_JSON_KEYS.has(normalized)) return [];
      return visit(child);
    });
  };
  return uniqueText(visit(value));
}

function collectAliasedJsonNodes(value: unknown, aliases: readonly string[]): unknown[] {
  const aliasSet = new Set(aliases.map(normalizeJsonKey));
  const visit = (current: unknown): unknown[] => {
    if (Array.isArray(current)) return current.flatMap(visit);
    if (!isRecord(current)) return [];
    return Object.entries(current).flatMap(([key, child]) => {
      const normalized = normalizeJsonKey(key);
      if (aliasSet.has(normalized)) return [child];
      if (STRUCTURAL_JSON_KEYS.has(normalized)) return [];
      return visit(child);
    });
  };
  return visit(value);
}

function formatValue(value: unknown): string {
  return collectJsonText(value).join("、").trim();
}

function firstAliasedEntry(record: Record<string, unknown>, aliases: readonly string[]) {
  const aliasSet = new Set(aliases.map(normalizeJsonKey));
  return Object.entries(record).find(([key]) => aliasSet.has(normalizeJsonKey(key)));
}

function formatRoleRecord(record: Record<string, unknown>): string {
  const used = new Set<string>();
  const nameEntry = firstAliasedEntry(record, ROLE_NAME_KEYS);
  if (nameEntry) used.add(nameEntry[0]);
  const lines: string[] = [];
  const name = nameEntry ? formatValue(nameEntry[1]) : "";
  if (name) lines.push(name);

  for (const group of ROLE_FIELD_GROUPS) {
    const entry = firstAliasedEntry(record, group.aliases);
    if (!entry) continue;
    used.add(entry[0]);
    const value = formatValue(entry[1]);
    if (value) lines.push(`${group.label}：${value}`);
  }

  for (const [key, value] of Object.entries(record)) {
    if (used.has(key) || STRUCTURAL_JSON_KEYS.has(normalizeJsonKey(key))) continue;
    const text = formatValue(value);
    if (text) lines.push(`${key}：${text}`);
  }
  return lines.join("\n").trim();
}

function formatRoleNodes(nodes: readonly unknown[]): string {
  return uniqueText(nodes.flatMap((node) => {
    const values = Array.isArray(node) ? node : [node];
    return values.map((item) => isRecord(item) ? formatRoleRecord(item) : formatValue(item));
  })).join("\n\n");
}

function formatGroupedRecord(record: Record<string, unknown>, groups: readonly { readonly label: string; readonly aliases: readonly string[] }[]): string {
  const used = new Set<string>();
  const lines: string[] = [];
  for (const group of groups) {
    const entry = firstAliasedEntry(record, group.aliases);
    if (!entry) continue;
    used.add(entry[0]);
    const value = formatValue(entry[1]);
    if (value) lines.push(`${group.label}：${value}`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (used.has(key) || STRUCTURAL_JSON_KEYS.has(normalizeJsonKey(key))) continue;
    const text = formatValue(value);
    if (text) lines.push(`${key}：${text}`);
  }
  return lines.join("\n").trim();
}

function formatGroupedNodes(nodes: readonly unknown[], groups: readonly { readonly label: string; readonly aliases: readonly string[] }[]): string {
  return uniqueText(nodes.flatMap((node) => {
    const values = Array.isArray(node) ? node : [node];
    return values.map((item) => isRecord(item) ? formatGroupedRecord(item, groups) : formatValue(item));
  })).join("\n\n");
}

function characterJsonBlocks(value: unknown, fieldKeys: readonly string[]): string[] {
  const blocks: string[] = [];
  if (fieldKeys.includes("角色")) {
    const roleNodes = collectAliasedJsonNodes(value, ["角色", "characters", "chars", "cast"]);
    const roles = formatRoleNodes(roleNodes.length > 0 ? roleNodes : Array.isArray(value) ? value : []);
    if (roles) blocks.push(`【角色】\n${roles}`);
  }
  if (fieldKeys.includes("关系网")) {
    const relationshipEntry = isRecord(value) ? firstAliasedEntry(value, ["关系网", "relationshipMap", "relationship_map", "relationships", "relations"]) : undefined;
    const relationships = relationshipEntry ? collectJsonText(relationshipEntry[1]).join("\n").trim() : "";
    if (relationships) blocks.push(`【关系网】\n${relationships}`);
  }
  return blocks;
}

function volumeJsonBlocks(value: unknown, fieldKeys: readonly string[]): string[] {
  if (!fieldKeys.includes("分卷")) return [];
  const nodes = collectAliasedJsonNodes(value, ["分卷", "volumes", "volume", "arcs"]);
  const volumes = formatGroupedNodes(nodes.length > 0 ? nodes : Array.isArray(value) ? value : [], VOLUME_FIELD_GROUPS);
  return volumes ? [`【分卷】\n${volumes}`] : [];
}

function outlineJsonBlocks(value: unknown, fieldKeys: readonly string[]): string[] {
  if (!fieldKeys.includes("章节列表")) return [];
  const nodes = collectAliasedJsonNodes(value, ["章节列表", "chapters", "chapterList", "outline"]);
  const chapters = formatGroupedNodes(nodes.length > 0 ? nodes : Array.isArray(value) ? value : [], CHAPTER_FIELD_GROUPS);
  return chapters ? [`【章节列表】\n${chapters}`] : [];
}

function normalizePlainJsonFieldBlocks(kind: NovelStageKind, text: string, fieldKeys: readonly string[]): string {
  const parsed = parsePlainFieldValues(kind, text, fieldKeys);
  if (!parsed.matched) return "";
  const fieldText = (fieldKey: string) => (parsed.values.get(fieldKey) ?? []).join("\n").trim();
  if (kind === "chars") {
    const blocks: string[] = [];
    const roleText = fieldText("角色");
    const roleValue = parseLegacyJsonText(roleText);
    const roleBlocks = roleValue === undefined || typeof roleValue === "string" ? [] : characterJsonBlocks(roleValue, ["角色"]);
    if (roleBlocks.length > 0) blocks.push(...roleBlocks);
    else if (roleText) blocks.push(`【角色】\n${roleText}`);

    const relationshipText = fieldText("关系网");
    const relationshipValue = parseLegacyJsonText(relationshipText);
    const relationshipBlocks = relationshipValue === undefined || typeof relationshipValue === "string" ? [] : characterJsonBlocks(relationshipValue, ["关系网"]);
    if (relationshipBlocks.length > 0) blocks.push(...relationshipBlocks);
    else if (relationshipText) blocks.push(`【关系网】\n${relationshipText}`);
    return blocks.join("\n\n");
  }
  if (kind === "volumes") {
    const text = fieldText("分卷");
    const value = parseLegacyJsonText(text);
    if (value === undefined && looksLikeJsonText(text)) return `【分卷】\n${INCOMPLETE_JSON_NOTICE}`;
    return value === undefined || typeof value === "string" ? "" : volumeJsonBlocks(value, ["分卷"]).join("\n\n");
  }
  if (kind === "outline") {
    const text = fieldText("章节列表");
    const value = parseLegacyJsonText(text);
    if (value === undefined && looksLikeJsonText(text)) return `【章节列表】\n${INCOMPLETE_JSON_NOTICE}`;
    return value === undefined || typeof value === "string" ? "" : outlineJsonBlocks(value, ["章节列表"]).join("\n\n");
  }
  return "";
}

export function normalizeNovelDraftText(kind: NovelStageKind, text: string, fieldKeys: readonly string[]): string {
  if (!text.trim()) return text;
  const repairedBlocks = normalizePlainJsonFieldBlocks(kind, text, fieldKeys);
  if (repairedBlocks) return repairedBlocks;
  const value = parseLegacyJsonText(text);
  if (value === undefined && looksLikeJsonText(text)) return INCOMPLETE_JSON_NOTICE;
  if (value === undefined || typeof value === "string") {
    return parsePlainFieldBlocks(kind, text, fieldKeys) || text;
  }
  if (kind === "chars") {
    const blocks = characterJsonBlocks(value, fieldKeys);
    if (blocks.length > 0) return blocks.join("\n\n");
  }
  if (kind === "volumes") {
    const blocks = volumeJsonBlocks(value, fieldKeys);
    if (blocks.length > 0) return blocks.join("\n\n");
  }
  if (kind === "outline") {
    const blocks = outlineJsonBlocks(value, fieldKeys);
    if (blocks.length > 0) return blocks.join("\n\n");
  }
  const blocks = fieldKeys.flatMap((fieldKey) => {
    const aliases = [fieldKey, ...(FIELD_ALIASES[kind]?.[fieldKey] ?? [])];
    const fieldText = collectAliasedJsonText(value, aliases).join("\n").trim();
    return fieldText ? [`【${fieldKey}】\n${fieldText}`] : [];
  });
  return blocks.length > 0 ? blocks.join("\n\n") : text;
}
