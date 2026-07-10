type Cadence = "DAILY" | "WEEKLY" | "MONTHLY";

const CADENCE_LABEL: Record<Cadence, string> = { DAILY: "每日", WEEKLY: "每周", MONTHLY: "每月" };

export function cadenceLabel(cadence: string): string {
  return CADENCE_LABEL[cadence as Cadence] ?? "每月";
}

/** 整个有效期内的发放周期数（至少 1）。 */
export function periodsInDuration(cadence: string, durationDays: number): number {
  if (durationDays <= 0) return 1;
  if (cadence === "DAILY") return durationDays;
  if (cadence === "WEEKLY") return Math.max(1, Math.floor(durationDays / 7));
  if (cadence === "MONTHLY") return Math.max(1, Math.floor(durationDays / 30));
  return 1;
}

export interface TotalGrant {
  points: number;
  approx: boolean;
}

/** 整个订阅周期总发放点数；approx 表示按周期折算除不尽（展示时前缀"约"）。 */
export function totalGrantOverDuration(cadence: string, durationDays: number, grantPoints: number): TotalGrant {
  const periods = periodsInDuration(cadence, durationDays);
  const divisor = cadence === "WEEKLY" ? 7 : cadence === "MONTHLY" ? 30 : 1;
  const approx = cadence !== "DAILY" && durationDays > 0 && durationDays % divisor !== 0;
  return { points: periods * grantPoints, approx };
}
