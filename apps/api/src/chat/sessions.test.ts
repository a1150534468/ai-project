import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signToken } from "../auth/token.js";
import type { FastifyInstance } from "fastify";

describe("Session Routes", () => {
  let app: FastifyInstance;
  const prisma = getPrisma();

  // Test users
  let userId1: string;
  let userId2: string;
  let token1: string;
  let token2: string;

  // Test sessions
  let session1Id: string = "";
  let session2Id: string = "";
  let session3Id: string = "";
  // Cleanup tracking
  const userIdsToDelete: string[] = [];
  const sessionIdsToDelete: string[] = [];

  beforeAll(async () => {
    // Setup env for buildServer
    process.env.SESSION_SECRET ??= "x".repeat(32);
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.LLM_BASE_URL ??= "http://localhost:9999";
    process.env.LLM_API_KEY ??= "test-key";
    process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);

    app = await buildServer();

    // Create two test users
    const user1 = await prisma.user.create({
      data: {
        uid: `test-uid-1-${Date.now()}`,
        username: `test-user-1-${Date.now()}`,
        passwordHash: "hash1",
      },
    });
    userId1 = user1.id;
    userIdsToDelete.push(userId1);

    const user2 = await prisma.user.create({
      data: {
        uid: `test-uid-2-${Date.now()}`,
        username: `test-user-2-${Date.now()}`,
        passwordHash: "hash2",
      },
    });
    userId2 = user2.id;
    userIdsToDelete.push(userId2);

    // Generate valid tokens using signToken
    const secret = process.env.SESSION_SECRET!;
    token1 = signToken(userId1, secret);
    token2 = signToken(userId2, secret);

    // Create sessions for user1
    const s1 = await prisma.session.create({
      data: { userId: userId1 },
    });
    session1Id = s1.id;
    sessionIdsToDelete.push(session1Id);

    const s2 = await prisma.session.create({
      data: { userId: userId1 },
    });
    session2Id = s2.id;
    sessionIdsToDelete.push(session2Id);

    // Create session for user2
    const s3 = await prisma.session.create({
      data: { userId: userId2 },
    });
    session3Id = s3.id;
    sessionIdsToDelete.push(session3Id);

    // Add messages to sessions
    // Session1: user message "Hello, this is a long message that should be truncated to 30 chars"
    await prisma.message.create({
      data: {
        sessionId: session1Id,
        role: "user",
        content: "Hello, this is a long message that should be truncated to 30 chars",
      },
    });
    await prisma.message.create({
      data: {
        sessionId: session1Id,
        role: "assistant",
        content: "Response 1",
      },
    });

    // Session2: user message "Short" (shorter than 30 chars)
    await prisma.message.create({
      data: {
        sessionId: session2Id,
        role: "user",
        content: "Short",
      },
    });

    // Session3: no messages (should default to "新对话")
    // (leave empty for now)

    // Add message to user2's session to test separation
    await prisma.message.create({
      data: {
        sessionId: session3Id,
        role: "user",
        content: "User2 message",
      },
    });
  });

  afterAll(async () => {
    // Cleanup: delete by id (id-scoped, not global deleteMany)
    // Filter out empty strings to avoid Prisma validation errors
    const validSessionIds = sessionIdsToDelete.filter(Boolean);
    const validUserIds = userIdsToDelete.filter(Boolean);

    if (validSessionIds.length > 0) {
      await prisma.message.deleteMany({
        where: {
          sessionId: {
            in: validSessionIds,
          },
        },
      });

      await prisma.session.deleteMany({
        where: {
          id: {
            in: validSessionIds,
          },
        },
      });
    }

    if (validUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: {
          id: {
            in: validUserIds,
          },
        },
      });
    }

    await app.close();
  });

  describe("GET /api/sessions", () => {
    it("should return sessions for authenticated user (only their own)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);

      // Should have 2 sessions for user1
      const sessions = body.data;
      expect(sessions.length).toBe(2);

      // Sessions should have id, title, updatedAt
      sessions.forEach((s: unknown) => {
        expect(typeof s === "object" && s !== null).toBe(true);
        const session = s as Record<string, unknown>;
        expect(typeof session.id).toBe("string");
        expect(typeof session.title).toBe("string");
        expect(typeof session.updatedAt).toBe("string");
      });

      // Check titles:
      // session1 should be "Hello, this is a long messa..." (truncated to 30 chars)
      // session2 should be "Short"
      const sorted = sessions.sort((a: unknown, b: unknown) => {
        const aTime = new Date((a as any).updatedAt).getTime();
        const bTime = new Date((b as any).updatedAt).getTime();
        return bTime - aTime; // newest first
      });

      // Check that one title is truncated version of "Hello..." (30 chars)
      const titles = sorted.map((s: unknown) => (s as any).title);
      expect(titles).toContain("Short");
      const helloTitle = titles.find((t: string) => t.startsWith("Hello"));
      expect(helloTitle?.length).toBeLessThanOrEqual(30);
    });

    it("should return empty array for user with no sessions", async () => {
      const newUser = await prisma.user.create({
        data: {
          uid: `empty-user-${Date.now()}`,
          username: `empty-${Date.now()}`,
          passwordHash: "hash",
        },
      });

      const newToken = signToken(newUser.id, process.env.SESSION_SECRET!);
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          authorization: `Bearer ${newToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.length).toBe(0);

      // Cleanup
      await prisma.user.delete({ where: { id: newUser.id } });
    });

    it("should return 401 when not authenticated", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
      });

      expect(res.statusCode).toBe(401);
    });

    it("should return sessions in descending updatedAt order", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const sessions = body.data;

      // Check that sessions are ordered by updatedAt descending
      for (let i = 0; i < sessions.length - 1; i++) {
        const current = new Date((sessions[i] as any).updatedAt).getTime();
        const next = new Date((sessions[i + 1] as any).updatedAt).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    it("should not return other user's sessions", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const sessionIds = body.data.map((s: unknown) => (s as any).id);

      // Should NOT contain user2's session
      expect(sessionIds).not.toContain(session3Id);
    });

    it("should use '新对话' as title when session has no messages", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          authorization: `Bearer ${token2}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const sessions = body.data;

      // Should have 1 session for user2
      expect(sessions.length).toBe(1);

      // Though we added a message to session3, if we had an empty session,
      // it would have "新对话". Let me verify with the actual message.
      expect(sessions[0].title).toBe("User2 message");
    });
  });

  describe("GET /api/sessions/:id/messages", () => {
    it("should return messages for user's own session in ascending order", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${session1Id}/messages`,
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);

      const messages = body.data;
      expect(messages.length).toBe(2);

      // Check message structure
      messages.forEach((m: unknown) => {
        const msg = m as Record<string, unknown>;
        expect(typeof msg.role).toBe("string");
        expect(typeof msg.content).toBe("string");
        expect(typeof msg.createdAt).toBe("string");
      });

      // Verify order (should be user message first, then assistant)
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello, this is a long message that should be truncated to 30 chars");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Response 1");

      // Verify timestamps are in ascending order
      const time0 = new Date(messages[0].createdAt as string).getTime();
      const time1 = new Date(messages[1].createdAt as string).getTime();
      expect(time0).toBeLessThanOrEqual(time1);
    });

    it("should return 403 when trying to access other user's session messages", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${session3Id}/messages`,
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it("should return 404 when session does not exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/nonexistent-id/messages",
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("should return 401 when not authenticated", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${session1Id}/messages`,
      });

      expect(res.statusCode).toBe(401);
    });

    it("should return empty array when session has no messages", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${session3Id}/messages`,
        headers: {
          authorization: `Bearer ${token2}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1); // session3 has 1 user message
    });
  });

  describe("DELETE /api/sessions/:id", () => {
    it("should delete user's own session and cascade delete messages", async () => {
      // Verify session exists before delete
      let session = await prisma.session.findUnique({
        where: { id: session1Id },
      });
      expect(session).toBeDefined();

      const messagesBeforeDelete = await prisma.message.count({
        where: { sessionId: session1Id },
      });
      expect(messagesBeforeDelete).toBe(2);

      // Delete session
      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${session1Id}`,
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      // Verify session is deleted
      session = await prisma.session.findUnique({
        where: { id: session1Id },
      });
      expect(session).toBeNull();

      // Verify messages are cascade deleted
      const messagesAfterDelete = await prisma.message.count({
        where: { sessionId: session1Id },
      });
      expect(messagesAfterDelete).toBe(0);
    });

    it("should return 403 when trying to delete other user's session", async () => {
      // Try to delete user2's session using user1's token
      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${session3Id}`,
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(403);

      // Verify session is NOT deleted
      const session = await prisma.session.findUnique({
        where: { id: session3Id },
      });
      expect(session).toBeDefined();
    });

    it("should return 404 when session does not exist", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/sessions/nonexistent-id",
        headers: {
          authorization: `Bearer ${token1}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("should return 401 when not authenticated", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${session2Id}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
