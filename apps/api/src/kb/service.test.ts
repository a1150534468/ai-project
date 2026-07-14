import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import type { KnowledgeBase, Document } from "@prisma/client";
import {
  createKb,
  listKbsForUser,
  renameKb,
  deleteKb,
  assertKbOwner,
  assertKbReadable,
  usedBytes,
  effectiveQuota,
  assertQuota,
  ForbiddenError,
  QuotaExceededError,
} from "./service.js";

const prisma = getPrisma();

// Test data collectors for id-scoped cleanup
let createdUserIds: string[] = [];
let createdKbIds: string[] = [];
let createdDocIds: string[] = [];
let createdGrantIds: string[] = [];

beforeAll(async () => {
  // Create test user
  const testUser = await prisma.user.create({
    data: {
      uid: `test-${Date.now()}`,
      username: `testuser${Date.now()}`,
      passwordHash: "dummy",
    },
  });
  createdUserIds.push(testUser.id);

  // Create an OFFICIAL knowledge base
  const officialKb = await prisma.knowledgeBase.create({
    data: {
      ownerType: "OFFICIAL",
      name: "Official KB",
      description: "Official knowledge base for testing",
    },
  });
  createdKbIds.push(officialKb.id);
});

afterAll(async () => {
  // Clean up in reverse order of dependencies
  // Chunks must be deleted before Documents
  if (createdDocIds.length > 0) {
    await prisma.chunk.deleteMany({
      where: { documentId: { in: createdDocIds } },
    });
  }

  // Documents must be deleted before KnowledgeBases
  if (createdDocIds.length > 0) {
    await prisma.document.deleteMany({
      where: { id: { in: createdDocIds } },
    });
  }

  // KbQuotaGrants before Users
  if (createdGrantIds.length > 0) {
    await prisma.kbQuotaGrant.deleteMany({
      where: { id: { in: createdGrantIds } },
    });
  }

  // KnowledgeBases before Users
  if (createdKbIds.length > 0) {
    await prisma.knowledgeBase.deleteMany({
      where: { id: { in: createdKbIds } },
    });
  }

  // Users last
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  }
});

describe("KB Service", () => {
  let testUserId: string;
  let officialKbId: string;

  beforeAll(async () => {
    const users = await prisma.user.findMany();
    testUserId = users[0]!.id;

    const kbs = await prisma.knowledgeBase.findMany({
      where: { ownerType: "OFFICIAL" },
    });
    officialKbId = kbs[0]!.id;
  });

  describe("createKb + listKbsForUser", () => {
    it("创建用户的 KB，listKbsForUser 包含我的 + 官方库", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "My KB",
        description: "Test knowledge base",
      });
      createdKbIds.push(kb.id);

      expect(kb.ownerType).toBe("USER");
      expect(kb.userId).toBe(testUserId);
      expect(kb.name).toBe("My KB");
      expect(kb.description).toBe("Test knowledge base");

      const kbs = await listKbsForUser(prisma, testUserId);
      const myKbs = kbs.filter((k) => k.ownerType === "USER");
      const officialKbs = kbs.filter((k) => k.ownerType === "OFFICIAL");

      expect(myKbs.length).toBeGreaterThan(0);
      expect(myKbs.some((k) => k.id === kb.id)).toBe(true);
      expect(myKbs.every((k) => k.userId === testUserId)).toBe(true);

      expect(officialKbs.length).toBeGreaterThan(0);
      expect(officialKbs.every((k) => k.ownerType === "OFFICIAL")).toBe(true);
    });

    it("listKbsForUser 返回每个库已建立的知识晶格数量", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "Lattice KB",
      });
      createdKbIds.push(kb.id);

      const doc1 = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "a.md",
          sourceType: "TEXT",
          status: "indexed",
          chunkCount: 3,
        },
      });
      const doc2 = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "b.md",
          sourceType: "TEXT",
          status: "indexed",
          chunkCount: 5,
        },
      });
      createdDocIds.push(doc1.id, doc2.id);

      const kbs = await listKbsForUser(prisma, testUserId);
      const found = kbs.find((k) => k.id === kb.id);

      expect(found?.latticeCount).toBe(8);
    });
  });

  describe("renameKb", () => {
    it("重命名用户的 KB", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "Original Name",
      });
      createdKbIds.push(kb.id);

      const updated = await renameKb(prisma, kb.id, testUserId, {
        name: "New Name",
        description: "New description",
      });

      expect(updated.name).toBe("New Name");
      expect(updated.description).toBe("New description");
    });

    it("非所有人无法重命名", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "Owner Only",
      });
      createdKbIds.push(kb.id);

      // Create another user
      const otherUser = await prisma.user.create({
        data: {
          uid: `other-${Date.now()}`,
          username: `other${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(otherUser.id);

      await expect(
        renameKb(prisma, kb.id, otherUser.id, { name: "Hacked" })
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("assertKbOwner", () => {
    it("所有人可以获取自己的 KB", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "My KB",
      });
      createdKbIds.push(kb.id);

      const fetched = await assertKbOwner(prisma, kb.id, testUserId);
      expect(fetched.id).toBe(kb.id);
      expect(fetched.userId).toBe(testUserId);
    });

    it("其他用户无法访问", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "Owner Only",
      });
      createdKbIds.push(kb.id);

      const otherUser = await prisma.user.create({
        data: {
          uid: `other2-${Date.now()}`,
          username: `other2${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(otherUser.id);

      await expect(
        assertKbOwner(prisma, kb.id, otherUser.id)
      ).rejects.toThrow(ForbiddenError);
    });

    it("不存在的 KB 抛 ForbiddenError", async () => {
      await expect(
        assertKbOwner(prisma, "nonexistent-id", testUserId)
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("assertKbReadable", () => {
    it("用户可以读自己的 KB", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "Readable",
      });
      createdKbIds.push(kb.id);

      const fetched = await assertKbReadable(prisma, kb.id, testUserId);
      expect(fetched.id).toBe(kb.id);
    });

    it("所有人可以读官方库", async () => {
      const otherUser = await prisma.user.create({
        data: {
          uid: `other3-${Date.now()}`,
          username: `other3${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(otherUser.id);

      const fetched = await assertKbReadable(
        prisma,
        officialKbId,
        otherUser.id
      );
      expect(fetched.ownerType).toBe("OFFICIAL");
    });

    it("无法读他人的 USER 库", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "Private",
      });
      createdKbIds.push(kb.id);

      const otherUser = await prisma.user.create({
        data: {
          uid: `other4-${Date.now()}`,
          username: `other4${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(otherUser.id);

      await expect(
        assertKbReadable(prisma, kb.id, otherUser.id)
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("usedBytes", () => {
    it("计算用户已使用的字节数（排除 failed）", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `user-usedBytes-${Date.now()}`,
          username: `usedBytes-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const kb = await createKb(prisma, {
        userId: user.id,
        name: "Byte Counter",
      });
      createdKbIds.push(kb.id);

      // Create documents with different statuses
      const doc1 = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "Doc1",
          sourceType: "FILE",
          sizeBytes: 1000,
          status: "indexed",
        },
      });
      createdDocIds.push(doc1.id);

      const doc2 = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "Doc2",
          sourceType: "FILE",
          sizeBytes: 2000,
          status: "pending",
        },
      });
      createdDocIds.push(doc2.id);

      const doc3 = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "Doc3",
          sourceType: "FILE",
          sizeBytes: 3000,
          status: "failed",
        },
      });
      createdDocIds.push(doc3.id);

      const used = await usedBytes(prisma, user.id);
      // Only doc1 (1000) + doc2 (2000) = 3000, not doc3
      expect(used).toBe(3000);
    });

    it("其他用户的文档不计入", async () => {
      const user1 = await prisma.user.create({
        data: {
          uid: `user-sep-${Date.now()}-1`,
          username: `sep-${Date.now()}-1`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user1.id);

      const user2 = await prisma.user.create({
        data: {
          uid: `user-sep-${Date.now()}-2`,
          username: `sep-${Date.now()}-2`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user2.id);

      const kb1 = await createKb(prisma, {
        userId: user1.id,
        name: "KB1",
      });
      createdKbIds.push(kb1.id);

      const kb2 = await createKb(prisma, {
        userId: user2.id,
        name: "KB2",
      });
      createdKbIds.push(kb2.id);

      const doc1 = await prisma.document.create({
        data: {
          kbId: kb1.id,
          name: "Doc1",
          sourceType: "FILE",
          sizeBytes: 1000,
          status: "indexed",
        },
      });
      createdDocIds.push(doc1.id);

      const doc2 = await prisma.document.create({
        data: {
          kbId: kb2.id,
          name: "Doc2",
          sourceType: "FILE",
          sizeBytes: 2000,
          status: "indexed",
        },
      });
      createdDocIds.push(doc2.id);

      const used1 = await usedBytes(prisma, user1.id);
      const used2 = await usedBytes(prisma, user2.id);

      expect(used1).toBe(1000);
      expect(used2).toBe(2000);
    });
  });

  describe("effectiveQuota", () => {
    it("计算有效配额：default + membership + grants", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `user-quota-grants-${Date.now()}`,
          username: `quota-grants-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const mockBilling = {
        async getUserKbQuota(userId: string) {
          return { defaultBytes: 100 * 1024 * 1024, membershipBytes: 10 * 1024 * 1024 };
        },
      };

      // Create grants
      const grant1 = await prisma.kbQuotaGrant.create({
        data: {
          userId: user.id,
          bytes: 5 * 1024 * 1024,
          source: "PURCHASE",
          expiresAt: null,
        },
      });
      createdGrantIds.push(grant1.id);

      // Expired grant (should not count)
      const grant2 = await prisma.kbQuotaGrant.create({
        data: {
          userId: user.id,
          bytes: 20 * 1024 * 1024,
          source: "ADMIN",
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      createdGrantIds.push(grant2.id);

      const quota = await effectiveQuota(
        prisma,
        mockBilling,
        user.id
      );

      // 100MB + 10MB + 5MB = 115MB
      expect(quota).toBe(115 * 1024 * 1024);
    });

    it("有效配额包含未来过期的 grant", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `user-quota-future-${Date.now()}`,
          username: `quota-future-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      const mockBilling = {
        async getUserKbQuota(userId: string) {
          return { defaultBytes: 50 * 1024 * 1024, membershipBytes: 0 };
        },
      };

      const grant = await prisma.kbQuotaGrant.create({
        data: {
          userId: user.id,
          bytes: 10 * 1024 * 1024,
          source: "PURCHASE",
          expiresAt: futureDate,
        },
      });
      createdGrantIds.push(grant.id);

      const quota = await effectiveQuota(
        prisma,
        mockBilling,
        user.id
      );

      // 50MB + 10MB = 60MB
      expect(quota).toBe(60 * 1024 * 1024);
    });
  });

  describe("assertQuota", () => {
    it("超过配额时抛 QuotaExceededError", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `user-quota-exceed-${Date.now()}`,
          username: `quota-exceed-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const kb = await createKb(prisma, {
        userId: user.id,
        name: "Quota Test",
      });
      createdKbIds.push(kb.id);

      const mockBilling = {
        async getUserKbQuota(userId: string) {
          return { defaultBytes: 1000, membershipBytes: 0 }; // 1KB
        },
      };

      // Try to add 2KB when only 1KB available
      await expect(
        assertQuota(prisma, mockBilling, user.id, 2000)
      ).rejects.toThrow(QuotaExceededError);
    });

    it("不超过配额时 resolve", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `user-quota-ok-${Date.now()}`,
          username: `quota-ok-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const kb = await createKb(prisma, {
        userId: user.id,
        name: "Quota OK",
      });
      createdKbIds.push(kb.id);

      const mockBilling = {
        async getUserKbQuota(userId: string) {
          return { defaultBytes: 2000, membershipBytes: 0 }; // 2KB
        },
      };

      // Should not throw
      await expect(
        assertQuota(prisma, mockBilling, user.id, 1000)
      ).resolves.toBeUndefined();
    });

    it("考虑已使用字节数", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `user-quota-used-${Date.now()}`,
          username: `quota-used-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const kb = await createKb(prisma, {
        userId: user.id,
        name: "Used Quota",
      });
      createdKbIds.push(kb.id);

      // Create a document that uses 500 bytes
      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "Existing",
          sourceType: "FILE",
          sizeBytes: 500,
          status: "indexed",
        },
      });
      createdDocIds.push(doc.id);

      const mockBilling = {
        async getUserKbQuota(userId: string) {
          return { defaultBytes: 1000, membershipBytes: 0 }; // 1KB
        },
      };

      // used (500) + add (600) = 1100 > 1000 => should throw
      await expect(
        assertQuota(prisma, mockBilling, user.id, 600)
      ).rejects.toThrow(QuotaExceededError);

      // used (500) + add (400) = 900 <= 1000 => should not throw
      await expect(
        assertQuota(prisma, mockBilling, user.id, 400)
      ).resolves.toBeUndefined();
    });
  });

  describe("deleteKb", () => {
    it("删除 KB 及其所有 Document 和 Chunk", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "To Delete",
      });
      createdKbIds.push(kb.id);

      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "Doc",
          sourceType: "FILE",
          sizeBytes: 100,
          status: "indexed",
        },
      });
      createdDocIds.push(doc.id);

      // Mock S3
      const mockS3 = {
        client: {
          send: async () => ({ Contents: [] }),
        },
        bucket: "test",
      };

      await deleteKb(prisma, mockS3 as any, kb.id, testUserId);

      // Verify KB is deleted
      const kbExists = await prisma.knowledgeBase.findUnique({
        where: { id: kb.id },
      });
      expect(kbExists).toBeNull();

      // Documents should be deleted by cascade
      const docExists = await prisma.document.findUnique({
        where: { id: doc.id },
      });
      expect(docExists).toBeNull();

      // Remove from tracking since we deleted it manually
      createdKbIds = createdKbIds.filter((id) => id !== kb.id);
      createdDocIds = createdDocIds.filter((id) => id !== doc.id);
    });

    it("非所有人无法删除 KB", async () => {
      const kb = await createKb(prisma, {
        userId: testUserId,
        name: "Protected",
      });
      createdKbIds.push(kb.id);

      const otherUser = await prisma.user.create({
        data: {
          uid: `other6-${Date.now()}`,
          username: `other6${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(otherUser.id);

      const mockS3 = {
        deletePrefix: async (prefix: string) => {},
      };

      await expect(
        deleteKb(prisma, mockS3 as any, kb.id, otherUser.id)
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
