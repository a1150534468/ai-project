import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import { buildAdminUserBillingLog, buildAdminUserDetail } from "./user-detail.js";
import { generateUniqueUid } from "../auth/uid.js";
import { kickDevice } from "../connector/hub.js";
import { revokeDeviceByAdmin, listDevicesForAdmin } from "../device/service.js";

const createUserSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
});

export async function adminUserRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get(
    "/api/admin/users",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req) => {
      const q = (req.query as { q?: string }).q?.trim();
      const where = q
        ? {
            OR: [
              { uid: { contains: q } },
              { username: { contains: q } },
            ],
          }
        : {};
      const data = await prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          uid: true,
          username: true,
          bannedAt: true,
          createdAt: true,
        },
      });
      // 合并 billing 余额（批量，单次调用；billing 故障降级为 balance=null 不阻塞）
      let balances: Record<string, number> = {};
      try {
        const r = await billing.batchBalances(data.map((u) => u.id));
        balances = r.balances;
      } catch {
        balances = {};
      }
      return {
        success: true,
        data: data.map((u) => ({ ...u, balance: balances[u.id] ?? null })),
      };
    },
  );

  app.post(
    "/api/admin/users",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req, reply) => {
      const p = createUserSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      if (await prisma.user.findUnique({ where: { username: p.data.username } })) {
        return reply.code(409).send({ error: "用户名已被占用" });
      }
      const uid = await generateUniqueUid(
        async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })),
      );
      const passwordHash = await argon2.hash(p.data.password);
      const user = await prisma.user.create({
        data: {
          uid,
          username: p.data.username,
          passwordHash,
        },
        select: {
          id: true,
          uid: true,
          username: true,
          createdAt: true,
        },
      });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "USER_CREATE", user.id, { uid: user.uid });
      return { success: true, data: user };
    },
  );

  app.post(
    "/api/admin/users/:id/ban",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req) => {
      const { id } = req.params as { id: string };
      await prisma.user.update({ where: { id }, data: { bannedAt: new Date() } });
      // 踢掉该用户所有在线设备
      const devs = await prisma.device.findMany({
        where: { userId: id, online: true },
        select: { id: true },
      });
      for (const d of devs) void kickDevice(d.id); // fire-and-forget，复用 T8b
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "USER_BAN", id);
      return { success: true };
    },
  );

  app.post(
    "/api/admin/users/:id/unban",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req) => {
      const { id } = req.params as { id: string };
      await prisma.user.update({ where: { id }, data: { bannedAt: null } });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "USER_UNBAN", id);
      return { success: true };
    },
  );

  app.get(
    "/api/admin/users/:id/devices",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req) => {
      const { id } = req.params as { id: string };
      const data = await listDevicesForAdmin(prisma, id);
      return { success: true, data };
    },
  );

  app.get(
    "/api/admin/users/:id/billing-log",
    { preHandler: requireAdmin("USER_BILLING_LOG_VIEW") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, uid: true, username: true, bannedAt: true, createdAt: true },
      });
      if (!user) return reply.code(404).send({ error: "用户不存在" });

      return {
        success: true,
        data: await buildAdminUserBillingLog(billing, user),
      };
    },
  );

  app.get(
    "/api/admin/users/:id/detail",
    { preHandler: requireAdmin("USER_DETAIL_VIEW") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, uid: true, username: true, bannedAt: true, createdAt: true },
      });
      if (!user) return reply.code(404).send({ error: "用户不存在" });

      return {
        success: true,
        data: await buildAdminUserDetail(prisma, billing, user),
      };
    },
  );

  app.post(
    "/api/admin/devices/:deviceId/revoke",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req, reply) => {
      const { deviceId } = req.params as { deviceId: string };
      const dev = await prisma.device.findUnique({
        where: { id: deviceId },
        select: { id: true },
      });
      if (!dev) return reply.code(404).send({ error: "设备不存在" });
      const revoked = await revokeDeviceByAdmin(prisma, deviceId);
      if (revoked) void kickDevice(deviceId);
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "DEVICE_REVOKE", deviceId);
      return { success: true };
    },
  );
}
