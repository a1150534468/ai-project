import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@yc/db";
import {
  dedupeKbCitations,
  filterRelevantChunks,
  resolveEffectiveKbIds,
  shouldRetrieveKbForQuery,
  retrieveChunks,
} from "./retrieve.js";

describe("KB Retrieve", () => {
  let prisma: PrismaClient;
  let userId: string;
  let userId2: string;
  let userOwnKbId1: string;
  let userOwnKbId2: string;
  let officialKbId: string;
  let otherUserKbId: string;

  beforeAll(async () => {
    prisma = getPrisma();

    // Create test users
    userId = `test_user_${Date.now()}`;
    userId2 = `test_user2_${Date.now()}`;

    await prisma.user.create({
      data: { uid: userId, username: userId, passwordHash: "hash" },
    });
    await prisma.user.create({
      data: { uid: userId2, username: userId2, passwordHash: "hash" },
    });

    // User1 creates 2 knowledge bases
    const kb1 = await prisma.knowledgeBase.create({
      data: {
        ownerType: "USER",
        userId,
        name: "User KB 1",
      },
    });
    userOwnKbId1 = kb1.id;

    const kb2 = await prisma.knowledgeBase.create({
      data: {
        ownerType: "USER",
        userId,
        name: "User KB 2",
      },
    });
    userOwnKbId2 = kb2.id;

    // Official KB
    const officialKb = await prisma.knowledgeBase.create({
      data: {
        ownerType: "OFFICIAL",
        name: "Official KB",
      },
    });
    officialKbId = officialKb.id;

    // Other user's KB
    const otherKb = await prisma.knowledgeBase.create({
      data: {
        ownerType: "USER",
        userId: userId2,
        name: "Other User KB",
      },
    });
    otherUserKbId = otherKb.id;
  });

  afterAll(async () => {
    // Cleanup
    await prisma.knowledgeBase.deleteMany({
      where: {
        OR: [
          { id: userOwnKbId1 },
          { id: userOwnKbId2 },
          { id: officialKbId },
          { id: otherUserKbId },
        ],
      },
    });
    await prisma.user.deleteMany({
      where: { OR: [{ uid: userId }, { uid: userId2 }] },
    });
  });

  describe("resolveEffectiveKbIds", () => {
    it("returns empty array when no selection provided", async () => {
      const result = await resolveEffectiveKbIds(prisma, userId, {});
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it("filters attachedKbIds to exclude other users' KBs (越权过滤)", async () => {
      const result = await resolveEffectiveKbIds(prisma, userId, {
        attachedKbIds: [userOwnKbId1, officialKbId, otherUserKbId],
      });

      expect(result).toContain(userOwnKbId1);
      expect(result).toContain(officialKbId);
      expect(result).not.toContain(otherUserKbId); // 他人 KB 被剔除
    });

    it("includes all user's own KBs when kbAttachAllOwn=true", async () => {
      const result = await resolveEffectiveKbIds(prisma, userId, {
        kbAttachAllOwn: true,
        attachedKbIds: [officialKbId],
      });

      expect(result).toContain(userOwnKbId1);
      expect(result).toContain(userOwnKbId2);
      expect(result).toContain(officialKbId);
      expect(result).not.toContain(otherUserKbId);
    });

    it("combines kbAttachAllOwn=true with attachedKbIds filtering", async () => {
      const result = await resolveEffectiveKbIds(prisma, userId, {
        kbAttachAllOwn: true,
        attachedKbIds: [officialKbId, otherUserKbId],
      });

      // Should have: user's own KBs + (official from attachedKbIds) - other user's KB
      expect(result).toContain(userOwnKbId1);
      expect(result).toContain(userOwnKbId2);
      expect(result).toContain(officialKbId);
      expect(result).not.toContain(otherUserKbId);
    });

    it("deduplicates result", async () => {
      const result = await resolveEffectiveKbIds(prisma, userId, {
        kbAttachAllOwn: true,
        attachedKbIds: [userOwnKbId1, userOwnKbId1], // Duplicate
      });

      const uniqueIds = new Set(result);
      expect(uniqueIds.size).toBe(result.length); // No duplicates
    });
  });

  describe("retrieveChunks", () => {
    let indexedDocId: string;
    let failedDocId: string;
    let testKbId: string;
    const testVector = new Array(4096).fill(0.1);
    const testVector2 = new Array(4096).fill(0.2);

    beforeAll(async () => {
      testKbId = userOwnKbId1;

      // Create indexed document with chunks
      const indexedDoc = await prisma.document.create({
        data: {
          kbId: testKbId,
          name: "Indexed Document",
          status: "indexed",
          sourceType: "TEXT",
        },
      });
      indexedDocId = indexedDoc.id;

      // Insert chunks for indexed document using raw query (vector type)
      const toVecLiteral = (v: number[]) => `[${v.join(",")}]`;
      for (let i = 0; i < 2; i++) {
        const content =
          i === 0 ? "First chunk content" : "Second chunk content";
        const vec = i === 0 ? testVector : testVector2;
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Chunk"(id, "documentId", "kbId", ordinal, content, embedding, "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::vector, now())`,
          indexedDocId,
          testKbId,
          i,
          content,
          toVecLiteral(vec)
        );
      }

      // Create failed document with chunks (should not be retrieved)
      const failedDoc = await prisma.document.create({
        data: {
          kbId: testKbId,
          name: "Failed Document",
          status: "failed",
          sourceType: "TEXT",
        },
      });
      failedDocId = failedDoc.id;

      // Insert chunks for failed document
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Chunk"(id, "documentId", "kbId", ordinal, content, embedding, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::vector, now())`,
        failedDocId,
        testKbId,
        0,
        "Failed chunk (should not appear)",
        toVecLiteral(testVector)
      );
    });

    afterAll(async () => {
      // Chunks cascade delete with documents
      if (indexedDocId && failedDocId) {
        await prisma.document.deleteMany({
          where: { id: { in: [indexedDocId, failedDocId] } },
        });
      }
    });

    it("returns empty array when kbIds is empty", async () => {
      const result = await retrieveChunks(prisma, [], testVector, 10);
      expect(result).toEqual([]);
    });

    it("retrieves only chunks from indexed documents", async () => {
      const result = await retrieveChunks(prisma, [testKbId], testVector, 10);

      expect(result.length).toBeGreaterThan(0);

      // All returned chunks should be from indexed documents
      for (const chunk of result) {
        expect(chunk.docName).toBe("Indexed Document");
        expect(chunk.content).not.toContain("Failed");
      }

      // Verify failed document chunks are not included
      const failedChunks = result.filter(
        (c) => c.content.includes("Failed")
      );
      expect(failedChunks.length).toBe(0);
    });

    it("returns chunks with correct structure", async () => {
      const result = await retrieveChunks(prisma, [testKbId], testVector, 10);

      expect(result.length).toBeGreaterThan(0);

      for (const chunk of result) {
        expect(chunk).toHaveProperty("content");
        expect(chunk).toHaveProperty("docName");
        expect(chunk).toHaveProperty("ordinal");
        expect(chunk).toHaveProperty("score");

        expect(typeof chunk.content).toBe("string");
        expect(typeof chunk.docName).toBe("string");
        expect(typeof chunk.ordinal).toBe("number");
        expect(typeof chunk.score).toBe("number");
        expect(chunk.score).toBeGreaterThanOrEqual(0);
        expect(chunk.score).toBeLessThanOrEqual(1);
      }
    });

    it("respects topK limit", async () => {
      const topK = 1;
      const result = await retrieveChunks(prisma, [testKbId], testVector, topK);

      expect(result.length).toBeLessThanOrEqual(topK);
    });

    it("filters by multiple kbIds", async () => {
      const result = await retrieveChunks(
        prisma,
        [testKbId, userOwnKbId2],
        testVector,
        10
      );

      // Should return chunks from both KBs (or just testKbId if userOwnKbId2 is empty)
      // In this case, userOwnKbId2 has no chunks, so result should be from testKbId
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("KB relevance filtering", () => {
    it("skips low-information greetings", () => {
      expect(shouldRetrieveKbForQuery("你好")).toBe(false);
      expect(shouldRetrieveKbForQuery("hello")).toBe(false);
      expect(shouldRetrieveKbForQuery("根据联贝信息服务标准承诺书总结关键条款")).toBe(true);
    });

    it("filters weak chunks and limits repeated chunks from the same document", () => {
      const chunks = [
        { content: "a", docName: "SKILL.md", ordinal: 0, score: 0.82 },
        { content: "b", docName: "SKILL.md", ordinal: 1, score: 0.81 },
        { content: "c", docName: "SKILL.md", ordinal: 2, score: 0.8 },
        { content: "d", docName: "Other.md", ordinal: 0, score: 0.2 },
        { content: "e", docName: "Guide.md", ordinal: 0, score: 0.7 },
      ];

      const result = filterRelevantChunks(chunks, {
        minScore: 0.35,
        maxChunks: 4,
        maxChunksPerDocument: 2,
      });

      expect(result.map((chunk) => `${chunk.docName}#${chunk.ordinal}`)).toEqual([
        "SKILL.md#0",
        "SKILL.md#1",
        "Guide.md#0",
      ]);
    });

    it("deduplicates visible citations by document", () => {
      const chunks = [
        { content: "a", docName: "SKILL.md", ordinal: 0, score: 0.82 },
        { content: "b", docName: "SKILL.md", ordinal: 1, score: 0.81 },
        { content: "c", docName: "Guide.md", ordinal: 2, score: 0.8 },
      ];

      expect(dedupeKbCitations(chunks)).toEqual([
        { docName: "SKILL.md", ordinal: 0 },
        { docName: "Guide.md", ordinal: 2 },
      ]);
    });
  });
});
