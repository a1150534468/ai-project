import type { NovelTargetKind } from "./novel-types.js";

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
  if (objectStart >= 0 && objectEnd > objectStart) return candidate.slice(objectStart, objectEnd + 1);
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
  if (kind !== "chapter" && kind !== "chapterRewrite" && !isRecord(parsed)) throw new InvalidGeneratedNovelJsonError();
  return parsed;
}

function collectVisibleValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectVisibleValues);
  if (isRecord(value)) return Object.values(value).flatMap(collectVisibleValues);
  return [];
}

function chapterDisplayText(value: unknown): string {
  if (isRecord(value) && typeof value.content === "string") return value.content.trim();
  if (typeof value === "string") return value.trim();
  return collectVisibleValues(value).join("\n").trim();
}

export function visibleCharCount(text: string): number {
  return Array.from(text).filter((char) => !/\s/u.test(char)).length;
}

export function extractBillableText(kind: NovelTargetKind, raw: unknown): string {
  const value = parseGeneratedNovelValue(raw);
  return kind === "chapter" || kind === "chapterRewrite" ? chapterDisplayText(value) : collectVisibleValues(value).join("\n").trim();
}

export function billableCharCount(kind: NovelTargetKind, raw: unknown): number {
  return visibleCharCount(extractBillableText(kind, raw));
}

export function formatGeneratedNovelDisplayText(kind: NovelTargetKind, raw: unknown): string {
  const value = parseGeneratedNovelValue(raw);
  if (kind === "chapter" || kind === "chapterRewrite") return chapterDisplayText(value);
  return JSON.stringify(value, null, 2);
}
