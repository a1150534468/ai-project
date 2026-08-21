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

function parseTitledChapterText(value: string): { title: string; content: string } | null {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  const matched = /^(?:章节标题|标题)\s*[:：]\s*([^\n]{2,80})\n+([\s\S]+)$/u.exec(normalized);
  if (!matched) return null;
  const title = matched[1]!.replace(/^[《“「『]|[》”」』]$/gu, "").trim().slice(0, 80);
  const content = matched[2]!.trim();
  return title && content ? { title, content } : null;
}

export function isPlaceholderNovelChapterTitle(value: string): boolean {
  return /^第\s*\d+\s*章$/u.test(value.trim());
}

export function inferNovelChapterTitle(content: string, chapterIndex: number): string {
  const sentences = content.replace(/\r\n?/gu, "\n").split(/(?<=[。！？?!])|\n+/u).map((item) => item.trim()).filter((item) => item.length >= 4);
  const keywords = /(真相|秘密|协议|逻辑锁|源码|碎片|反击|追踪|死循环|崩溃|危机|抹杀|觉醒|背叛|决战|逃亡|交易|悬赏|锚点|陷阱|突破)/u;
  const boilerplate = /(物理法则锁定率|神经元负载|冷却泵|隐秘节点·起源机房)/u;
  const selected = [...sentences].sort((a, b) => {
    const score = (value: string) => (keywords.test(value) ? 5 : 0) - (boilerplate.test(value) ? 4 : 0) - Math.abs(Array.from(value).length - 16) / 20;
    return score(b) - score(a);
  })[0] ?? "";
  const clauses = selected.split(/[，,。！？?!；;]/u).map((item) => item.replace(/^[“”「」『』\s]+|[“”「」『』\s]+$/gu, "").trim()).filter((item) => item.length >= 4);
  const candidate = clauses.find((item) => keywords.test(item) && !boilerplate.test(item)) ?? clauses.find((item) => !boilerplate.test(item)) ?? clauses[0] ?? "";
  const compact = candidate.replace(/^(?:但|然而|此刻|随后|突然|最终)/u, "").trim();
  return Array.from(compact).slice(0, 18).join("") || `未命名转折${chapterIndex}`;
}

export function resolveNovelChapterTitle(args: { requestedTitle: string; generatedTitle?: string; content: string; chapterIndex: number }): string {
  const requested = args.requestedTitle.trim();
  if (requested && !isPlaceholderNovelChapterTitle(requested)) return requested;
  const generated = (args.generatedTitle ?? "").trim().slice(0, 80);
  if (generated && !isPlaceholderNovelChapterTitle(generated)) return generated;
  return inferNovelChapterTitle(args.content, args.chapterIndex);
}

export class InvalidGeneratedNovelJsonError extends Error {
  constructor() {
    super("AI 生成结果不是完整 JSON，已取消保存，请重新生成。");
    this.name = "InvalidGeneratedNovelJsonError";
  }
}

export function parseRequiredGeneratedNovelValue(kind: NovelTargetKind, raw: unknown): unknown {
  const parsed = parseGeneratedNovelValue(raw);
  if (kind === "chapter" && typeof parsed === "string") return parseTitledChapterText(parsed) ?? parsed;
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
