import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { createBillingClient } from "@ai-assistant/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import { runRollup } from "../analytics/rollup.js";

const RET_OFFSETS = [3, 7, 14, 30];
const LTV_OFFSETS = [1, 3, 7, 14, 30];

const rebuildSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function analyticsRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  // 概览：累计/最新核心卡片
  app.get("/api/admin/analytics/overview", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async () => {
    const rows = await prisma.metricsDaily.findMany({ orderBy: { date: "asc" } });
    if (rows.length === 0) return { success: true, data: null, lastRolledAt: null };
    const totalRegistered = rows.reduce((s, r) => s + r.registered, 0);
    const totalRevenueFen = rows.reduce((s, r) => s + r.revenueFen, 0);
    const latest = rows[rows.length - 1];
    const payingTotal = latest.payingTotal;
    return {
      success: true,
      data: {
        totalRegistered,
        dau: latest.dau, wau: latest.wau, mau: latest.mau,
        payingTotal,
        paymentRate: totalRegistered ? payingTotal / totalRegistered : 0,
        totalRevenueYuan: totalRevenueFen / 100,
        arpu: totalRegistered ? totalRevenueFen / 100 / totalRegistered : 0,
        arppu: payingTotal ? totalRevenueFen / 100 / payingTotal : 0,
        ...(await overviewExtras(prisma, billing)),
      },
      lastRolledAt: latest.updatedAt,
    };
  });

  // 日序列
  app.get("/api/admin/analytics/daily", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 30, 1), 180);
    const rows = await prisma.metricsDaily.findMany({ orderBy: { date: "desc" }, take: days });
    const ordered = rows.reverse();
    const first = ordered[0]?.date.toISOString().slice(0, 10);
    const last = ordered[ordered.length - 1]?.date.toISOString().slice(0, 10);
    const billingDaily = new Map<string, { topupCount: number; payingUsers: number }>();
    if (first && last) {
      try {
        const billingRows = await billing.analyticsDaily(first, last);
        for (const row of billingRows.data) billingDaily.set(row.date, row);
      } catch {
        billingDaily.clear();
      }
    }
    const data = ordered.map((r) => {
      const date = r.date.toISOString().slice(0, 10);
      const bd = billingDaily.get(date);
      return {
      date,
      registered: r.registered, dau: r.dau, wau: r.wau, mau: r.mau,
      revenueYuan: r.revenueFen / 100, grantedPoints: r.grantedPoints, consumedPoints: r.consumedPoints,
      newPayingUsers: r.newPayingUsers, topupCount: bd?.topupCount ?? 0, payingUsers: bd?.payingUsers ?? 0,
      rechargeUsageRatio: r.consumedPoints > 0 ? r.grantedPoints / r.consumedPoints : null,
    };
    });
    return { success: true, data };
  });

  app.get("/api/admin/analytics/rankings", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (req, reply) => {
    const range = daysRange(req.query as { days?: string });
    try {
      const r = await billing.analyticsRankings(range.from, range.to, 10);
      return { success: true, data: r.data };
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.get("/api/admin/analytics/sales", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (req, reply) => {
    const range = daysRange(req.query as { days?: string });
    try {
      const r = await billing.analyticsSales(range.from, range.to);
      return { success: true, data: r.data };
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  // 留存矩阵
  app.get("/api/admin/analytics/retention", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const rows = await prisma.cohortDaily.findMany({
      where: cohortWhere(q.from, q.to),
      orderBy: [{ cohortDate: "desc" }, { dayOffset: "asc" }],
    });
    return { success: true, data: buildCohortMatrix(rows, RET_OFFSETS, "retention") };
  });

  // LTV 曲线 + 首N日付费率
  app.get("/api/admin/analytics/ltv", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const rows = await prisma.cohortDaily.findMany({
      where: cohortWhere(q.from, q.to),
      orderBy: [{ cohortDate: "desc" }, { dayOffset: "asc" }],
    });
    return { success: true, data: buildCohortMatrix(rows, LTV_OFFSETS, "ltv") };
  });

  // 重算/回填
  app.post("/api/admin/analytics/rebuild", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (req, reply) => {
    const p = rebuildSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "参数不合法（from/to YYYY-MM-DD）" });
    if (p.data.from > p.data.to) return reply.code(400).send({ error: "from 不能晚于 to" });
    let result: { metricDays: number; cohorts: number };
    try {
      result = await runRollup(prisma, billing, { from: p.data.from, to: p.data.to });
    } catch {
      return reply.code(502).send({ error: "重算失败（计费服务不可用或查询出错）" });
    }
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(prisma, me.id, "ANALYTICS_REBUILD", undefined, { from: p.data.from, to: p.data.to, ...result });
    void getRedis; // 预留：未来可在此打 rebuild 节流锁
    return { success: true, data: result };
  });
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysRange(q: { days?: string }) {
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 180);
  const to = todayUTC();
  const fromDate = new Date(`${to}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

async function overviewExtras(prisma: ReturnType<typeof getPrisma>, billing: ReturnType<typeof createBillingClient>) {
  const [balances, devices, content] = await Promise.all([
    billing.analyticsBalances().then((r) => r.data).catch(() => null),
    deviceOnlineSummary(prisma).catch(() => ({ onlineDevices: 0, onlineSecondsToday: 0 })),
    contentProductionSummary(prisma).catch(() => ({
      imageTasksToday: 0,
      imageTasksMonth: 0,
      imageTasksTotal: 0,
      generatedImagesToday: 0,
      generatedImagesMonth: 0,
      generatedImagesTotal: 0,
      kbUploadsToday: 0,
      kbUploadsMonth: 0,
      kbUploadsTotal: 0,
      kbUploadBytesTotal: 0,
    })),
  ]);
  return {
    totalBalance: balances?.totalBalance ?? null,
    usersWithBalance: balances?.usersWithBalance ?? null,
    videoPointsBalance: balances?.videoPointsBalance ?? null,
    onlineDevices: devices.onlineDevices,
    onlineSecondsToday: devices.onlineSecondsToday,
    ...content,
  };
}

async function deviceOnlineSummary(prisma: ReturnType<typeof getPrisma>) {
  const today = todayUTC();
  const start = new Date(`${today}T00:00:00Z`);
  const end = new Date(start.getTime() + 86_400_000);
  const [onlineDevices, rows] = await Promise.all([
    prisma.device.count({ where: { online: true } }),
    prisma.$queryRaw<{ seconds: number | bigint | null }[]>`
      SELECT COALESCE(SUM(
        GREATEST(
          0,
          EXTRACT(EPOCH FROM LEAST(COALESCE("disconnectedAt", NOW()), ${end}) - GREATEST("connectedAt", ${start}))
        )
      ),0)::bigint AS seconds
      FROM "DeviceSession"
      WHERE "connectedAt" < ${end} AND COALESCE("disconnectedAt", NOW()) > ${start}
    `,
  ]);
  return { onlineDevices, onlineSecondsToday: Number(rows[0]?.seconds ?? 0) };
}

async function contentProductionSummary(prisma: ReturnType<typeof getPrisma>) {
  const today = todayUTC();
  const todayStart = new Date(`${today}T00:00:00Z`);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const monthStart = new Date(todayStart);
  monthStart.setUTCDate(monthStart.getUTCDate() - 29);
  const [
    imageToday,
    imageMonth,
    imageTotal,
    generatedToday,
    generatedMonth,
    generatedTotal,
    kbToday,
    kbMonth,
    kbTotal,
  ] = await Promise.all([
    prisma.imageGenerationTask.count({ where: { createdAt: { gte: todayStart, lt: todayEnd } } }),
    prisma.imageGenerationTask.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.imageGenerationTask.count(),
    prisma.imageGenerationTask.aggregate({ where: { createdAt: { gte: todayStart, lt: todayEnd } }, _sum: { completedCount: true } }),
    prisma.imageGenerationTask.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { completedCount: true } }),
    prisma.imageGenerationTask.aggregate({ _sum: { completedCount: true } }),
    prisma.document.count({ where: { createdAt: { gte: todayStart, lt: todayEnd } } }),
    prisma.document.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.document.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true } }),
  ]);
  return {
    imageTasksToday: imageToday,
    imageTasksMonth: imageMonth,
    imageTasksTotal: imageTotal,
    generatedImagesToday: generatedToday._sum.completedCount ?? 0,
    generatedImagesMonth: generatedMonth._sum.completedCount ?? 0,
    generatedImagesTotal: generatedTotal._sum.completedCount ?? 0,
    kbUploadsToday: kbToday,
    kbUploadsMonth: kbMonth,
    kbUploadsTotal: kbTotal._count._all,
    kbUploadBytesTotal: kbTotal._sum.sizeBytes ?? 0,
  };
}

type CohortRow = { cohortDate: Date; dayOffset: number; cohortSize: number; retained: number; cumRevenueFen: number; cumPayers: number };

function cohortWhere(from?: string, to?: string) {
  if (!from || !to) return {};
  return { cohortDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } };
}

// 把 CohortDaily 行按队列折叠成矩阵（选定 offset 列）
function buildCohortMatrix(rows: CohortRow[], offsets: number[], kind: "retention" | "ltv") {
  const byCohort = new Map<string, { cohortDate: string; cohortSize: number; cells: Record<number, number | null> }>();
  for (const r of rows) {
    const key = r.cohortDate.toISOString().slice(0, 10);
    if (!byCohort.has(key)) byCohort.set(key, { cohortDate: key, cohortSize: r.cohortSize, cells: {} });
    const entry = byCohort.get(key)!;
    if (offsets.includes(r.dayOffset)) {
      if (kind === "retention") {
        entry.cells[r.dayOffset] = r.cohortSize > 0 ? r.retained / r.cohortSize : null;
      } else {
        entry.cells[r.dayOffset] = r.cohortSize > 0 ? r.cumRevenueFen / 100 / r.cohortSize : null;
      }
    }
  }
  return { offsets, cohorts: Array.from(byCohort.values()) };
}
