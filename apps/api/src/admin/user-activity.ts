import type { PrismaClient } from "@prisma/client";

const DAY_MS = 86_400_000;
type PeriodKey = "today" | "week" | "month" | "total";

export interface UserActivityPeriod {
  readonly key: PeriodKey;
  readonly sessions: number;
  readonly messages: number;
  readonly agents: number;
  readonly knowledgeBases: number;
  readonly kbDocuments: number;
  readonly imageTasks: number;
}

export interface UserActivityDetail {
  readonly loginCountToday: number;
  readonly todayAgents: number;
  readonly periods: UserActivityPeriod[];
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function periodRanges(now: Date): ReadonlyArray<{ key: PeriodKey; start?: Date }> {
  const today = startOfUtcDay(now);
  return [
    { key: "today", start: today },
    { key: "week", start: new Date(today.getTime() - 6 * DAY_MS) },
    { key: "month", start: new Date(today.getTime() - 29 * DAY_MS) },
    { key: "total" },
  ];
}

function rowCount(rows: ReadonlyArray<{ count: number | bigint }>): number {
  return Number(rows[0]?.count ?? 0);
}

async function countLoginEvents(
  prisma: PrismaClient,
  userId: string,
  start: Date,
  end: Date,
): Promise<number> {
  try {
    return rowCount(await prisma.$queryRaw<{ count: number | bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "LoginEvent"
      WHERE "userId" = ${userId} AND "createdAt" >= ${start} AND "createdAt" < ${end}
    `);
  } catch {
    return 0;
  }
}

async function countTodayAgents(prisma: PrismaClient, userId: string, start: Date): Promise<number> {
  return rowCount(await prisma.$queryRaw<{ count: number | bigint }[]>`
    SELECT COUNT(DISTINCT "agentId")::bigint AS count FROM "Session"
    WHERE "userId" = ${userId} AND "agentId" IS NOT NULL AND "updatedAt" >= ${start}
  `);
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
  return rowCount(rows);
}

async function countDocuments(prisma: PrismaClient, userId: string, start?: Date): Promise<number> {
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
  return rowCount(rows);
}

async function countImages(prisma: PrismaClient, userId: string, start?: Date): Promise<number> {
  try {
    return await prisma.imageGenerationTask.count({
      where: { userId, ...(start ? { createdAt: { gte: start } } : {}) },
    });
  } catch {
    return 0;
  }
}

async function loadPeriod(
  prisma: PrismaClient,
  userId: string,
  key: PeriodKey,
  start?: Date,
): Promise<UserActivityPeriod> {
  const createdAt = start ? { createdAt: { gte: start } } : {};
  const [sessions, messages, agents, knowledgeBases, kbDocuments, imageTasks] = await Promise.all([
    prisma.session.count({ where: { userId, ...createdAt } }),
    countMessages(prisma, userId, start),
    prisma.userAgent.count({ where: { userId, ...createdAt } }),
    prisma.knowledgeBase.count({ where: { userId, ...createdAt } }),
    countDocuments(prisma, userId, start),
    countImages(prisma, userId, start),
  ]);
  return { key, sessions, messages, agents, knowledgeBases, kbDocuments, imageTasks };
}

export async function loadUserActivity(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<UserActivityDetail> {
  const today = startOfUtcDay(now);
  const [loginCountToday, todayAgents, periods] = await Promise.all([
    countLoginEvents(prisma, userId, today, new Date(today.getTime() + DAY_MS)),
    countTodayAgents(prisma, userId, today),
    Promise.all(periodRanges(now).map(({ key, start }) => loadPeriod(prisma, userId, key, start))),
  ]);
  return { loginCountToday, todayAgents, periods };
}
