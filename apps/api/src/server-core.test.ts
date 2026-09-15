import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signToken } from "./auth/token.js";
import { installRequestAuthentication, readCookieValue } from "./server-auth.js";
import { installErrorHandler } from "./server-errors.js";
import { apiBodyLimit } from "./server-foundation.js";
import { closeApplication } from "./server-lifecycle.js";

describe("server request authentication", () => {
  it("reads exact cookie names and tolerates malformed escaping", () => {
    expect(readCookieValue("theme=dark; token=user%2Etoken", "token")).toBe("user.token");
    expect(readCookieValue("tokenish=no; token=%broken", "token")).toBe("%broken");
    expect(readCookieValue("tokenish=no", "token")).toBeNull();
  });

  it("accepts signed cookies and gives an Authorization bearer token precedence", async () => {
    const secret = "session-secret-that-is-at-least-32-chars";
    const app = Fastify();
    installRequestAuthentication(app, secret);
    app.get("/who", async (request) => ({ userId: request.userId }));

    const cookie = await app.inject({
      method: "GET",
      url: "/who",
      headers: { cookie: `token=${signToken("cookie-user", secret)}` },
    });
    expect(cookie.json()).toEqual({ userId: "cookie-user" });

    const bearer = await app.inject({
      method: "GET",
      url: "/who",
      headers: {
        authorization: `Bearer ${signToken("bearer-user", secret)}`,
        cookie: `token=${signToken("cookie-user", secret)}`,
      },
    });
    expect(bearer.json()).toEqual({ userId: "bearer-user" });
    await app.close();
  });
});

describe("server error boundary", () => {
  it("keeps client errors but hides internal error details", async () => {
    const app = Fastify();
    installErrorHandler(app);
    app.get("/client", async () => {
      throw Object.assign(new Error("请求参数冲突"), { statusCode: 409 });
    });
    app.get("/internal", async () => {
      throw new Error("/private/path leaked");
    });

    expect((await app.inject({ method: "GET", url: "/client" })).json()).toEqual({ error: "请求参数冲突" });
    expect((await app.inject({ method: "GET", url: "/internal" })).json()).toEqual({ error: "服务器内部错误" });
    await app.close();
  });
});

describe("server limits", () => {
  it("uses only positive finite body limits", () => {
    expect(apiBodyLimit({ API_BODY_LIMIT_BYTES: "1024" })).toBe(1024);
    expect(apiBodyLimit({ API_BODY_LIMIT_BYTES: "-1" })).toBe(30 * 1024 * 1024);
    expect(apiBodyLimit({ API_BODY_LIMIT_BYTES: "0.5" })).toBe(30 * 1024 * 1024);
    expect(apiBodyLimit({ API_BODY_LIMIT_BYTES: "not-a-number" })).toBe(30 * 1024 * 1024);
  });
});

describe("server shutdown", () => {
  it("runs Fastify onClose hooks before disconnecting shared stores", async () => {
    const events: string[] = [];
    const app = {
      close: async () => {
        events.push("app");
      },
      log: { info: vi.fn(), error: vi.fn() },
    } as unknown as ReturnType<typeof Fastify>;

    await closeApplication(app, "SIGTERM", {
      disconnectPrisma: async () => {
        events.push("prisma");
      },
      quitRedis: async () => {
        events.push("redis");
      },
    });

    expect(events[0]).toBe("app");
    expect(events.slice(1).sort()).toEqual(["prisma", "redis"]);
  });
});
