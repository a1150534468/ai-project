import { isPlainObject } from "../../runtime/records.js";
import type { NovelTargetKind } from "./novel-types.js";

function embeddedJson(text: string): string {
  const candidate = text.trim();
  const spans = [
    { start: candidate.indexOf("{"), end: candidate.lastIndexOf("}") },
    { start: candidate.indexOf("["), end: candidate.lastIndexOf("]") },
  ].filter(({ start, end }) => start >= 0 && end > start).sort((a, b) => a.start - b.start);
  const first = spans[0];
  return first ? candidate.slice(first.start, first.end + 1) : candidate;
}

export function parseGeneratedNovelValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const source = raw.trim();
  if (!source) return "";
  try {
    return JSON.parse(embeddedJson(source));
  } catch {
    return source;
  }
}

function chapterWithTitle(text: string): { title: string; content: string } | null {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const parts = /^(?:章节标题|标题)\s*[:：]\s*([^\n]{2,80})\n+([\s\S]+)$/u.exec(normalized);
  if (!parts) return null;
  const title = parts[1]?.replace(/^[《“「『]|[》”」』]$/gu, "").trim().slice(0, 80) ?? "";
  const content = parts[2]?.trim() ?? "";
  return title && content ? { title, content } : null;
}

export function isPlaceholderNovelChapterTitle(value: string): boolean {
  return /^第\s*\d+\s*章$/u.test(value.trim());
}

function titleCandidateScore(value: string): number {
  const narrativeKeywords = /(真相|秘密|协议|逻辑锁|源码|碎片|反击|追踪|死循环|崩溃|危机|抹杀|觉醒|背叛|决战|逃亡|交易|悬赏|锚点|陷阱|突破)/u;
  const repeatedWorldbuilding = /(物理法则锁定率|神经元负载|冷却泵|隐秘节点·起源机房)/u;
  const lengthPenalty = Math.abs([...value].length - 16) / 20;
  return (narrativeKeywords.test(value) ? 5 : 0)
    - (repeatedWorldbuilding.test(value) ? 4 : 0)
    - lengthPenalty;
}

export function inferNovelChapterTitle(content: string, chapterIndex: number): string {
  const sentences = content
    .replace(/\r\n?/gu, "\n")
    .split(/(?<=[。！？?!])|\n+/u)
    .map((value) => value.trim())
    .filter((value) => value.length >= 4)
    .sort((left, right) => titleCandidateScore(right) - titleCandidateScore(left));
  const clauses = (sentences[0] ?? "")
    .split(/[，,。！？?!；;]/u)
    .map((value) => value.replace(/^[“”「」『』\s]+|[“”「」『』\s]+$/gu, "").trim())
    .filter((value) => value.length >= 4)
    .sort((left, right) => titleCandidateScore(right) - titleCandidateScore(left));
  const title = (clauses[0] ?? "").replace(/^(?:但|然而|此刻|随后|突然|最终)/u, "").trim();
  return [...title].slice(0, 18).join("") || `未命名转折${chapterIndex}`;
}

export function resolveNovelChapterTitle(args: {
  requestedTitle: string;
  generatedTitle?: string;
  content: string;
  chapterIndex: number;
}): string {
  const candidates = [args.requestedTitle.trim(), (args.generatedTitle ?? "").trim().slice(0, 80)];
  return candidates.find((title) => title && !isPlaceholderNovelChapterTitle(title))
    ?? inferNovelChapterTitle(args.content, args.chapterIndex);
}

export class InvalidGeneratedNovelJsonError extends Error {
  constructor() {
    super("AI 生成结果不是完整 JSON，已取消保存，请重新生成。");
    this.name = "InvalidGeneratedNovelJsonError";
  }
}

export function parseRequiredGeneratedNovelValue(kind: NovelTargetKind, raw: unknown): unknown {
  const value = parseGeneratedNovelValue(raw);
  if (kind === "chapter" && typeof value === "string") return chapterWithTitle(value) ?? value;
  const requiresObject = kind !== "chapter" && kind !== "chapterRewrite";
  if (requiresObject && !isPlainObject(value)) throw new InvalidGeneratedNovelJsonError();
  return value;
}

function visibleValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(visibleValues);
  return isPlainObject(value) ? Object.values(value).flatMap(visibleValues) : [];
}

function chapterText(value: unknown): string {
  if (isPlainObject(value) && typeof value.content === "string") return value.content.trim();
  return typeof value === "string" ? value.trim() : visibleValues(value).join("\n").trim();
}

export function visibleCharCount(text: string): number {
  return [...text].reduce((count, character) => count + (/\s/u.test(character) ? 0 : 1), 0);
}

export function extractBillableText(kind: NovelTargetKind, raw: unknown): string {
  const value = parseGeneratedNovelValue(raw);
  return kind === "chapter" || kind === "chapterRewrite"
    ? chapterText(value)
    : visibleValues(value).join("\n").trim();
}

export function billableCharCount(kind: NovelTargetKind, raw: unknown): number {
  return visibleCharCount(extractBillableText(kind, raw));
}

export function formatGeneratedNovelDisplayText(kind: NovelTargetKind, raw: unknown): string {
  const value = parseGeneratedNovelValue(raw);
  return kind === "chapter" || kind === "chapterRewrite" ? chapterText(value) : JSON.stringify(value, null, 2);
}
