export const MEMORY_TYPES = [
  "CORE",
  "PERMANENT",
  "TEMPORARY",
  "KNOWLEDGE",
  "OTHER",
] as const;

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

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

function isMemoryShapeInput(value: unknown): value is MemoryShapeInput {
  return typeof value === "object" && value !== null;
}

export function normalizeMemoryType(value: unknown): MemoryType {
  return typeof value === "string" && isMemoryType(value) ? value : "OTHER";
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

    const tag = item.normalize("NFKC").trim().slice(0, 20);
    if (!tag || seen.has(tag)) continue;

    seen.add(tag);
    tags.push(tag);

    if (tags.length >= 8) break;
  }

  return tags;
}

export function buildMemoryTitle(text: string, title?: string): string {
  const fromTitle = title?.normalize("NFKC").trim();
  if (fromTitle) return fromTitle.slice(0, 40);

  const compact = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  return compact.slice(0, 24) || "未命名记忆";
}

export function sanitizeMemoryShape(input: unknown): MemoryShape | null {
  if (!isMemoryShapeInput(input)) return null;

  const text = typeof input.text === "string" ? input.text.normalize("NFKC").trim() : "";
  if (!text) return null;

  return {
    title: buildMemoryTitle(text, typeof input.title === "string" ? input.title : undefined),
    text: text.slice(0, 2000),
    type: normalizeMemoryType(input.type),
    importance: clampImportance(input.importance),
    tags: normalizeTags(input.tags),
  };
}
