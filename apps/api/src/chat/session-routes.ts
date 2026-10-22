import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { paginate } from "@ai-assistant/db/paginate";
import { iconForAgentId } from "../agents/service.js";

async function sessionOwner(
  prisma: PrismaClient,
  sessionId: string,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session) {
    reply.code(404).send({ error: "会话不存在" });
    return false;
  }
  if (session.userId !== userId) {
    reply.code(403).send({ error: "无权访问该会话" });
    return false;
  }
  return true;
}

export function registerSessionRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.get("/api/sessions", async (request, reply) => {
    // 经 paginate 公共出口（强制 orderBy、take 夹上限）；只取第一页 50 条，
    // 响应组装与原先逐字一致，nextCursor 暂不下发。
    const { rows } = await paginate<{
      id: string;
      agentId: string | null;
      agentName: string | null;
      updatedAt: Date;
      messages: { content: string }[];
    }>(prisma.session, {
      where: { userId: request.userId },
      select: {
        id: true,
        agentId: true,
        agentName: true,
        updatedAt: true,
        messages: {
          where: { role: "user" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 1,
          select: { content: true },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 50,
    });

    return reply.send({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        title: row.messages[0]?.content.slice(0, 30) || "新对话",
        agentId: row.agentId,
        agentName: row.agentName,
        agentIcon: iconForAgentId(row.agentId),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await sessionOwner(prisma, id, request.userId, reply))) return;

    const messages = await prisma.message.findMany({
      where: { sessionId: id },
      select: { role: true, content: true, model: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return reply.send({ success: true, data: messages });
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await sessionOwner(prisma, id, request.userId, reply))) return;

    await prisma.session.delete({ where: { id } });
    return reply.send({ success: true });
  });
}
