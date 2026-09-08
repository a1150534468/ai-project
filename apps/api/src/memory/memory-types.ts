export const MEMORY_TYPES = ["CORE", "PERMANENT", "TEMPORARY", "KNOWLEDGE", "OTHER"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryShape {
  title: string;
  text: string;
  type: MemoryType;
  importance: number;
  tags: string[];
}

export interface MemoryRecord extends MemoryShape {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  usedCount: number;
}

interface MemoryShapeInput {
  title?: unknown;
  text?: unknown;
  type?: unknown;
  importance?: unknown;
  tags?: unknown;
}

/**
 * 所有长度上限都按 Unicode code point 计算，不按 UTF-16 code unit。
 * `String#slice` 会把边界上的 emoji 劈成半个代理项，进数据库时再被替换成 �；
 * `Array.from` 虽然仍把组合字素分开，但至少保证产出的每一个码点都是合法 Unicode。
 */
const chars = (text: string) => Array.from(text);
export const memoryTextLength = (text: string): number => chars(text).length;
const clip = (text: string, limit: number): string => chars(text).slice(0, limit).join("");

function objectInput(value: unknown): MemoryShapeInput | null {
  return typeof value === "object" && value !== null ? value : null;
}

export function normalizeMemoryType(value: unknown): MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value)
    ? (value as MemoryType)
    : "OTHER";
}

export function clampImportance(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 50;
  return Math.max(1, Math.min(100, Math.round(numeric)));
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = clip(item.normalize("NFKC").trim(), 20);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === 8) break;
  }
  return tags;
}

export function buildMemoryTitle(text: string, title?: string): string {
  const supplied = title?.normalize("NFKC").trim();
  if (supplied) return clip(supplied, 40);
  const compact = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  return clip(compact, 24) || "未命名记忆";
}

/** ADD 的缺省值在这里定；UPDATE 必须先与旧记录合并，不能拿这些缺省值覆盖旧字段。 */
export function sanitizeMemoryShape(value: unknown): MemoryShape | null {
  const input = objectInput(value);
  if (!input) return null;
  const text = typeof input.text === "string" ? input.text.normalize("NFKC").trim() : "";
  if (!text) return null;

  return {
    title: buildMemoryTitle(text, typeof input.title === "string" ? input.title : undefined),
    text: clip(text, 2000),
    type: normalizeMemoryType(input.type),
    importance: clampImportance(input.importance),
    tags: normalizeTags(input.tags),
  };
}

/**
 * 把模型的 UPDATE 动作并到它实际见过的旧记录上。字段缺失表示「保持」，显式传入才表示「改」；
 * 合并后仍走同一个 sanitizer，避免两条入口的 NFKC、截断和枚举规则漂移。
 */
export function mergeMemoryUpdate(existing: MemoryShape, value: unknown): MemoryShape | null {
  const input = objectInput(value);
  if (!input || typeof input.text !== "string") return null;
  return sanitizeMemoryShape({
    title: input.title === undefined ? existing.title : input.title,
    text: input.text,
    type: input.type === undefined ? existing.type : input.type,
    importance: input.importance === undefined ? existing.importance : input.importance,
    tags: input.tags === undefined ? existing.tags : input.tags,
  });
}
