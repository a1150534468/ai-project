import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export interface AuthRouteContext {
  readonly prisma: PrismaClient;
  readonly secret: string;
  readonly recordLogin: (request: FastifyRequest, userId: string) => Promise<void>;
  /** 只用于登录失败计数。不传（单测）则计数闸放行，测试不必准备 Redis。 */
  readonly redis?: Redis;
}

export function requireSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 必须 ≥32 字节");
  return secret;
}

export function createAuthRouteContext(prisma: PrismaClient, redis?: Redis): AuthRouteContext {
  return {
    prisma,
    secret: requireSessionSecret(),
    redis,
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
