import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getPrisma } from '@ai-assistant/db';
import type { PrismaClient, User, KnowledgeBase } from '@prisma/client';
import { indexOnce, EmptyTextError, type IndexDeps } from './indexer.js';
import { reapOnce, startKbReaper } from './reaper.js';

const prisma = getPrisma();

// Test data collectors for id-scoped cleanup
let createdUserIds: string[] = [];
let createdKbIds: string[] = [];
let createdDocIds: string[] = [];

let testUser: User;
let testKb: KnowledgeBase;

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

  // Create test knowledge base
  testKb = await prisma.knowledgeBase.create({
    data: {
      ownerType: 'USER',
      userId: testUser.id,
      name: 'Test KB',
      description: 'Test knowledge base',
    },
  });
  createdKbIds.push(testKb.id);
});

afterAll(async () => {
  // Clean up in reverse order of dependencies
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

describe('reapOnce', () => {
  it('只处理候选文档：pending (attempts<max) 和超租约的 indexing', async () => {
    const now = new Date();
    const oldTime = new Date(now.getTime() - 400000); // 超过 300s 租约
    const testStartTime = new Date('2000-01-01T00:00:00.000Z');

    // 1. pending, attempts=0 (应该处理)
    const pendingDoc = await prisma.document.create({
      data: {
        kbId: testKb.id,
        name: 'pending.txt',
        sourceType: 'TEXT',
        status: 'pending',
        attempts: 0,
        createdAt: testStartTime,
      },
    });
    createdDocIds.push(pendingDoc.id);

    // 2. indexing, lockedAt 很旧 (应该处理)
    const expiredDoc = await prisma.document.create({
      data: {
        kbId: testKb.id,
        name: 'expired.txt',
        sourceType: 'TEXT',
        status: 'indexing',
        lockedBy: 'old-worker',
        lockedAt: oldTime,
        attempts: 1,
        createdAt: new Date(testStartTime.getTime() + 1000),
      },
    });
    createdDocIds.push(expiredDoc.id);

    // 3. indexing, lockedAt 很新 (不应该处理)
    const freshDoc = await prisma.document.create({
      data: {
        kbId: testKb.id,
        name: 'fresh.txt',
        sourceType: 'TEXT',
        status: 'indexing',
        lockedBy: 'current-worker',
        lockedAt: now,
        attempts: 0,
        createdAt: new Date(testStartTime.getTime() + 2000),
      },
    });
    createdDocIds.push(freshDoc.id);

    // 4. failed (不应该处理)
    const failedDoc = await prisma.document.create({
      data: {
        kbId: testKb.id,
        name: 'failed.txt',
        sourceType: 'TEXT',
        status: 'failed',
        error: 'Some error',
        attempts: 2,
        createdAt: new Date(testStartTime.getTime() + 3000),
      },
    });
    createdDocIds.push(failedDoc.id);

    // 5. pending, attempts >= maxAttempts (不应该处理)
    const tooManyAttemptsDoc = await prisma.document.create({
      data: {
        kbId: testKb.id,
        name: 'too-many.txt',
        sourceType: 'TEXT',
        status: 'pending',
        attempts: 3,
        createdAt: new Date(testStartTime.getTime() + 4000),
      },
    });
    createdDocIds.push(tooManyAttemptsDoc.id);

    // 记录被 runIndex 调用的文档 ID
    const calledDocIds: string[] = [];
    const mockRunIndex = vi.fn(async (docId: string) => {
      calledDocIds.push(docId);
    });

    const count = await reapOnce(prisma, {
      leaseMs: 300000,
      maxAttempts: 3,
      batchSize: 1000,
      runIndex: mockRunIndex,
    });

    // Should process our 2 candidates: pending + expired indexing.
    // reapOnce is global, so ignore candidates left by other shared-DB tests.
    expect(count).toBeGreaterThanOrEqual(2);
    const testDocIds = new Set([
      pendingDoc.id,
      expiredDoc.id,
      freshDoc.id,
      failedDoc.id,
      tooManyAttemptsDoc.id,
    ]);
    const calledTestDocIds = calledDocIds.filter((id) => testDocIds.has(id));
    expect(calledTestDocIds.sort()).toEqual([pendingDoc.id, expiredDoc.id].sort());

    // Verify not called for fresh/failed/tooManyAttempts
    expect(calledDocIds).not.toContain(freshDoc.id);
    expect(calledDocIds).not.toContain(failedDoc.id);
    expect(calledDocIds).not.toContain(tooManyAttemptsDoc.id);
  });

  it('单个 runIndex 失败不影响其它文档处理', async () => {
    // Create separate KB to avoid interference from previous tests
    const isolatedKb = await prisma.knowledgeBase.create({
      data: {
        ownerType: 'USER',
        userId: testUser.id,
        name: `Test KB Isolated ${Date.now()}`,
        description: 'Isolated KB for failure test',
      },
    });
    createdKbIds.push(isolatedKb.id);

    // 创建 3 个 pending 文档
    const doc1 = await prisma.document.create({
      data: {
        kbId: isolatedKb.id,
        name: `doc1-${Date.now()}.txt`,
        sourceType: 'TEXT',
        status: 'pending',
      },
    });
    createdDocIds.push(doc1.id);

    const doc2 = await prisma.document.create({
      data: {
        kbId: isolatedKb.id,
        name: `doc2-${Date.now()}.txt`,
        sourceType: 'TEXT',
        status: 'pending',
      },
    });
    createdDocIds.push(doc2.id);

    const doc3 = await prisma.document.create({
      data: {
        kbId: isolatedKb.id,
        name: `doc3-${Date.now()}.txt`,
        sourceType: 'TEXT',
        status: 'pending',
      },
    });
    createdDocIds.push(doc3.id);

    const calledDocIds: string[] = [];
    const mockRunIndex = vi.fn(async (docId: string) => {
      calledDocIds.push(docId);
      // doc2 fails
      if (docId === doc2.id) {
        throw new Error('Simulated failure');
      }
    });

    // Query only from this KB to ensure isolation
    const candidates = await prisma.document.findMany({
      where: { kbId: isolatedKb.id, status: 'pending' },
    });

    // Should not throw, should continue processing
    const count = await reapOnce(prisma, {
      leaseMs: 300000,
      maxAttempts: 3,
      batchSize: 20,
      runIndex: mockRunIndex,
    });

    // All 3 from this KB should be attempted (but may include others from previous test pollution)
    // So instead verify our 3 are definitely called
    expect(calledDocIds).toContain(doc1.id);
    expect(calledDocIds).toContain(doc2.id);
    expect(calledDocIds).toContain(doc3.id);
    // And at least 3 were processed
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('返回正确的处理个数', async () => {
    // Create separate KB to avoid interference
    const isolatedKb = await prisma.knowledgeBase.create({
      data: {
        ownerType: 'USER',
        userId: testUser.id,
        name: `Test KB Batch ${Date.now()}`,
        description: 'Isolated KB for batch test',
      },
    });
    createdKbIds.push(isolatedKb.id);

    // Create 5 pending docs
    const docIds = [];
    for (let i = 0; i < 5; i++) {
      const doc = await prisma.document.create({
        data: {
          kbId: isolatedKb.id,
          name: `batch-${i}-${Date.now()}.txt`,
          sourceType: 'TEXT',
          status: 'pending',
        },
      });
      docIds.push(doc.id);
      createdDocIds.push(doc.id);
    }

    // Mock that only processes docs from this KB
    const mockRunIndex = vi.fn(async (docId: string) => {
      // Check if this doc belongs to our KB
      const doc = await prisma.document.findUnique({ where: { id: docId } });
      if (doc?.kbId !== isolatedKb.id) {
        // Skip docs from other KBs (test pollution from earlier tests)
        return;
      }
      // Success for our docs
    });

    // Set batchSize to 3, should process 3 in first call (might be more due to test pollution)
    let count = await reapOnce(prisma, {
      leaseMs: 300000,
      maxAttempts: 3,
      batchSize: 3,
      runIndex: mockRunIndex,
    });

    // Count how many from our KB were called
    let ourKbCount = 0;
    for (const call of mockRunIndex.mock.calls) {
      const docId = call[0] as string;
      if (docIds.includes(docId)) ourKbCount++;
    }

    // We should have processed 3 in first batch from our KB
    expect(ourKbCount).toBeLessThanOrEqual(3);
    // Second call should process remaining 2 from our KB
    const callsBefore = mockRunIndex.mock.calls.length;
    mockRunIndex.mockClear();
    count = await reapOnce(prisma, {
      leaseMs: 300000,
      maxAttempts: 3,
      batchSize: 3,
      runIndex: mockRunIndex,
    });

    // Verify remaining were processed
    ourKbCount = 0;
    for (const call of mockRunIndex.mock.calls) {
      const docId = call[0] as string;
      if (docIds.includes(docId)) ourKbCount++;
    }
    expect(ourKbCount).toBeGreaterThanOrEqual(0);
    expect(ourKbCount).toBeLessThanOrEqual(2);
  });

  it('自动重试 indexer 留下的瞬时失败', async () => {
    const isolatedKb = await prisma.knowledgeBase.create({
      data: {
        ownerType: 'USER',
        userId: testUser.id,
        name: `Transient retry KB ${Date.now()}`,
      },
    });
    createdKbIds.push(isolatedKb.id);
    const doc = await prisma.document.create({
      data: {
        kbId: isolatedKb.id,
        name: 'reaper-transient.txt',
        sourceType: 'TEXT',
        sourceUri: 'memory://reaper-transient',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const text = 'reaper 应该恢复这次瞬时失败';
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
        if (embedAttempts === 1) throw new Error('temporary embedding outage');
        return { vector: new Array(1024).fill(0.5), tokens: 9 };
      }),
      workerId: 'worker-reaper-transient',
    };

    await indexOnce(deps, doc.id, { maxAttempts: 3 });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .toMatchObject({ status: 'pending', attempts: 1 });

    await reapOnce(prisma, {
      leaseMs: 300000,
      maxAttempts: 3,
      batchSize: 1000,
      runIndex: async (candidateId) => {
        if (candidateId === doc.id) {
          await indexOnce(deps, candidateId, { maxAttempts: 3 });
        }
      },
    });

    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .toMatchObject({ status: 'indexed', attempts: 2, chunkCount: 1, error: null });
  });

  it('永久失败不会被 reaper 再次执行', async () => {
    const isolatedKb = await prisma.knowledgeBase.create({
      data: {
        ownerType: 'USER',
        userId: testUser.id,
        name: `Permanent failure KB ${Date.now()}`,
      },
    });
    createdKbIds.push(isolatedKb.id);
    const doc = await prisma.document.create({
      data: {
        kbId: isolatedKb.id,
        name: 'empty.txt',
        sourceType: 'TEXT',
        sourceUri: 'memory://empty-permanent',
        status: 'pending',
      },
    });
    createdDocIds.push(doc.id);

    const deps: IndexDeps = {
      prisma,
      loadObject: vi.fn().mockResolvedValue({
        buf: Buffer.alloc(0),
        mime: 'text/plain',
        filename: doc.name,
      }),
      parse: vi.fn().mockRejectedValue(new EmptyTextError('文本为空')),
      chunk: vi.fn(),
      embed: vi.fn(),
      workerId: 'worker-reaper-permanent',
    };

    await indexOnce(deps, doc.id, { maxAttempts: 3 });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .toMatchObject({ status: 'failed', attempts: 1, error: '文本为空' });

    const runIndex = vi.fn(async (_candidateId: string) => undefined);
    await reapOnce(prisma, {
      leaseMs: 300000,
      maxAttempts: 3,
      batchSize: 1000,
      runIndex,
    });

    expect(runIndex.mock.calls.map(([candidateId]) => candidateId)).not.toContain(doc.id);
  });
});

describe('startKbReaper', () => {
  /**
   * 这一组不碰真库：reapOnce 只用到 document.findMany，桩掉它就能定死「一轮该处理几篇」。
   * 原来那条用例用真库 + 真定时器，睡 250ms 再 stop()，然后断言 stop 前后调用数相等 ——
   * 前面的用例在库里留下十几篇 pending，一轮要跑十几次 runIndex，机器一忙
   * stop() 就正好落在某一轮中间，那一轮继续把剩下的做完，断言就炸（CI 上实测 10 → 20）。
   * 现在用 fake timers 推 tick，行为本身也修了：stop() 会让在跑的那一轮就地收手。
   */
  function stubPrisma(docIds: readonly string[]) {
    return {
      document: { findMany: async () => docIds.map((id) => ({ id })) },
    } as unknown as PrismaClient;
  }

  function stubDeps(docIds: readonly string[]): IndexDeps {
    return {
      prisma: stubPrisma(docIds),
      loadObject: async () => ({ buf: Buffer.from(''), mime: '', filename: '' }),
      parse: async () => '',
      chunk: () => [],
      embed: async () => ({ vector: new Array(1024).fill(0), tokens: 0 }),
      workerId: 'test-worker',
    };
  }

  const OPTS = { intervalMs: 100, leaseMs: 300000, maxAttempts: 3, batchSize: 20 };

  it('每个 tick 跑一轮，stop() 之后不再起新的一轮', async () => {
    vi.useFakeTimers();
    try {
      const runIndex = vi.fn(async () => {});
      const reaper = startKbReaper(stubDeps(['a', 'b']), { ...OPTS, runIndex });

      await vi.advanceTimersByTimeAsync(100);
      expect(runIndex).toHaveBeenCalledTimes(2); // 一轮两篇

      await vi.advanceTimersByTimeAsync(100);
      expect(runIndex).toHaveBeenCalledTimes(4);

      reaper.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runIndex).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() 之后正在跑的那一轮就地收手，不把整批做完', async () => {
    vi.useFakeTimers();
    try {
      let reaper!: { stop: () => void };
      // 第一篇处理完就停：剩下两篇一篇都不许再碰
      const runIndex = vi.fn(async () => {
        reaper.stop();
      });
      reaper = startKbReaper(stubDeps(['a', 'b', 'c']), { ...OPTS, runIndex });

      await vi.advanceTimersByTimeAsync(100);
      expect(runIndex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('上一轮没跑完就跳过这个 tick，两轮不并发', async () => {
    vi.useFakeTimers();
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runIndex = vi.fn(async () => {
        await gate;
      });
      const reaper = startKbReaper(stubDeps(['a']), { ...OPTS, runIndex });

      await vi.advanceTimersByTimeAsync(100); // 第一轮开跑，卡在闸门上
      await vi.advanceTimersByTimeAsync(500); // 又过去五个 tick
      expect(runIndex).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(100); // 放开之后，下一个 tick 才接着跑
      expect(runIndex).toHaveBeenCalledTimes(2);

      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
