import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../auth/token.js";
import { buildServer } from "../server.js";

interface SessionListItem {
  id: string;
  title: string;
  agentId: string | null;
  agentName: string | null;
  agentIcon: string;
  updatedAt: string;
}

interface SessionMessageItem {
  role: string;
  content: string;
  model: string | null;
  createdAt: string;
}

interface ListResponse<T> {
  success: boolean;
  data: T[];
}

const prisma = getPrisma();
const runId = randomUUID();
const sessionsToDelete = new Set<string>();
let app: FastifyInstance;
let firstUserId = "";
let secondUserId = "";
let firstToken = "";
let secondToken = "";

function auth(token: string): { authorization: string } {
  return { authorization: "Bearer " + token };
}

function sessionId(suffix: string): string {
  return "chat-session-" + runId + "-" + suffix;
}

async function createSession(args: {
  owner?: string;
  suffix: string;
  updatedAt?: Date;
  agentId?: string | null;
  agentName?: string | null;
}): Promise<string> {
  const id = sessionId(args.suffix);
  await prisma.session.create({
    data: {
      id,
      userId: args.owner ?? firstUserId,
      updatedAt: args.updatedAt ?? new Date(),
      agentId: args.agentId === undefined ? "preset-1" : args.agentId,
      agentName: args.agentName === undefined ? "默认助手" : args.agentName,
    },
  });
  sessionsToDelete.add(id);
  return id;
}

async function createMessage(args: {
  sessionId: string;
  suffix: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
  model?: string;
}): Promise<void> {
  await prisma.message.create({
    data: {
      id: "chat-message-" + runId + "-" + args.suffix,
      sessionId: args.sessionId,
      role: args.role,
      content: args.content,
      createdAt: args.createdAt,
      model: args.model,
    },
  });
}

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);

  const users = await Promise.all([
    prisma.user.create({
      data: {
        uid: "chat-user-one-" + runId,
        username: "chat-user-one-" + runId,
        passwordHash: "test-hash",
      },
    }),
    prisma.user.create({
      data: {
        uid: "chat-user-two-" + runId,
        username: "chat-user-two-" + runId,
        passwordHash: "test-hash",
      },
    }),
  ]);
  firstUserId = users[0].id;
  secondUserId = users[1].id;
  firstToken = signToken(firstUserId, process.env.SESSION_SECRET);
  secondToken = signToken(secondUserId, process.env.SESSION_SECRET);

  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  const ids = Array.from(sessionsToDelete);
  sessionsToDelete.clear();
  if (ids.length > 0) {
    await prisma.session.deleteMany({ where: { id: { in: ids } } });
  }
});

afterAll(async () => {
  if (firstUserId && secondUserId) {
    await prisma.user.deleteMany({
      where: { id: { in: [firstUserId, secondUserId] } },
    });
  }
  await app?.close();
});

describe("GET /api/sessions", () => {
  it("returns only owned sessions with real empty and first-user-message titles", async () => {
    const empty = await createSession({
      suffix: "empty",
      updatedAt: new Date("2026-09-07T12:00:00.000Z"),
    });
    const titled = await createSession({
      suffix: "titled",
      updatedAt: new Date("2026-09-07T11:00:00.000Z"),
    });
    const assistantOnly = await createSession({
      suffix: "assistant-only",
      updatedAt: new Date("2026-09-07T10:00:00.000Z"),
    });
    const foreign = await createSession({
      owner: secondUserId,
      suffix: "foreign",
      updatedAt: new Date("2026-09-07T13:00:00.000Z"),
    });
    const longTitle = "This message is deliberately longer than thirty characters";
    await createMessage({
      sessionId: titled,
      suffix: "title-assistant",
      role: "assistant",
      content: "assistant text must not become the title",
      createdAt: new Date("2026-09-07T08:00:00.000Z"),
    });
    await createMessage({
      sessionId: titled,
      suffix: "title-user",
      role: "user",
      content: longTitle,
      createdAt: new Date("2026-09-07T09:00:00.000Z"),
    });
    await createMessage({
      sessionId: assistantOnly,
      suffix: "assistant-only",
      role: "assistant",
      content: "assistant only",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: auth(firstToken),
    });
    const body = JSON.parse(response.body) as ListResponse<SessionListItem>;

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.map((session) => session.id)).toEqual([empty, titled, assistantOnly]);
    expect(body.data.find((session) => session.id === empty)?.title).toBe("新对话");
    expect(body.data.find((session) => session.id === titled)?.title).toBe(longTitle.slice(0, 30));
    expect(body.data.find((session) => session.id === assistantOnly)?.title).toBe("新对话");
    expect(body.data.some((session) => session.id === foreign)).toBe(false);
    expect(body.data[0]).toMatchObject({
      agentId: "preset-1",
      agentName: "默认助手",
      agentIcon: expect.any(String),
      updatedAt: "2026-09-07T12:00:00.000Z",
    });
  });

  it("uses id descending as a stable tie-breaker for equal update times", async () => {
    const updatedAt = new Date("2026-09-07T12:00:00.000Z");
    const lower = await createSession({ suffix: "tie-a", updatedAt });
    const higher = await createSession({ suffix: "tie-b", updatedAt });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: auth(firstToken),
    });
    const body = JSON.parse(response.body) as ListResponse<SessionListItem>;

    expect(body.data.map((session) => session.id)).toEqual([higher, lower]);
  });

  it("caps the newest-session list at 50 rows", async () => {
    const updatedAt = new Date("2026-09-07T12:00:00.000Z");
    const rows = Array.from({ length: 51 }, (_, index) => {
      const id = sessionId("limit-" + String(index).padStart(2, "0"));
      sessionsToDelete.add(id);
      return { id, userId: firstUserId, updatedAt };
    });
    await prisma.session.createMany({ data: rows });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: auth(firstToken),
    });
    const body = JSON.parse(response.body) as ListResponse<SessionListItem>;

    expect(body.data).toHaveLength(50);
    expect(body.data[0]?.id).toBe(sessionId("limit-50"));
    expect(body.data.some((session) => session.id === sessionId("limit-00"))).toBe(false);
  });

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/sessions/:id/messages", () => {
  it("returns a stable chronological message list", async () => {
    const id = await createSession({ suffix: "messages" });
    const sameTime = new Date("2026-09-07T12:00:00.000Z");
    await createMessage({
      sessionId: id,
      suffix: "order-02",
      role: "assistant",
      content: "answer",
      createdAt: sameTime,
      model: "glm-5.2",
    });
    await createMessage({
      sessionId: id,
      suffix: "order-01",
      role: "user",
      content: "question",
      createdAt: sameTime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/" + id + "/messages",
      headers: auth(firstToken),
    });
    const body = JSON.parse(response.body) as ListResponse<SessionMessageItem>;

    expect(response.statusCode).toBe(200);
    expect(body.data).toEqual([
      {
        role: "user",
        content: "question",
        model: null,
        createdAt: sameTime.toISOString(),
      },
      {
        role: "assistant",
        content: "answer",
        model: "glm-5.2",
        createdAt: sameTime.toISOString(),
      },
    ]);
  });

  it("returns an empty list for a genuinely empty session", async () => {
    const id = await createSession({ suffix: "empty-messages" });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/" + id + "/messages",
      headers: auth(firstToken),
    });
    const body = JSON.parse(response.body) as ListResponse<SessionMessageItem>;

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({ success: true, data: [] });
  });

  it("distinguishes a foreign session from a missing session", async () => {
    const foreign = await createSession({
      owner: secondUserId,
      suffix: "foreign-messages",
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/sessions/" + foreign + "/messages",
      headers: auth(firstToken),
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/sessions/" + sessionId("missing") + "/messages",
      headers: auth(firstToken),
    });

    expect(forbidden.statusCode).toBe(403);
    expect(missing.statusCode).toBe(404);
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("deletes an owned session and cascades its messages", async () => {
    const id = await createSession({ suffix: "delete" });
    await createMessage({
      sessionId: id,
      suffix: "delete-message",
      role: "user",
      content: "remove me",
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/sessions/" + id,
      headers: auth(firstToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    await expect(prisma.session.findUnique({ where: { id } })).resolves.toBeNull();
    await expect(prisma.message.count({ where: { sessionId: id } })).resolves.toBe(0);
  });

  it("does not delete another user's session", async () => {
    const foreign = await createSession({
      owner: secondUserId,
      suffix: "foreign-delete",
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/sessions/" + foreign,
      headers: auth(firstToken),
    });

    expect(response.statusCode).toBe(403);
    await expect(prisma.session.findUnique({ where: { id: foreign } })).resolves.not.toBeNull();

    const ownerResponse = await app.inject({
      method: "DELETE",
      url: "/api/sessions/" + foreign,
      headers: auth(secondToken),
    });
    expect(ownerResponse.statusCode).toBe(200);
  });

  it("returns 404 for a missing session", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/sessions/" + sessionId("missing-delete"),
      headers: auth(firstToken),
    });
    expect(response.statusCode).toBe(404);
  });
});
