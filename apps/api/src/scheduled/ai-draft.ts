import { jsonrepair } from "jsonrepair";
import { presetToCron } from "./schedule.js";

export interface ScheduledDraft {
  readonly title: string;
  readonly prompt: string;
  readonly model: string;
  readonly cron: string;
  readonly timezone: string;
  readonly hour: number;
  readonly minute: number;
  readonly oneShot: boolean;
  readonly emailTo: string;
}

const TZ = "Asia/Shanghai";
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;
const FALLBACK_MODEL = "MiniMax-M3";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeParseObject(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  try {
    const repaired = jsonrepair(slice);
    const obj = JSON.parse(repaired);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  return t < min || t > max ? fallback : t;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseScheduledDraft(rawText: string, models: string[], description: string): ScheduledDraft {
  const obj = safeParseObject(rawText);
  const schedule = (obj.schedule && typeof obj.schedule === "object" ? obj.schedule : {}) as Record<string, unknown>;

  const model = typeof obj.model === "string" && models.includes(obj.model) ? obj.model : (models[0] ?? FALLBACK_MODEL);
  const hour = clampInt(schedule.hour, 0, 23, DEFAULT_HOUR);
  const minute = clampInt(schedule.minute, 0, 59, DEFAULT_MINUTE);
  const cron = presetToCron({ kind: "daily", hour, minute });
  const emailRaw = nonEmptyString(obj.emailTo);
  const emailTo = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : "";
  const title = nonEmptyString(obj.title) ?? (description.trim().slice(0, 20) || "定时任务");
  const prompt = nonEmptyString(obj.prompt) ?? description.trim();
  const oneShot = obj.oneShot === true;

  return { title, prompt, model, cron, timezone: TZ, hour, minute, oneShot, emailTo };
}
