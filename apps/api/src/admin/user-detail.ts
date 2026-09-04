import type { PrismaClient } from "@ai-assistant/db";
import { listDevicesForAdmin } from "../device/service.js";

interface AdminUserBasic {
  id: string;
  uid: string;
  username: string;
  bannedAt: Date | null;
  createdAt: Date;
}

export async function buildAdminUserDetail(prisma: PrismaClient, user: AdminUserBasic) {
  const today = todayUTC();
  const [activity, timeline] = await Promise.all([
    userActivityDetail(prisma, user.id, today),
    userTimeline(prisma, user.id),
  ]);

  return {
    user,
    kpis: {
      onlineToday: activity.onlineDevices > 0,
      onlineDevices: activity.onlineDevices,
      loginCountToday: activity.loginCountToday,
      todayAgent: activity.todayAgents,
    },
    activity: activity.periods,
    devices: activity.devices,
    timeline: timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 80),
  };
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStart(days: number): Date {
  const today = todayUTC();
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return start;
}

async function userActivityDetail(prisma: PrismaClient, userId: string, today: string) {
  const todayStart = new Date(`${today}T00:00:00Z`);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const weekStart = daysAgoStart(7);
  const monthStart = daysAgoStart(30);
  const [devices, loginCountToday, todayAgents, periods] = await Promise.all([
    listDevicesWithDuration(prisma, userId, todayStart, todayEnd),
    countLoginEvents(prisma, userId, todayStart, todayEnd),
    countTodayAgents(prisma, userId, todayStart),
    periodCounts(prisma, userId, todayStart, weekStart, monthStart),
  ]);
  return {
    onlineDevices: devices.filter((d) => d.online).length,
    loginCountToday,
    todayAgents,
    periods,
    devices,
  };
}

async function listDevicesWithDuration(prisma: PrismaClient, userId: string, start: Date, end: Date) {
  const [devices, durations] = await Promise.all([
    listDevicesForAdmin(prisma, userId),
    prisma.$queryRaw<{ deviceId: string; seconds: number | bigint | null }[]>`
      SELECT "deviceId", COALESCE(SUM(
        GREATEST(
          0,
          EXTRACT(EPOCH FROM LEAST(COALESCE("disconnectedAt", NOW()), ${end}) - GREATEST("connectedAt", ${start}))
        )
      ),0)::bigint AS seconds
      FROM "DeviceSession"
      WHERE "userId" = ${userId}
        AND "connectedAt" < ${end}
        AND COALESCE("disconnectedAt", NOW()) > ${start}
      GROUP BY "deviceId"
    `,
  ]);
  const byDevice = new Map(durations.map((row) => [row.deviceId, Number(row.seconds ?? 0)]));
  return devices.map((device) => ({ ...device, onlineSecondsToday: byDevice.get(device.id) ?? 0 }));
}

async function countLoginEvents(prisma: PrismaClient, userId: string, start: Date, end: Date): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<{ count: number | bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "LoginEvent"
      WHERE "userId" = ${userId} AND "createdAt" >= ${start} AND "createdAt" < ${end}
    `;
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

async function countTodayAgents(prisma: PrismaClient, userId: string, start: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number | bigint }[]>`
    SELECT COUNT(DISTINCT "agentId")::bigint AS count FROM "Session"
    WHERE "userId" = ${userId} AND "agentId" IS NOT NULL AND "updatedAt" >= ${start}
  `;
  return Number(rows[0]?.count ?? 0);
}

async function periodCounts(prisma: PrismaClient, userId: string, todayStart: Date, weekStart: Date, monthStart: Date) {
  const ranges = [
    { key: "today", start: todayStart },
    { key: "week", start: weekStart },
    { key: "month", start: monthStart },
  ] as const;
  const counts = await Promise.all(ranges.map(async (range) => ({
    key: range.key,
    sessions: await prisma.session.count({ where: { userId, createdAt: { gte: range.start } } }),
    messages: await countMessages(prisma, userId, range.start),
    agents: await prisma.userAgent.count({ where: { userId, createdAt: { gte: range.start } } }),
    knowledgeBases: await prisma.knowledgeBase.count({ where: { userId, createdAt: { gte: range.start } } }),
    kbDocuments: await countKbDocuments(prisma, userId, range.start),
    imageTasks: await countImageTasks(prisma, userId, range.start),
  })));
  const total = {
    key: "total",
    sessions: await prisma.session.count({ where: { userId } }),
    messages: await countMessages(prisma, userId),
    agents: await prisma.userAgent.count({ where: { userId } }),
    knowledgeBases: await prisma.knowledgeBase.count({ where: { userId } }),
    kbDocuments: await countKbDocuments(prisma, userId),
    imageTasks: await countImageTasks(prisma, userId),
  };
  return [...counts, total];
}

async function countMessages(prisma: PrismaClient, userId: string, start?: Date): Promise<number> {
  const rows = start
    ? await prisma.$queryRaw<{ count: number | bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "Message" m
        JOIN "Session" s ON s.id = m."sessionId"
        WHERE s."userId" = ${userId} AND m."createdAt" >= ${start}
      `
    : await prisma.$queryRaw<{ count: number | bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "Message" m
        JOIN "Session" s ON s.id = m."sessionId"
        WHERE s."userId" = ${userId}
      `;
  return Number(rows[0]?.count ?? 0);
}

async function countKbDocuments(prisma: PrismaClient, userId: string, start?: Date): Promise<number> {
  const rows = start
    ? await prisma.$queryRaw<{ count: number | bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "Document" d
        JOIN "KnowledgeBase" kb ON kb.id = d."kbId"
        WHERE kb."userId" = ${userId} AND d."createdAt" >= ${start}
      `
    : await prisma.$queryRaw<{ count: number | bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "Document" d
        JOIN "KnowledgeBase" kb ON kb.id = d."kbId"
        WHERE kb."userId" = ${userId}
      `;
  return Number(rows[0]?.count ?? 0);
}

async function userTimeline(prisma: PrismaClient, userId: string) {
  const [sessions, messages, agents, docs, images] = await Promise.all([
    prisma.session.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, title: true, createdAt: true } }),
    prisma.$queryRaw<{ id: string; content: string; createdAt: Date }[]>`
      SELECT m.id, m.content, m."createdAt"
      FROM "Message" m JOIN "Session" s ON s.id = m."sessionId"
      WHERE s."userId" = ${userId}
      ORDER BY m."createdAt" DESC
      LIMIT 20
    `,
    prisma.userAgent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, name: true, createdAt: true } }),
    prisma.$queryRaw<{ id: string; name: string; status: string; createdAt: Date }[]>`
      SELECT d.id, d.name, d.status, d."createdAt"
      FROM "Document" d JOIN "KnowledgeBase" kb ON kb.id = d."kbId"
      WHERE kb."userId" = ${userId}
      ORDER BY d."createdAt" DESC
      LIMIT 20
    `,
    listImageTasks(prisma, userId),
  ]);
  return [
    ...sessions.map((row) => ({ type: "session", title: row.title, at: row.createdAt.toISOString(), meta: row.id })),
    ...messages.map((row) => ({ type: "message", title: row.content, at: row.createdAt.toISOString(), meta: row.id })),
    ...agents.map((row) => ({ type: "agent", title: row.name, at: row.createdAt.toISOString(), meta: row.id })),
    ...docs.map((row) => ({ type: "kb", title: `${row.name} · ${row.status}`, at: row.createdAt.toISOString(), meta: row.id })),
    ...images.map((row) => ({ type: "image", title: `${row.prompt} · ${row.status}`, at: row.createdAt.toISOString(), meta: row.id })),
  ];
}

async function countImageTasks(prisma: PrismaClient, userId: string, start?: Date): Promise<number> {
  try {
    return start
      ? await prisma.imageGenerationTask.count({ where: { userId, createdAt: { gte: start } } })
      : await prisma.imageGenerationTask.count({ where: { userId } });
  } catch {
    return 0;
  }
}

async function listImageTasks(prisma: PrismaClient, userId: string) {
  try {
    return await prisma.imageGenerationTask.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, prompt: true, status: true, createdAt: true },
    });
  } catch {
    return [];
  }
}
