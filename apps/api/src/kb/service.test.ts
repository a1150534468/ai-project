import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import {
  createKb,
  listKbsForUser,
  renameKb,
  deleteKb,
  assertKbOwner,
  assertKbReadable,
  ForbiddenError,
} from "./service.js";

const prisma = getPrisma();

// Test data collectors for id-scoped cleanup
let createdUserIds: string[] = [];
let createdKbIds: string[] = [];
let createdDocIds: string[] = [];

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
