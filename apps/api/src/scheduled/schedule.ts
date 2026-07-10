import { Cron } from "croner";

export function validateCron(expr: string): boolean {
  try {
    new Cron(expr, { timezone: "UTC" }); // 非法表达式会抛错
    return true;
  } catch {
    return false;
  }
}

export function computeNextRun(expr: string, timezone: string, from?: Date): Date | null {
  try {
    const c = new Cron(expr, { timezone });
    return c.nextRun(from ?? undefined);
  } catch {
    return null;
  }
}

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

// 用连续两次触发的间隔判断是否达到最小间隔（防高频刷算力点）
export function checkMinInterval(expr: string, timezone: string, minMs: number): boolean {
  try {
    const c = new Cron(expr, { timezone });
    const a = c.nextRun();
    if (!a) return false;
    const b = c.nextRun(a);
    if (!b) return false;
    return b.getTime() - a.getTime() >= minMs;
  } catch {
    return false;
  }
}
