import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";

export interface AuthRouteContext {
  readonly prisma: PrismaClient;
  readonly secret: string;
  readonly recordLogin: (request: FastifyRequest, userId: string) => Promise<void>;
}

export function requireSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 必须 ≥32 字节");
  return secret;
}

export function createAuthRouteContext(prisma: PrismaClient): AuthRouteContext {
  return {
    prisma,
    secret: requireSessionSecret(),
    async recordLogin(request, userId) {
      try {
        await prisma.$executeRaw`
          INSERT INTO "LoginEvent" ("id", "userId", "createdAt")
          VALUES (${randomUUID()}, ${userId}, NOW())
        `;
      } catch {
        request.log.warn({ userId }, "登录事件写入失败");
      }
    },
  };
}
