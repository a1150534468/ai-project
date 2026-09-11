import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import type { KnowledgeBase } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claim, EmptyTextError, indexOnce, type IndexDeps } from "./indexer.js";

const databaseReady = Boolean(process.env.DATABASE_URL);
const prisma = databaseReady ? getPrisma() : null;
const suite = describe.skipIf(!databaseReady);
const prefix = `indexer-${randomUUID()}`;
let userId = "";
let ownKb: KnowledgeBase;
let officialKb: KnowledgeBase;

const vector = (value = 0.1) => Array(1024).fill(value);

function fakeDeps(overrides: Partial<IndexDeps> = {}): IndexDeps {
  return {
    prisma: prisma!,
    loadObject: vi.fn().mockResolvedValue({ buf: Buffer.from("正文"), mime: "text/plain", filename: "a.txt" }),
    parse: vi.fn().mockResolvedValue("正文"),
    chunk: vi.fn().mockReturnValue(["第一块", "第二块"]),
    embed: vi.fn().mockResolvedValue({ vector: vector(), tokens: 2 }),
    workerId: `${prefix}-worker`,
    ...overrides,
  };
}

async function createDocument(kbId: string, data: Record<string, unknown> = {}) {
  return prisma!.document.create({
    data: {
      kbId,
      name: `${prefix}.txt`,
      sourceType: "TEXT",
      sourceUri: `${prefix}/source`,
      status: "pending",
      ...data,
    },
  });
}

suite("KB indexer", () => {
  beforeAll(async () => {
    const user = await prisma!.user.create({
      data: { uid: `${prefix}-uid`, username: `${prefix}-user`, passwordHash: "x" },
    });
    userId = user.id;
    ownKb = await prisma!.knowledgeBase.create({
      data: { ownerType: "USER", userId, name: `${prefix}-own` },
    });
    ownKb = await prisma!.knowledgeBase.findUniqueOrThrow({ where: { id: ownKb.id } });
    officialKb = await prisma!.knowledgeBase.create({
      data: { ownerType: "OFFICIAL", name: `${prefix}-official` },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: [ownKb?.id, officialKb?.id].filter(Boolean) } } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("pending 可抢占，fresh indexing 不可抢，过期租约可接管", async () => {
    const pending = await createDocument(ownKb.id);
    await expect(claim(prisma!, pending.id, "worker-a", 30_000)).resolves.toBe(true);
    await expect(claim(prisma!, pending.id, "worker-b", 30_000)).resolves.toBe(false);

    const expired = await createDocument(ownKb.id, {
      status: "indexing",
      lockedBy: "old",
      lockedAt: new Date(Date.now() - 60_000),
    });
    await expect(claim(prisma!, expired.id, "worker-b", 30_000)).resolves.toBe(true);
  });

  it.each([
    ["USER", () => ownKb.id],
    ["OFFICIAL", () => officialKb.id],
  ])("成功索引 %s 库，chunks 与终态一起发布", async (_owner, kbId) => {
    const doc = await createDocument(kbId());
    const deps = fakeDeps();
    await indexOnce(deps, doc.id);
    const saved = await prisma!.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved).toMatchObject({ status: "indexed", chunkCount: 2, lockedBy: null, error: null });
    expect(saved.tokensUsed).toBeGreaterThan(0);
    const chunks = await prisma!.chunk.findMany({ where: { documentId: doc.id }, orderBy: { ordinal: "asc" } });
    expect(chunks.map(({ ordinal, content }) => ({ ordinal, content }))).toEqual([
      { ordinal: 0, content: "第一块" },
      { ordinal: 1, content: "第二块" },
    ]);
  });

  it("瞬时失败回 pending，重试成功；耗尽后 failed", async () => {
    const doc = await createDocument(ownKb.id);
    const embed = vi.fn()
      .mockRejectedValueOnce(new Error("embeddings 503: unavailable"))
      .mockResolvedValue({ vector: vector(), tokens: 4 });
    const deps = fakeDeps({ chunk: vi.fn().mockReturnValue(["正文"]), embed });
    await indexOnce(deps, doc.id, { maxAttempts: 2 });
    expect(await prisma!.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .toMatchObject({ status: "pending", attempts: 1 });
    await indexOnce(deps, doc.id, { maxAttempts: 2 });
    expect(await prisma!.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .toMatchObject({ status: "indexed", attempts: 2 });

    const exhausted = await createDocument(ownKb.id, { attempts: 1 });
    await indexOnce(fakeDeps({ embed: vi.fn().mockRejectedValue(new Error("embeddings 503: unavailable")) }), exhausted.id, {
      maxAttempts: 2,
    });
    expect(await prisma!.document.findUniqueOrThrow({ where: { id: exhausted.id } }))
      .toMatchObject({ status: "failed", attempts: 2 });
  });

  it("embedding 400 与 EmptyTextError 是永久失败", async () => {
    for (const failure of [new Error("embeddings 400: bad request"), new EmptyTextError("空文本")]) {
      const doc = await createDocument(ownKb.id);
      const deps = failure instanceof EmptyTextError
        ? fakeDeps({ parse: vi.fn().mockRejectedValue(failure) })
        : fakeDeps({ embed: vi.fn().mockRejectedValue(failure) });
      await indexOnce(deps, doc.id, { maxAttempts: 3 });
      expect(await prisma!.document.findUniqueOrThrow({ where: { id: doc.id } }))
        .toMatchObject({ status: "failed", attempts: 1, lockedBy: null });
    }
  });

  it("并发两次只有一个 attempt 会调用 embedding", async () => {
    const doc = await createDocument(ownKb.id);
    const embed = vi.fn(async () => ({ vector: vector(), tokens: 1 }));
    const deps = fakeDeps({ chunk: vi.fn().mockReturnValue(["正文"]), embed });
    await Promise.all([indexOnce(deps, doc.id), indexOnce(deps, doc.id)]);
    expect(embed).toHaveBeenCalledOnce();
  });

  it("错维或非有限向量在发布前变成永久失败，不留下 chunk", async () => {
    for (const invalid of [[1, 2], Array(1024).fill(Number.NaN)]) {
      const doc = await createDocument(ownKb.id);
      await indexOnce(fakeDeps({
        chunk: vi.fn().mockReturnValue(["正文"]),
        embed: vi.fn().mockResolvedValue({ vector: invalid, tokens: 1 }),
      }), doc.id);
      expect(await prisma!.document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ status: "failed" });
      expect(await prisma!.chunk.count({ where: { documentId: doc.id } })).toBe(0);
    }
  });
});

describe("KB indexer lease heartbeat", () => {
  it("检测到租约丢失后停止后续 embedding 并清理心跳", async () => {
    vi.useFakeTimers();
    vi.stubEnv("KB_EMBED_CONCURRENCY", "1");
    try {
      let releaseFirst!: (value: { vector: number[]; tokens: number }) => void;
      const firstEmbedding = new Promise<{ vector: number[]; tokens: number }>((resolve) => {
        releaseFirst = resolve;
      });
      const embed = vi.fn()
        .mockImplementationOnce(() => firstEmbedding)
        .mockResolvedValue({ vector: vector(), tokens: 1 });
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const mockPrisma = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        document: {
          findUnique: vi.fn().mockResolvedValue({
            id: "lost-lease",
            kbId: "kb",
            sourceType: "TEXT",
            sourceUri: "source",
          }),
          updateMany,
        },
      } as unknown as IndexDeps["prisma"];
      const work = indexOnce(fakeDeps({
        prisma: mockPrisma,
        chunk: vi.fn().mockReturnValue(["first", "second"]),
        embed,
      }), "lost-lease", { leaseMs: 30 });

      await vi.advanceTimersByTimeAsync(0);
      expect(embed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      expect(updateMany).toHaveBeenCalledOnce();
      releaseFirst({ vector: vector(), tokens: 1 });
      await work;

      expect(embed).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});
