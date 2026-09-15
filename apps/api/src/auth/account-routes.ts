import type { PrismaClient, User } from "@prisma/client";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthRouteContext } from "./auth-route-context.js";
import { readDemoAccountConfig } from "./demo.js";
import { isUniqueConstraintOn, uniqueConstraintTargets } from "./prisma-errors.js";
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
    const user = await prisma.user.findFirst({
      where: { OR: [{ uid: identifier }, { username: identifier }] },
    });
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      return reply.code(401).send({ error: "账号或密码错误" });
    }
    if (user.bannedAt) return reply.code(403).send({ error: "账号已被封禁" });
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
