import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/require-user.js";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { pairDevice, listDevices, revokeDevice } from "./service.js";
import { kickDevice } from "../connector/hub.js";

const pairSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(["win", "mac", "linux"]),
});

export async function deviceRoutes(app: FastifyInstance) {
  // 本文件 3 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样测试单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  const prisma = getPrisma();

  app.post("/api/device/pair", async (req, reply) => {
    const userId = req.userId;

    const parsed = pairSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const { deviceId, token } = await pairDevice(prisma, userId, parsed.data.name, parsed.data.platform);
    return { deviceId, token };
  });

  app.get("/api/device/list", async (req, reply) => {
    const userId = req.userId;

    const devices = await listDevices(prisma, userId);
    return { success: true, data: devices };
  });

  app.post("/api/device/:id/revoke", async (req, reply) => {
    const userId = req.userId;

    const { id } = req.params as { id: string };
    const revoked = await revokeDevice(prisma, userId, id);
    if (revoked) void kickDevice(id);
    return { success: true };
  });
}
