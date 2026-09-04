import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getPrisma } from '@ai-assistant/db';
import type { User, KnowledgeBase } from '@prisma/client';
import { claim, indexOnce, EmptyTextError, type IndexDeps } from './indexer.js';

const prisma = getPrisma();

// Test data collectors for id-scoped cleanup
let createdUserIds: string[] = [];
let createdKbIds: string[] = [];
let createdDocIds: string[] = [];
let createdChunkIds: string[] = [];

let testUser: User;
let userKb: KnowledgeBase;
let officialKb: KnowledgeBase;

beforeAll(async () => {
  // Create test user
  testUser = await prisma.user.create({
    data: {
      uid: `test-${Date.now()}`,
      username: `testuser${Date.now()}`,
      passwordHash: 'dummy',
    },
  });
  createdUserIds.push(testUser.id);

  // Create USER knowledge base
  userKb = await prisma.knowledgeBase.create({
    data: {
      ownerType: 'USER',
      userId: testUser.id,
      name: 'Test KB',
      description: 'Test knowledge base',
    },
  });
  createdKbIds.push(userKb.id);

  // Create OFFICIAL knowledge base
  officialKb = await prisma.knowledgeBase.create({
    data: {
      ownerType: 'OFFICIAL',
      name: 'Official KB',
      description: 'Official knowledge base',
    },
  });
  createdKbIds.push(officialKb.id);
});

afterAll(async () => {
  // Clean up in reverse order of dependencies
  if (createdChunkIds.length > 0) {
    await prisma.chunk.deleteMany({
      where: { id: { in: createdChunkIds } },
    });
  }

  if (createdDocIds.length > 0) {
    await prisma.document.deleteMany({
      where: { id: { in: createdDocIds } },
    });
  }

  if (createdKbIds.length > 0) {
    await prisma.knowledgeBase.deleteMany({
      where: { id: { in: createdKbIds } },
    });
  }

  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  }
});

describe('claim', () => {
  it('成功抢占 pending 文档', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'test.txt',
        sourceType: 'TEXT',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const success = await claim(prisma, doc.id, 'worker-1', 30000);
    expect(success).toBe(true);

    const updated = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(updated?.status).toBe('indexing');
    expect(updated?.lockedBy).toBe('worker-1');
    expect(updated?.lockedAt).toBeDefined();
    expect(updated?.attempts).toBe(1);
  });

  it('防重复抢占：已被他人锁定', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'test2.txt',
        sourceType: 'TEXT',
        status: 'indexing',
        lockedBy: 'worker-1',
        lockedAt: new Date(),
      },
    });
    createdDocIds.push(doc.id);

    const success = await claim(prisma, doc.id, 'worker-2', 30000);
    expect(success).toBe(false);

    const unchanged = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(unchanged?.lockedBy).toBe('worker-1');
    expect(unchanged?.attempts).toBe(0); // 未改变
  });

  it('超时的锁可以被抢占', async () => {
    const pastTime = new Date(Date.now() - 40000); // 40s 前
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'test3.txt',
        sourceType: 'TEXT',
        status: 'indexing',
        lockedBy: 'worker-1',
        lockedAt: pastTime,
      },
    });
    createdDocIds.push(doc.id);

    const success = await claim(prisma, doc.id, 'worker-2', 30000);
    expect(success).toBe(true);

    const updated = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(updated?.lockedBy).toBe('worker-2');
    expect(updated?.attempts).toBe(1);
  });
});

describe('indexOnce', () => {
  it('成功索引文档：USER 库', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'test.txt',
        sourceType: 'TEXT',
        sourceUri: 'memory://test',
        mime: 'text/plain',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const mockText = '这是一份测试文档。包含一些示例文本。' + 'x'.repeat(1000);
    const mockChunks = [mockText.slice(0, 100), mockText.slice(100, 200)];
    const expectedTokens = mockChunks.reduce(
      (sum, chunk) => sum + Math.max(5, Math.ceil(Buffer.byteLength(chunk || ' ', 'utf8') / 3)),
      0,
    );

    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.from(mockText),
        mime: 'text/plain',
        filename: 'test.txt',
      }),
      parse: vi.fn().mockResolvedValue(mockText),
      chunk: vi.fn().mockReturnValue(mockChunks),
      embed: vi.fn().mockResolvedValue({
        vector: new Array(1024).fill(0.1),
        tokens: 5,
      }),
      workerId: 'worker-1',
    };

    await indexOnce(deps, doc.id);

    const updated = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(updated?.status).toBe('indexed');
    expect(updated?.chunkCount).toBe(2);
    expect(updated?.tokensUsed).toBe(expectedTokens);
    expect(updated?.lockedBy).toBeNull();
    expect(updated?.error).toBeNull();

    // 验证 chunks 被写入（Prisma 无法读 vector 类型，用 raw SQL）
    const chunks = await prisma.chunk.findMany({ where: { documentId: doc.id } });
    createdChunkIds.push(...chunks.map((c) => c.id));
    expect(chunks.length).toBe(2);
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[1].ordinal).toBe(1);

    // 验证向量确实被写入（用 raw SQL 查询）
    const rawChunks = (await prisma.$queryRaw<
      Array<{ id: string; ordinal: number; embedding: string }>
    >`SELECT id, ordinal, embedding::text FROM "Chunk" WHERE "documentId" = ${doc.id} ORDER BY ordinal ASC`) as any[];
    expect(rawChunks.length).toBe(2);
    expect(rawChunks[0].embedding).toBeDefined();
    expect(rawChunks[0].embedding).toContain('0.1'); // 向量内容应该有 0.1
  });

  it('瞬时失败在次数耗尽前回到 pending，重试成功后置 indexed', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'transient-then-success.txt',
        sourceType: 'TEXT',
        sourceUri: 'memory://transient-then-success',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const text = '第一次嵌入超时，第二次成功';
    let embedAttempts = 0;
    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.from(text),
        mime: 'text/plain',
        filename: doc.name,
      }),
      parse: vi.fn().mockResolvedValue(text),
      chunk: vi.fn().mockReturnValue([text]),
      embed: vi.fn(async () => {
        embedAttempts++;
        if (embedAttempts === 1) throw new Error('Embedding upstream timeout');
        return { vector: new Array(1024).fill(0.4), tokens: 12 };
      }),
      workerId: 'worker-transient-then-success',
    };

    await indexOnce(deps, doc.id, { maxAttempts: 3 });

    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .toMatchObject({ status: 'pending', attempts: 1, error: 'Embedding upstream timeout' });

    await indexOnce(deps, doc.id, { maxAttempts: 3 });

    const indexed = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(indexed).toMatchObject({ status: 'indexed', attempts: 2, chunkCount: 1, error: null });
    const chunks = await prisma.chunk.findMany({ where: { documentId: doc.id } });
    createdChunkIds.push(...chunks.map((chunk) => chunk.id));
  });

  it('瞬时失败达到最大尝试次数后进入 failed', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'transient-exhausted.txt',
        sourceType: 'TEXT',
        sourceUri: 'memory://transient-exhausted',
        status: 'pending',
        attempts: 1,
      },
    });
    createdDocIds.push(doc.id);

    const text = '嵌入服务持续不可用';
    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.from(text),
        mime: 'text/plain',
        filename: doc.name,
      }),
      parse: vi.fn().mockResolvedValue(text),
      chunk: vi.fn().mockReturnValue([text]),
      embed: vi.fn().mockRejectedValue(new Error('Embedding service unavailable')),
      workerId: 'worker-transient-exhausted',
    };

    await indexOnce(deps, doc.id, { maxAttempts: 2 });

    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .toMatchObject({ status: 'failed', attempts: 2, error: 'Embedding service unavailable' });
  });

  it('claim 失败时直接返回（防重复索引）', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'test-claim-fail.txt',
        sourceType: 'TEXT',
        status: 'indexing',
        lockedBy: 'other-worker',
        lockedAt: new Date(),
      },
    });
    createdDocIds.push(doc.id);

    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn(),
      parse: vi.fn(),
      chunk: vi.fn(),
      embed: vi.fn(),
      workerId: 'worker-2',
    };

    await indexOnce(deps, doc.id);

    // 没有被修改
    const unchanged = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(unchanged?.status).toBe('indexing');
    expect(unchanged?.lockedBy).toBe('other-worker');

    expect(deps.parse).not.toHaveBeenCalled();
  });

  it('解析失败（EmptyTextError）：status=failed', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'empty.txt',
        sourceType: 'TEXT',
        sourceUri: 'memory://empty',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.alloc(0),
        mime: 'text/plain',
        filename: 'empty.txt',
      }),
      parse: vi.fn().mockRejectedValue(new EmptyTextError('文本为空或仅空白')),
      chunk: vi.fn(),
      embed: vi.fn(),
      workerId: 'worker-1',
    };

    await indexOnce(deps, doc.id, { maxAttempts: 3 });

    const failed = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('文本为空');
    expect(failed?.lockedBy).toBeNull();
    expect(failed?.attempts).toBe(1); // 永久失败不进入重试循环
  });

  it('OFFICIAL 库成功索引', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: officialKb.id,
        name: 'official.txt',
        sourceType: 'TEXT',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const mockText = '官方库文本';

    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.from(mockText),
        mime: 'text/plain',
        filename: 'official.txt',
      }),
      parse: vi.fn().mockResolvedValue(mockText),
      chunk: vi.fn().mockReturnValue([mockText]),
      embed: vi.fn().mockResolvedValue({
        vector: new Array(1024).fill(0.2),
        tokens: 3,
      }),
      workerId: 'worker-1',
    };

    await indexOnce(deps, doc.id);

    const updated = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(updated?.status).toBe('indexed');
    expect(updated?.chunkCount).toBe(1);
  });

  it('并发两次 indexOnce 同一 docId，only one embed', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'concurrent.txt',
        sourceType: 'TEXT',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const mockText = '并发测试';
    let embedCalls = 0;

    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.from(mockText),
        mime: 'text/plain',
        filename: 'concurrent.txt',
      }),
      parse: vi.fn().mockResolvedValue(mockText),
      chunk: vi.fn().mockReturnValue([mockText]),
      embed: vi.fn(async () => {
        embedCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return {
          vector: new Array(1024).fill(0.3),
          tokens: 2,
        };
      }),
      workerId: 'worker-1',
    };

    // 并发调用两次
    const [r1, r2] = await Promise.all([
      indexOnce(deps, doc.id),
      indexOnce(deps, doc.id),
    ]);

    // 两个调用都应该完成（不抛错）
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    // 但只有一个会成功 claim，所以只有一次 embed
    expect(embedCalls).toBe(1);

    const final = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(final?.status).toBe('indexed');
    expect(final?.chunkCount).toBe(1);
  });

  it('embed 瞬时出错：status=pending，等待 reaper 重试', async () => {
    const doc = await prisma.document.create({
      data: {
        kbId: userKb.id,
        name: 'embed-fail.txt',
        sourceType: 'TEXT',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const mockText = '嵌入失败测试';

    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.from(mockText),
        mime: 'text/plain',
        filename: 'embed-fail.txt',
      }),
      parse: vi.fn().mockResolvedValue(mockText),
      chunk: vi.fn().mockReturnValue([mockText]),
      embed: vi.fn().mockRejectedValue(new Error('Embedding API error')),
      workerId: 'worker-1',
    };

    await indexOnce(deps, doc.id);

    const pending = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(pending?.status).toBe('pending');
    expect(pending?.attempts).toBe(1);
    expect(pending?.error).toContain('Embedding API error');
  });
});
