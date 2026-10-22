import type { PrismaClient, User } from "@prisma/client";
import argon2 from "argon2";
import Fastify from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerAccountRoutes } from "./account-routes.js";
import type { AuthRouteContext } from "./auth-route-context.js";

const secret = "session-secret-that-is-at-least-32-chars";
const IDENTIFIER = "12345678";
const RIGHT_PASSWORD = "correct-password";

function user(username: string, passwordHash: string): User {
  return {
    id: "user-id",
    uid: IDENTIFIER,
    username,
    passwordHash,
    memoryEnabled: true,
    bannedAt: null,
    createdAt: new Date(0),
  };
}

function context(prisma: PrismaClient): AuthRouteContext {
  return { prisma, secret, recordLogin: vi.fn() };
}

/** 与 shared/quota.test.ts 同形状的假 Redis，多一个 del 用来观察「成功清零」。 */
function fakeRedis(initialCount = 0) {
  let count = initialCount;
  let ttl = -1;
  const del = vi.fn(async (_key: string) => {
    count = 0;
    ttl = -1;
    return 1;
  });
  const redis = {
    multi: () => {
      const queued: (() => number)[] = [];
      const chain = {
        incr: () => {
          queued.push(() => ++count);
          return chain;
        },
        ttl: () => {
          queued.push(() => ttl);
          return chain;
        },
        exec: async () => queued.map((run) => [null, run()]),
      };
      return chain;
    },
    expire: async (_key: string, seconds: number) => {
      ttl = seconds;
      return 1;
    },
    del,
  } as never;
  return {
    redis,
    del,
    endWindow: () => {
      count = 0;
      ttl = -1;
    },
  };
}

describe("account registration races", () => {
  it("maps a database username race to 409", async () => {
    const prisma = {
      user: {
        create: vi.fn().mockRejectedValue({ code: "P2002", meta: { target: "User_username_key" } }),
      },
    } as unknown as PrismaClient;
    const app = Fastify();
    registerAccountRoutes(app, context(prisma));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "taken-user", password: "password123" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "用户名已被占用" });
    await app.close();
  });

  it("retries with a new UID after a UID unique-key race", async () => {
    const created = user("new-user", "unused");
    const create = vi.fn()
      .mockRejectedValueOnce({ code: "P2002", meta: { target: ["uid"] } })
      .mockResolvedValueOnce(created);
    const prisma = { user: { create } } as unknown as PrismaClient;
    const app = Fastify();
    registerAccountRoutes(app, context(prisma));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: created.username, password: "password123" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId: created.id, uid: created.uid });
    expect(create).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

describe("登录尝试限流", () => {
  let passwordHash = "";

  beforeAll(async () => {
    passwordHash = await argon2.hash(RIGHT_PASSWORD);
  });

  afterEach(() => vi.restoreAllMocks());

  function loginApp(initialCount = 0) {
    const f = fakeRedis(initialCount);
    const findFirst = vi.fn().mockResolvedValue(user("someone", passwordHash));
    const prisma = {
      user: { findFirst },
    } as unknown as PrismaClient;
    const app = Fastify();
    const routeContext = { ...context(prisma), redis: f.redis };
    registerAccountRoutes(app, routeContext);
    return { app, findFirst, recordLogin: routeContext.recordLogin, ...f };
  }

  const login = (app: ReturnType<typeof Fastify>, password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: IDENTIFIER, password } });

  it("连续 10 次失败后第 11 次返回 429", async () => {
    const { app } = loginApp();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login(app, "wrong-password");
      expect(response.statusCode, `第 ${attempt + 1} 次`).toBe(401);
    }

    const blocked = await login(app, "wrong-password");
    expect(blocked.statusCode).toBe(429);

    await app.close();
  });

  // 回「账号已被锁定」等于替攻击者确认账号存在，所以两句话必须一模一样
  it("超限文案与密码错误文案相同", async () => {
    const { app } = loginApp();

    const failed = await login(app, "wrong-password");
    for (let attempt = 0; attempt < 10; attempt += 1) await login(app, "wrong-password");
    const blocked = await login(app, "wrong-password");

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual(failed.json());
    expect(blocked.json()).toEqual({ error: "账号或密码错误" });

    await app.close();
  });

  it.each(["wrong-password", RIGHT_PASSWORD])("额度耗尽时不查用户、不校验密码、不签发会话：%s", async (password) => {
    const { app, findFirst, recordLogin, del } = loginApp(10);
    const verify = vi.spyOn(argon2, "verify");
    try {
      const response = await login(app, password);

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: "账号或密码错误" });
      expect(findFirst).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(recordLogin).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("并发请求也只有额度内的一次能进入密码校验", async () => {
    const { app, findFirst } = loginApp(9);
    const verify = vi.spyOn(argon2, "verify");
    try {
      const responses = await Promise.all(Array.from({ length: 5 }, () => login(app, "wrong-password")));

      expect(responses.map((response) => response.statusCode).sort()).toEqual([401, 429, 429, 429, 429]);
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("窗口到期后恢复正常登录", async () => {
    const { app, findFirst, endWindow } = loginApp(10);
    try {
      expect((await login(app, RIGHT_PASSWORD)).statusCode).toBe(429);
      expect(findFirst).not.toHaveBeenCalled();

      endWindow();
      expect((await login(app, RIGHT_PASSWORD)).statusCode).toBe(200);
      expect(findFirst).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("Redis 故障按既有策略放行，密码校验仍然有效", async () => {
    const findFirst = vi.fn().mockResolvedValue(user("someone", passwordHash));
    const prisma = { user: { findFirst } } as unknown as PrismaClient;
    const app = Fastify();
    const failedRedis = {
      multi: () => { throw new Error("Redis 暂时不可用"); },
      del: vi.fn().mockResolvedValue(1),
    } as never;
    registerAccountRoutes(app, { ...context(prisma), redis: failedRedis });
    try {
      expect((await login(app, "wrong-password")).statusCode).toBe(401);
      expect((await login(app, RIGHT_PASSWORD)).statusCode).toBe(200);
      expect(findFirst).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("额度内登录成功会清零尝试计数", async () => {
    const { app, del } = loginApp();

    for (let attempt = 0; attempt < 5; attempt += 1) await login(app, "wrong-password");
    expect(del).not.toHaveBeenCalled();

    const ok = await login(app, RIGHT_PASSWORD);
    expect(ok.statusCode).toBe(200);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[0]).toContain(`auth:login-fail:${IDENTIFIER}`);

    // 假 Redis 的 DEL 必须真的清零，验证下一轮重试不会继承上一轮失败次数。
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(app, "wrong-password")).statusCode).toBe(401);
    }
    expect((await login(app, "wrong-password")).statusCode).toBe(429);

    await app.close();
  });

  it("没配 redis 时计数闸放行，登录行为不变", async () => {
    const prisma = {
      user: { findFirst: vi.fn().mockResolvedValue(user("someone", passwordHash)) },
    } as unknown as PrismaClient;
    const app = Fastify();
    registerAccountRoutes(app, context(prisma));

    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await login(app, "wrong-password")).statusCode).toBe(401);
    }

    await app.close();
  });
});
