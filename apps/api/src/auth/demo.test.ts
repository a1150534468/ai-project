import argon2 from "argon2";
import type { PrismaClient } from "@ai-assistant/db";
import { describe, expect, it, vi } from "vitest";
import { DemoAccountConfigError, ensureDemoUser, readDemoAccountConfig } from "./demo.js";

describe("体验账号配置", () => {
  it("默认关闭且不暴露任何账号信息", () => {
    expect(readDemoAccountConfig({})).toBeNull();
  });

  it("开启后读取用户名和密码", () => {
    expect(
      readDemoAccountConfig({
        DEMO_ACCOUNT_ENABLED: "true",
        DEMO_ACCOUNT_USERNAME: " demo ",
        DEMO_ACCOUNT_PASSWORD: "demo-password",
      }),
    ).toEqual({ username: "demo", password: "demo-password" });
  });

  it("开启但配置不完整时明确报错", () => {
    expect(() => readDemoAccountConfig({ DEMO_ACCOUNT_ENABLED: "1", DEMO_ACCOUNT_USERNAME: "demo" })).toThrow(
      DemoAccountConfigError,
    );
  });
});

describe("体验账号创建竞态", () => {
  const config = { username: "demo", password: "demo-password" };

  it("UID 唯一键冲突时换一个 UID 重试", async () => {
    const user = { id: "user-1", uid: "12345678", username: config.username, passwordHash: "hash" };
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn()
      .mockRejectedValueOnce({ code: "P2002", meta: { target: ["uid"] } })
      .mockResolvedValueOnce(user);
    const prisma = { user: { findUnique, create } } as unknown as PrismaClient;

    await expect(ensureDemoUser(prisma, config)).resolves.toBe(user);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("并发请求已创建同名账号时复用胜出的账号", async () => {
    const winner = {
      id: "user-2",
      uid: "87654321",
      username: config.username,
      passwordHash: await argon2.hash(config.password),
    };
    const findUnique = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const create = vi.fn().mockRejectedValueOnce({ code: "P2002", meta: { target: "User_username_key" } });
    const prisma = { user: { findUnique, create } } as unknown as PrismaClient;

    await expect(ensureDemoUser(prisma, config)).resolves.toBe(winner);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
