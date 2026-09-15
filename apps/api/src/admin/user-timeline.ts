import type { PrismaClient } from "@prisma/client";

export interface UserTimelineItem {
  readonly type: "session" | "message" | "agent" | "kb" | "image";
  readonly title: string;
  readonly at: string;
  readonly meta: string;
}

function timelineItem(
  type: UserTimelineItem["type"],
  row: { id: string; createdAt: Date },
  title: string,
): UserTimelineItem {
  return { type, title, at: row.createdAt.toISOString(), meta: row.id };
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

export async function loadUserTimeline(prisma: PrismaClient, userId: string): Promise<UserTimelineItem[]> {
  const [sessions, messages, agents, documents, images] = await Promise.all([
    prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, title: true, createdAt: true },
    }),
    prisma.$queryRaw<{ id: string; content: string; createdAt: Date }[]>`
      SELECT m.id, m.content, m."createdAt"
      FROM "Message" m JOIN "Session" s ON s.id = m."sessionId"
      WHERE s."userId" = ${userId}
      ORDER BY m."createdAt" DESC LIMIT 20
    `,
    prisma.userAgent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, name: true, createdAt: true },
    }),
    prisma.$queryRaw<{ id: string; name: string; status: string; createdAt: Date }[]>`
      SELECT d.id, d.name, d.status, d."createdAt"
      FROM "Document" d JOIN "KnowledgeBase" kb ON kb.id = d."kbId"
      WHERE kb."userId" = ${userId}
      ORDER BY d."createdAt" DESC LIMIT 20
    `,
    listImageTasks(prisma, userId),
  ]);

  return [
    ...sessions.map((row) => timelineItem("session", row, row.title)),
    ...messages.map((row) => timelineItem("message", row, row.content)),
    ...agents.map((row) => timelineItem("agent", row, row.name)),
    ...documents.map((row) => timelineItem("kb", row, `${row.name} · ${row.status}`)),
    ...images.map((row) => timelineItem("image", row, `${row.prompt} · ${row.status}`)),
  ]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 80);
}
