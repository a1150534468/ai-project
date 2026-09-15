import type { PrismaClient, User } from "@prisma/client";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerAccountRoutes } from "./account-routes.js";
import type { AuthRouteContext } from "./auth-route-context.js";

const secret = "session-secret-that-is-at-least-32-chars";

function user(username: string): User {
  return {
    id: "user-id",
    uid: "12345678",
    username,
    passwordHash: "unused",
    memoryEnabled: true,
    bannedAt: null,
    createdAt: new Date(0),
  };
}

function context(prisma: PrismaClient): AuthRouteContext {
  return { prisma, secret, recordLogin: vi.fn() };
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
    const created = user("new-user");
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
