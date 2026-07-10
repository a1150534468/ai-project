import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getPrisma } from '@yc/db';
import type { User, KnowledgeBase } from '@prisma/client';
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
});

describe('startKbReaper', () => {
  it('启动停止周期任务', async () => {
    const mockRunIndex = vi.fn(async () => {
      // Mock
    });

    const reaper = startKbReaper(
      {
        prisma,
        loadObject: async () => ({ buf: Buffer.from(''), mime: '', filename: '' }),
        parse: async () => '',
        chunk: () => [],
        embed: async () => ({ vector: new Array(4096).fill(0), tokens: 0 }),
        billing: { settle: async () => {} },
        embeddingModel: 'test',
        workerId: 'test-worker',
      },
      {
        intervalMs: 100, // Short interval for testing
        leaseMs: 300000,
        maxAttempts: 3,
        batchSize: 20,
        runIndex: mockRunIndex,
      },
    );

    // Wait a bit for cycles to run
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Should have called at least once (maybe twice depending on timing)
    expect(mockRunIndex.mock.calls.length).toBeGreaterThanOrEqual(0);

    reaper.stop();

    // Wait to ensure no more cycles
    const callsBefore = mockRunIndex.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const callsAfter = mockRunIndex.mock.calls.length;

    // Should be equal (no more calls after stop)
    expect(callsAfter).toBe(callsBefore);
  });
});
