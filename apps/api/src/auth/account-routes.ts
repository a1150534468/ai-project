import type { PrismaClient, User } from "@prisma/client";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthRouteContext } from "./auth-route-context.js";
import { readDemoAccountConfig } from "./demo.js";
import { isUniqueConstraintOn, uniqueConstraintTargets } from "./prisma-errors.js";
import { consumeNamedQuota, loginFailQuotaKey } from "../shared/quota.js";
import { requireUser } from "./require-user.js";
import { signToken } from "./token.js";
import { generateUid } from "./uid.js";

const registrationSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
});
const loginSchema = z.object({
  identifier: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

/** 登录失败的对外文案。401 与 429 共用，见下方登录实现里的说明。 */
const LOGIN_FAILED_MESSAGE = "账号或密码错误";

class UsernameTakenError extends Error {}

async function createUser(prisma: PrismaClient, username: string, password: string): Promise<User> {
  const passwordHash = await argon2.hash(password);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await prisma.user.create({
        data: { uid: generateUid(), username, passwordHash, memoryEnabled: true },
      });
    } catch (error) {
      if (uniqueConstraintTargets(error) === null) throw error;
      if (isUniqueConstraintOn(error, "username")) throw new UsernameTakenError();
      if (isUniqueConstraintOn(error, "uid")) continue;
      if (await prisma.user.findUnique({ where: { username } })) throw new UsernameTakenError();
    }
  }
  throw new Error("UID 生成多次冲突，请重试");
}

function sessionResponse(user: Pick<User, "id" | "uid">, secret: string) {
  return { token: signToken(user.id, secret), userId: user.id, uid: user.uid };
}

function isReservedDemoUsername(username: string): boolean {
  try {
    return readDemoAccountConfig()?.username === username;
  } catch {
    return false;
  }
}

export function registerAccountRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  const { prisma, secret } = context;

  app.post("/api/auth/register", async (request, reply) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const { username, password } = parsed.data;
    if (isReservedDemoUsername(username)) {
      return reply.code(409).send({ error: "用户名已被占用" });
    }
    try {
      return sessionResponse(await createUser(prisma, username, password), secret);
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        return reply.code(409).send({ error: "用户名已被占用" });
      }
      throw error;
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const { identifier, password } = parsed.data;
    // 先占用一次尝试额度，再查库与执行 Argon2，超额请求才能真正停止猜密码和消耗 CPU。
    // 即使密码正确，额度耗尽后也要等待窗口结束；额度内登录成功仍清零，保留正常重试体验。
    if (context.redis && !(await consumeNamedQuota(context.redis, "authLoginFail", identifier, (error) => request.log.warn({ err: error }, "登录限流检查失败，本次放行")))) {
      // 沿用密码错误文案，不通过限流响应透露账号是否存在。
      return reply.code(429).send({ error: LOGIN_FAILED_MESSAGE });
    }
    const user = await prisma.user.findFirst({
      where: { OR: [{ uid: identifier }, { username: identifier }] },
    });
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      return reply.code(401).send({ error: LOGIN_FAILED_MESSAGE });
    }
    if (user.bannedAt) return reply.code(403).send({ error: "账号已被封禁" });
    // 额度内登录成功清零本窗口的尝试计数。
    if (context.redis) {
      await context.redis
        .del(loginFailQuotaKey(identifier))
        .catch((error) => request.log.warn({ err: error }, "登录尝试计数清零失败"));
    }
    await context.recordLogin(request, user.id);
    return sessionResponse(user, secret);
  });

  app.get("/api/auth/me", { preHandler: requireUser }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.userId },
      select: { id: true, uid: true, username: true, bannedAt: true },
    });
    if (!user) return reply.code(401).send({ error: "用户不存在" });
    if (user.bannedAt) return reply.code(403).send({ error: "账号已被封禁" });
    return { userId: user.id, uid: user.uid, username: user.username };
  });
}
