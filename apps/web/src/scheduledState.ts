export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };

export function presetToCron(p: SchedulePreset): string {
  switch (p.kind) {
    case "hourly": return `${p.minute} * * * *`;
    case "daily": return `${p.minute} ${p.hour} * * *`;
    case "weekly": return `${p.minute} ${p.hour} * * ${p.weekday}`;
    case "monthly": return `${p.minute} ${p.hour} ${p.day} * *`;
  }
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n: string) => n.padStart(2, "0");

// 仅对本产品生成的预设 cron 做中文化；其它原样返回
export function humanizeSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const isNum = (s: string) => /^\d+$/.test(s);
  if (mon === "*" && dom === "*" && dow === "*" && hour === "*" && isNum(min)) return `每小时第 ${min} 分`;
  if (mon === "*" && dom === "*" && dow === "*" && isNum(hour) && isNum(min)) return `每天 ${pad(hour)}:${pad(min)}`;
  if (mon === "*" && dom === "*" && isNum(dow) && isNum(hour) && isNum(min)) return `每${WEEKDAYS[Number(dow) % 7]} ${pad(hour)}:${pad(min)}`;
  if (mon === "*" && dow === "*" && isNum(dom) && isNum(hour) && isNum(min)) return `每月 ${dom} 日 ${pad(hour)}:${pad(min)}`;
  return cron;
}

export interface ScheduledDraft {
  title: string;
  prompt: string;
  model: string;
  cron: string;
  timezone: string;
  hour: number;
  minute: number;
  oneShot: boolean;
  emailTo: string;
}

export interface DraftFormPatch {
  title: string;
  prompt: string;
  model: string;
  emailTo: string;
  oneShot: boolean;
  preset: SchedulePreset;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n < min || n > max ? fallback : n;
}

export function draftToFormPatch(draft: ScheduledDraft): DraftFormPatch {
  const hour = clampInt(draft.hour, 0, 23, 0);
  const minute = clampInt(draft.minute, 0, 59, 0);
  return {
    title: draft.title,
    prompt: draft.prompt,
    model: draft.model,
    emailTo: draft.emailTo,
    oneShot: draft.oneShot === true,
    preset: { kind: "daily", hour, minute },
  };
}
