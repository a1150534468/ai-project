import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { requireUser } from "./require-user.js";
import { signToken } from "./token.js";
import { generateUniquePrefixedUid } from "./uid.js";

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
  channelCode: z.string().regex(/^[A-Z]{2}$/, "注册码格式不合法"),
});
const loginSchema = z.object({
  identifier: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 必须 ≥32 字节");

  app.post("/api/auth/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const { username, password, channelCode } = parsed.data;

    const channel = await prisma.channel.findUnique({ where: { code: channelCode } });
    if (!channel || !channel.enabled) return reply.code(400).send({ error: "注册码无效" });

    if (await prisma.user.findUnique({ where: { username } })) {
      return reply.code(409).send({ error: "用户名已被占用" });
    }
    const uid = await generateUniquePrefixedUid(
      channel.code,
      async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } }))
    );
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({
      data: { uid, username, passwordHash, memoryEnabled: true, channelId: channel.id },
    });
    return { token: signToken(user.id, secret), userId: user.id, uid: user.uid };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const { identifier, password } = parsed.data;
    const user = await prisma.user.findFirst({
      where: { OR: [{ uid: identifier }, { username: identifier }] },
    });
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      return reply.code(401).send({ error: "账号或密码错误" });
    }
    if (user.bannedAt) return reply.code(403).send({ error: "账号已被封禁" });
    try {
      await prisma.$executeRaw`
        INSERT INTO "LoginEvent" ("id", "userId", "createdAt")
        VALUES (${randomUUID()}, ${user.id}, NOW())
      `;
    } catch {
      req.log.warn({ userId: user.id }, "登录事件写入失败");
    }
    return { token: signToken(user.id, secret), userId: user.id, uid: user.uid };
  });

  // 本插件里只有这一条要登录：register / login 必须公开，所以挂逐路由而不是插件级钩子
  app.get("/api/auth/me", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, uid: true, username: true, bannedAt: true },
    });
    if (!user) return reply.code(401).send({ error: "用户不存在" });
    if (user.bannedAt) return reply.code(403).send({ error: "账号已被封禁" });
    return { userId: user.id, uid: user.uid, username: user.username };
  });
}
