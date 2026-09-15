import argon2 from "argon2";
import type { PrismaClient } from "@ai-assistant/db";
import { isUniqueConstraintOn, uniqueConstraintTargets } from "./prisma-errors.js";
import { generateUid } from "./uid.js";

export interface DemoAccountConfig {
  readonly username: string;
  readonly password: string;
}

export class DemoAccountConfigError extends Error {
  constructor(message = "体验账号配置不完整") {
    super(message);
    this.name = "DemoAccountConfigError";
  }
}

export class DemoAccountConflictError extends Error {
  constructor() {
    super("体验账号用户名已被其他账号占用");
    this.name = "DemoAccountConflictError";
  }
}

function isEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

/**
 * 演示账号默认关闭。开启后必须同时提供合法用户名和密码，避免只配置了一个变量就意外暴露入口。
 */
export function readDemoAccountConfig(env: NodeJS.ProcessEnv = process.env): DemoAccountConfig | null {
  if (!isEnabled(env.DEMO_ACCOUNT_ENABLED)) return null;

  const username = env.DEMO_ACCOUNT_USERNAME?.trim();
  const password = env.DEMO_ACCOUNT_PASSWORD ?? "";
  if (!username || username.length < 3 || username.length > 32 || password.length < 8 || password.length > 200) {
    throw new DemoAccountConfigError();
  }

  return { username, password };
}

async function requireMatchingUser(
  user: Awaited<ReturnType<PrismaClient["user"]["findUnique"]>>,
  password: string,
) {
  if (!user || !(await argon2.verify(user.passwordHash, password))) throw new DemoAccountConflictError();
  return user;
}

/**
 * 首次点击体验入口时按配置创建用户；后续请求复用同一个用户。
 * 已存在的同名用户必须验证密码，绝不覆盖其密码或资料，避免影响普通账号。
 */
export async function ensureDemoUser(prisma: PrismaClient, config: DemoAccountConfig) {
  const existing = await prisma.user.findUnique({ where: { username: config.username } });
  if (existing) return requireMatchingUser(existing, config.password);

  const passwordHash = await argon2.hash(config.password);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await prisma.user.create({
        data: { uid: generateUid(), username: config.username, passwordHash, memoryEnabled: true },
      });
    } catch (error) {
      if (uniqueConstraintTargets(error) === null) throw error;
      const winner = await prisma.user.findUnique({ where: { username: config.username } });
      if (winner) return requireMatchingUser(winner, config.password);
      if (isUniqueConstraintOn(error, "username")) throw new DemoAccountConflictError();
      if (!isUniqueConstraintOn(error, "uid") && uniqueConstraintTargets(error)?.length) throw error;
    }
  }
  throw new Error("UID 生成多次冲突，请重试");
}
