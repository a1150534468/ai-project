import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { pairDevice, listDevices, revokeDevice } from "./service.js";
import { kickDevice } from "../connector/hub.js";

const pairSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(["win", "mac", "linux"]),
});

export async function deviceRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.post("/api/device/pair", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

    const parsed = pairSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const { deviceId, token } = await pairDevice(prisma, userId, parsed.data.name, parsed.data.platform);
    return { deviceId, token };
  });

  app.get("/api/device/list", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

    const devices = await listDevices(prisma, userId);
    return { success: true, data: devices };
  });

  app.post("/api/device/:id/revoke", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

    const { id } = req.params as { id: string };
    const revoked = await revokeDevice(prisma, userId, id);
    if (revoked) void kickDevice(id);
    return { success: true };
  });
}
