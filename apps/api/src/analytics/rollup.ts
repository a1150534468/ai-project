import type { PrismaClient } from "@ai-assistant/db";
import { createBillingClient } from "@ai-assistant/billing";
import { computeRollup, addDays, COHORT_MAX_OFFSET, type RollupInput } from "./rollup-core.js";

type Billing = ReturnType<typeof createBillingClient>;

// 取主库注册（userId, 注册日 YYYY-MM-DD）在 [from,to]
async function fetchRegistrations(prisma: PrismaClient, from: string, to: string) {
  const rows = await prisma.$queryRaw<{ userId: string; date: string }[]>`
    SELECT id AS "userId", to_char("createdAt"::date,'YYYY-MM-DD') AS date
    FROM "User"
    WHERE "createdAt"::date BETWEEN ${from}::date AND ${to}::date`;
  return rows;
}

// 取去重 用户×活跃日（活跃=发过 user 消息）在 [from,to]
async function fetchActivity(prisma: PrismaClient, from: string, to: string) {
  const rows = await prisma.$queryRaw<{ userId: string; date: string }[]>`
    SELECT DISTINCT s."userId" AS "userId", to_char(m."createdAt"::date,'YYYY-MM-DD') AS date
    FROM "Message" m JOIN "Session" s ON s.id = m."sessionId"
    WHERE m.role = 'user' AND m."createdAt"::date BETWEEN ${from}::date AND ${to}::date`;
  return rows;
}

// 最早注册日（用于 payingTotal 累计起点 & 默认回填起点）
async function earliestDate(prisma: PrismaClient): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ d: string | null }[]>`
    SELECT to_char(MIN("createdAt")::date,'YYYY-MM-DD') AS d FROM "User"`;
  return rows[0]?.d ?? null;
}

export interface RollupRange { from: string; to: string } // YYYY-MM-DD（产出 MetricsDaily/cohort 的窗口）

// 默认窗口：最近 31 天到今天（UTC）
export function defaultWindow(todayUtc: string): RollupRange {
  return { from: addDays(todayUtc, -COHORT_MAX_OFFSET), to: todayUtc };
}

// runRollup：计算 [range.from, range.to] 的 MetricsDaily 与 CohortDaily 并 upsert。
export async function runRollup(prisma: PrismaClient, billing: Billing, range: RollupRange): Promise<{ metricDays: number; cohorts: number }> {
  const metricDates = enumerate(range.from, range.to);
  const cohortDates = metricDates; // 同窗口的队列
  // 活跃需覆盖：MetricsDaily 的 MAU 回看 29 天 + 队列 offset 前推 30 天
  const activityFrom = addDays(range.from, -29);
  const activityTo = addDays(range.to, COHORT_MAX_OFFSET);
  // payingTotal 需从最早日起的 dailyAgg
  const epoch = (await earliestDate(prisma)) ?? range.from;
  const dailyFrom = epoch < range.from ? epoch : range.from;

  const [registrations, activity, daily] = await Promise.all([
    fetchRegistrations(prisma, range.from, range.to),
    fetchActivity(prisma, activityFrom, activityTo),
    billing.analyticsDaily(dailyFrom, range.to),
  ]);

  const dailyAgg: RollupInput["dailyAgg"] = {};
  for (const d of daily.data) {
    dailyAgg[d.date] = {
      revenueFen: d.revenueFen, topupCount: d.topupCount, grantedPoints: d.grantedPoints,
      consumedPoints: d.consumedPoints, payingUsers: d.payingUsers, newPayingUsers: d.newPayingUsers,
    };
  }

  // 队列成员的实付（按用户）
  const cohortUserIds = registrations.map((r) => r.userId);
  const rbu = cohortUserIds.length > 0 ? await billing.revenueByUsers(cohortUserIds) : { data: {} };
  const revenueByUser: RollupInput["revenueByUser"] = {};
  for (const [uid, evs] of Object.entries(rbu.data)) {
    revenueByUser[uid] = evs.map((e) => ({ paidAtDate: e.paidAtDate, amountFen: e.amountFen }));
  }

  const { metricsDaily, cohortDaily } = computeRollup({
    metricDates, cohortDates, registrations, activity, dailyAgg, revenueByUser,
  });

  // 事务化 upsert（按 date / (cohortDate,dayOffset)），幂等
  await prisma.$transaction([
    ...metricsDaily.map((m) =>
      prisma.metricsDaily.upsert({
        where: { date: new Date(`${m.date}T00:00:00Z`) },
        create: { ...toMetricCreate(m) },
        update: { ...toMetricUpdate(m) },
      }),
    ),
    ...cohortDaily.map((c) =>
      prisma.cohortDaily.upsert({
        where: { cohortDate_dayOffset: { cohortDate: new Date(`${c.cohortDate}T00:00:00Z`), dayOffset: c.dayOffset } },
        create: { cohortDate: new Date(`${c.cohortDate}T00:00:00Z`), dayOffset: c.dayOffset, cohortSize: c.cohortSize, retained: c.retained, cumRevenueFen: c.cumRevenueFen, cumPayers: c.cumPayers },
        update: { cohortSize: c.cohortSize, retained: c.retained, cumRevenueFen: c.cumRevenueFen, cumPayers: c.cumPayers },
      }),
    ),
  ]);

  return { metricDays: metricsDaily.length, cohorts: cohortDates.length };
}

function toMetricCreate(m: {
  date: string; registered: number; dau: number; wau: number; mau: number;
  newPayingUsers: number; payingTotal: number; revenueFen: number; grantedPoints: number; consumedPoints: number;
}) {
  return {
    date: new Date(`${m.date}T00:00:00Z`),
    registered: m.registered, dau: m.dau, wau: m.wau, mau: m.mau,
    newPayingUsers: m.newPayingUsers, payingTotal: m.payingTotal,
    revenueFen: m.revenueFen, grantedPoints: m.grantedPoints, consumedPoints: m.consumedPoints,
  };
}

function toMetricUpdate(m: {
  registered: number; dau: number; wau: number; mau: number;
  newPayingUsers: number; payingTotal: number; revenueFen: number; grantedPoints: number; consumedPoints: number;
}) {
  return {
    registered: m.registered, dau: m.dau, wau: m.wau, mau: m.mau,
    newPayingUsers: m.newPayingUsers, payingTotal: m.payingTotal,
    revenueFen: m.revenueFen, grantedPoints: m.grantedPoints, consumedPoints: m.consumedPoints,
  };
}

function enumerate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; Date.parse(`${d}T00:00:00Z`) <= Date.parse(`${to}T00:00:00Z`); d = addDays(d, 1)) out.push(d);
  return out;
}
