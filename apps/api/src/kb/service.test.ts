import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import type { KnowledgeBase, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ deletePrefix: vi.fn() }));
vi.mock("../storage/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/s3.js")>()),
  deletePrefix: storage.deletePrefix,
}));

import {
  assertKbOwner,
  assertKbReadable,
  createKb,
  deleteKb,
  deleteKbDocument,
  ForbiddenError,
  listKbsForUser,
  renameKb,
} from "./service.js";

const databaseReady = Boolean(process.env.DATABASE_URL);
const prisma = databaseReady ? getPrisma() : null;
const suite = describe.skipIf(!databaseReady);
const prefix = `kb-service-${randomUUID()}`;
const kbIds = new Set<string>();
let ownerId = "";
let otherId = "";
let official: KnowledgeBase;

async function kb(data: { ownerType?: string; userId?: string | null; name?: string } = {}) {
  const row = await prisma!.knowledgeBase.create({
    data: {
      ownerType: data.ownerType ?? "USER",
      userId: data.userId === undefined ? ownerId : data.userId,
      name: data.name ?? `${prefix}-${randomUUID()}`,
    },
  });
  kbIds.add(row.id);
  return row;
}

async function document(kbId: string, chunkCount = 0, sourceType = "TEXT") {
  return prisma!.document.create({
    data: {
      kbId,
      name: `${prefix}.txt`,
      sourceType,
      sourceUri: sourceType === "URL" ? "https://example.test/doc" : `kb/${kbId}/source`,
      status: "indexed",
      chunkCount,
    },
  });
}

async function chunk(documentId: string, kbId: string) {
  const vector = `[${Array(1024).fill(0.01).join(",")}]`;
  await prisma!.$executeRawUnsafe(
    `INSERT INTO "Chunk" (id, "documentId", "kbId", ordinal, content, embedding, "createdAt")
     VALUES ($1, $2, $3, 0, 'fixture', $4::vector, now())`,
    randomUUID(),
    documentId,
    kbId,
    vector,
  );
}

beforeEach(() => storage.deletePrefix.mockReset().mockResolvedValue(undefined));

suite("KB service", () => {
  beforeAll(async () => {
    const [owner, other] = await Promise.all([
      prisma!.user.create({ data: { uid: `${prefix}-owner`, username: `${prefix}-owner`, passwordHash: "x" } }),
      prisma!.user.create({ data: { uid: `${prefix}-other`, username: `${prefix}-other`, passwordHash: "x" } }),
    ]);
    ownerId = owner.id;
    otherId = other.id;
    official = await kb({ ownerType: "OFFICIAL", userId: null });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: [...kbIds] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId].filter(Boolean) } } });
  });

  it("createKb 默认建 USER 库，OFFICIAL 强制清空 userId", async () => {
    const mine = await createKb(prisma!, { userId: ownerId, name: `${prefix}-mine` });
    const publicKb = await createKb(prisma!, {
      userId: ownerId,
      ownerType: "OFFICIAL",
      name: `${prefix}-public`,
      description: "official",
    });
    kbIds.add(mine.id);
    kbIds.add(publicKb.id);
    expect(mine).toMatchObject({ ownerType: "USER", userId: ownerId });
    expect(publicKb).toMatchObject({ ownerType: "OFFICIAL", userId: null, description: "official" });
  });

  it("list 只含自己的 USER 与全部 OFFICIAL，并汇总每库 chunkCount", async () => {
    const mine = await kb();
    const foreign = await kb({ userId: otherId });
    const malformed = await kb({ ownerType: "LEGACY" });
    await document(mine.id, 3);
    await document(mine.id, 5);
    const rows = await listKbsForUser(prisma!, ownerId);
    expect(rows.find(({ id }) => id === mine.id)?.latticeCount).toBe(8);
    expect(rows.some(({ id }) => id === official.id)).toBe(true);
    expect(rows.some(({ id }) => id === foreign.id || id === malformed.id)).toBe(false);
  });

  it("空可见集合不查询 Document 聚合", async () => {
    const groupBy = vi.fn();
    const fake = {
      knowledgeBase: { findMany: vi.fn().mockResolvedValue([]) },
      document: { groupBy },
    } as unknown as PrismaClient;
    await expect(listKbsForUser(fake, "nobody")).resolves.toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("assertKbOwner 严格拒绝 OFFICIAL、他人库和不存在库", async () => {
    const mine = await kb();
    await expect(assertKbOwner(prisma!, mine.id, ownerId)).resolves.toMatchObject({ id: mine.id });
    for (const id of [official.id, mine.id, randomUUID()]) {
      const caller = id === mine.id ? otherId : ownerId;
      await expect(assertKbOwner(prisma!, id, caller)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("assertKbReadable 只放行自有 USER 与 OFFICIAL", async () => {
    const mine = await kb();
    const foreign = await kb({ userId: otherId });
    await expect(assertKbReadable(prisma!, mine.id, ownerId)).resolves.toMatchObject({ id: mine.id });
    await expect(assertKbReadable(prisma!, official.id, ownerId)).resolves.toMatchObject({ id: official.id });
    await expect(assertKbReadable(prisma!, foreign.id, ownerId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("renameKb 用单个严格 updateMany 判定所有权，再在同一事务返回结果", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ id: "kb", name: "new" });
    const fake = {
      $transaction: (run: (tx: unknown) => unknown) => run({ knowledgeBase: { updateMany, findUniqueOrThrow } }),
    } as unknown as PrismaClient;
    await expect(renameKb(fake, "kb", "owner", { name: "new" })).resolves.toMatchObject({ name: "new" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "kb", ownerType: "USER", userId: "owner" },
      data: { name: "new" },
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(renameKb(fake, "kb", "other", { name: "bad" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("deleteKb 先按 USER 属主级联删库，再尽力清理 S3", async () => {
    const target = await kb();
    const doc = await document(target.id);
    await chunk(doc.id, target.id);
    storage.deletePrefix.mockImplementationOnce(async () => {
      expect(await prisma!.knowledgeBase.findUnique({ where: { id: target.id } })).toBeNull();
    });
    await deleteKb(prisma!, {} as never, target.id, ownerId);
    expect(await prisma!.document.findUnique({ where: { id: doc.id } })).toBeNull();
    expect(await prisma!.chunk.count({ where: { documentId: doc.id } })).toBe(0);
    expect(storage.deletePrefix).toHaveBeenCalledWith(expect.anything(), `kb/${target.id}/`);
  });

  it("deleteKb 的 null 只删 OFFICIAL，非属主与类型错位都拒绝", async () => {
    const publicKb = await kb({ ownerType: "OFFICIAL", userId: null });
    const mine = await kb();
    await expect(deleteKb(prisma!, {} as never, mine.id, otherId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteKb(prisma!, {} as never, publicKb.id, ownerId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteKb(prisma!, {} as never, mine.id, null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteKb(prisma!, {} as never, publicKb.id, null)).resolves.toBeUndefined();
  });

  it("deleteKb 的 S3 清理失败不把已提交删除伪装成失败", async () => {
    const target = await kb();
    storage.deletePrefix.mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(deleteKb(prisma!, {} as never, target.id, ownerId)).resolves.toBeUndefined();
    await expect(prisma!.knowledgeBase.findUnique({ where: { id: target.id } })).resolves.toBeNull();
  });

  it("deleteKbDocument 在事务中校验属主并依赖 FK 级联 Chunk", async () => {
    const target = await kb();
    const doc = await document(target.id);
    await chunk(doc.id, target.id);
    await expect(deleteKbDocument(prisma!, target.id, doc.id, otherId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteKbDocument(prisma!, target.id, randomUUID(), ownerId)).resolves.toBeNull();
    await expect(deleteKbDocument(prisma!, target.id, doc.id, ownerId)).resolves.toEqual({
      sourceType: "TEXT",
      sourceUri: `kb/${target.id}/source`,
    });
    expect(await prisma!.chunk.count({ where: { documentId: doc.id } })).toBe(0);
  });
});
