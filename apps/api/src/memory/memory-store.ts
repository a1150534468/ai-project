import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import type { Prisma } from "@prisma/client";
import { validateEmbeddingVector } from "./embedding-client.js";
import {
  clampImportance,
  type MemoryRecord,
  type MemoryShape,
  normalizeMemoryType,
  normalizeTags,
} from "./memory-types.js";

const MAX_QUERY_RESULTS = 50;

type MemoryDb = Pick<Prisma.TransactionClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

type MemoryRow = {
  id: string;
  title: string;
  text: string;
  type: string;
  importance: number;
  tags: unknown;
  createdAt: Date;
  lastUsedAt: Date | null;
  usedCount: number;
};

type QueryMemoryRow = MemoryRow & { dist: number };

export interface MemoryHit extends MemoryRecord {
  score: number;
}

export type MemorySnapshot = Pick<
  MemoryRecord,
  "id" | "title" | "text" | "type" | "importance" | "tags"
>;

export type MemoryUpdateResult =
  | { kind: "updated"; record: MemoryRecord }
  | { kind: "missing" }
  | { kind: "conflict" };

export interface UserMemoryTransaction {
  get(id: string): Promise<MemoryRecord | null>;
  list(): Promise<MemoryRecord[]>;
  query(vector: readonly number[], topK?: number): Promise<MemoryHit[]>;
  insert(memory: MemoryShape, vector: readonly number[], metadata: unknown): Promise<string>;
  update(
    id: string,
    expected: MemorySnapshot,
    memory: MemoryShape,
    vector: readonly number[] | null,
    metadata: unknown,
  ): Promise<MemoryUpdateResult>;
  delete(id: string, expected?: MemorySnapshot): Promise<number>;
  deleteMany(ids: readonly string[]): Promise<number>;
}

/** pgvector 没有 Prisma 原生类型；只允许校验过的 1024 个有限数字进字面量。 */
function vectorLiteral(vector: readonly number[]): string {
  return `[${validateEmbeddingVector(vector)}]`;
}

function queryLimit(topK: number): number {
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > MAX_QUERY_RESULTS) {
    throw new Error(`memory topK must be an integer from 1 to ${MAX_QUERY_RESULTS}`);
  }
  return topK;
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    type: normalizeMemoryType(row.type),
    importance: clampImportance(row.importance),
    tags: normalizeTags(row.tags),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    usedCount: row.usedCount,
  };
}

const SELECT_COLUMNS = 'id, title, text, type, importance, tags, "createdAt", "lastUsedAt", "usedCount"';

async function getFrom(db: MemoryDb, userId: string, id: string): Promise<MemoryRecord | null> {
  const rows = await db.$queryRawUnsafe<MemoryRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM "Memory" WHERE id = $1 AND "userId" = $2`,
    id,
    userId,
  );
  return rows[0] ? toMemoryRecord(rows[0]) : null;
}

async function listFrom(db: MemoryDb, userId: string): Promise<MemoryRecord[]> {
  const rows = await db.$queryRawUnsafe<MemoryRow[]>(
    `SELECT ${SELECT_COLUMNS}
     FROM "Memory"
     WHERE "userId" = $1
     ORDER BY "createdAt" DESC`,
    userId,
  );
  return rows.map(toMemoryRecord);
}

async function queryFrom(
  db: MemoryDb,
  userId: string,
  vector: readonly number[],
  topK = 5,
): Promise<MemoryHit[]> {
  const rows = await db.$queryRawUnsafe<QueryMemoryRow[]>(
    `SELECT ${SELECT_COLUMNS}, (embedding <=> $1::vector) AS dist
     FROM "Memory"
     WHERE "userId" = $2
     ORDER BY dist ASC
     LIMIT $3`,
    vectorLiteral(vector),
    userId,
    queryLimit(topK),
  );
  return rows.map((row) => ({ ...toMemoryRecord(row), score: 1 - Number(row.dist) }));
}

async function insertInto(
  db: MemoryDb,
  userId: string,
  memory: MemoryShape,
  vector: readonly number[],
  metadata: unknown,
): Promise<string> {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "Memory"(
      id, "userId", title, text, type, importance, tags, embedding, metadata, "createdAt", "usedCount"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::vector, $9::jsonb, now(), 0)`,
    id,
    userId,
    memory.title,
    memory.text,
    memory.type,
    memory.importance,
    JSON.stringify(memory.tags),
    vectorLiteral(vector),
    JSON.stringify(metadata ?? {}),
  );
  return id;
}

function sameSnapshot(record: MemoryRecord, expected: MemorySnapshot): boolean {
  return record.title === expected.title
    && record.text === expected.text
    && record.type === expected.type
    && record.importance === expected.importance
    && JSON.stringify(record.tags) === JSON.stringify(expected.tags);
}

async function updateIn(
  db: MemoryDb,
  userId: string,
  id: string,
  expected: MemorySnapshot,
  memory: MemoryShape,
  vector: readonly number[] | null,
  metadata: unknown,
): Promise<MemoryUpdateResult> {
  const expectedTags = JSON.stringify(expected.tags);
  const nextTags = JSON.stringify(memory.tags);
  const rows = vector === null
    ? await db.$queryRawUnsafe<MemoryRow[]>(
      `UPDATE "Memory"
       SET title = $1, text = $2, type = $3, importance = $4, tags = $5::jsonb
       WHERE id = $6 AND "userId" = $7
         AND title = $8 AND text = $9 AND type = $10 AND importance = $11 AND tags = $12::jsonb
       RETURNING ${SELECT_COLUMNS}`,
      memory.title,
      memory.text,
      memory.type,
      memory.importance,
      nextTags,
      id,
      userId,
      expected.title,
      expected.text,
      expected.type,
      expected.importance,
      expectedTags,
    )
    : await db.$queryRawUnsafe<MemoryRow[]>(
      `UPDATE "Memory"
       SET title = $1, text = $2, type = $3, importance = $4, tags = $5::jsonb,
           embedding = $6::vector, metadata = $7::jsonb
       WHERE id = $8 AND "userId" = $9
         AND title = $10 AND text = $11 AND type = $12 AND importance = $13 AND tags = $14::jsonb
       RETURNING ${SELECT_COLUMNS}`,
      memory.title,
      memory.text,
      memory.type,
      memory.importance,
      nextTags,
      vectorLiteral(vector),
      JSON.stringify(metadata ?? {}),
      id,
      userId,
      expected.title,
      expected.text,
      expected.type,
      expected.importance,
      expectedTags,
    );
  if (rows[0]) return { kind: "updated", record: toMemoryRecord(rows[0]) };

  const current = await getFrom(db, userId, id);
  return current ? { kind: "conflict" } : { kind: "missing" };
}

async function deleteFrom(
  db: MemoryDb,
  userId: string,
  id: string,
  expected?: MemorySnapshot,
): Promise<number> {
  if (!expected) {
    return db.$executeRawUnsafe(`DELETE FROM "Memory" WHERE id = $1 AND "userId" = $2`, id, userId);
  }
  return db.$executeRawUnsafe(
    `DELETE FROM "Memory"
     WHERE id = $1 AND "userId" = $2
       AND title = $3 AND text = $4 AND type = $5 AND importance = $6 AND tags = $7::jsonb`,
    id,
    userId,
    expected.title,
    expected.text,
    expected.type,
    expected.importance,
    JSON.stringify(expected.tags),
  );
}

async function deleteManyFrom(db: MemoryDb, userId: string, ids: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return 0;
  const placeholders = uniqueIds.map((_, index) => `$${index + 2}`).join(", ");
  return db.$executeRawUnsafe(
    `DELETE FROM "Memory" WHERE "userId" = $1 AND id IN (${placeholders})`,
    userId,
    ...uniqueIds,
  );
}

function transactionStore(db: MemoryDb, userId: string): UserMemoryTransaction {
  return {
    get: (id) => getFrom(db, userId, id),
    list: () => listFrom(db, userId),
    query: (vector, topK) => queryFrom(db, userId, vector, topK),
    insert: (memory, vector, metadata) => insertInto(db, userId, memory, vector, metadata),
    update: (id, expected, memory, vector, metadata) =>
      updateIn(db, userId, id, expected, memory, vector, metadata),
    delete: (id, expected) => deleteFrom(db, userId, id, expected),
    deleteMany: (ids) => deleteManyFrom(db, userId, ids),
  };
}

/** 同一个用户的「检查 → 删旧 → 写新」必须在同一条连接、同一个事务锁里。 */
export async function withUserMemoryTransaction<T>(
  userId: string,
  work: (store: UserMemoryTransaction) => Promise<T>,
): Promise<T> {
  return getPrisma().$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `memory:${userId}`,
      );
      return work(transactionStore(tx, userId));
    },
    // 等锁本身也算 Prisma 事务时长。默认 5s 会让正常排队者刚拿到锁就被判超时。
    { maxWait: 10_000, timeout: 30_000 },
  );
}

export async function getMemory(userId: string, id: string): Promise<MemoryRecord | null> {
  return getFrom(getPrisma(), userId, id);
}

export async function insertMemory(
  userId: string,
  memory: MemoryShape,
  embedding: number[],
  metadata: unknown,
): Promise<string> {
  return insertInto(getPrisma(), userId, memory, embedding, metadata);
}

export async function queryMemory(
  userId: string,
  embedding: number[],
  topK = 5,
): Promise<MemoryHit[]> {
  return queryFrom(getPrisma(), userId, embedding, topK);
}

export async function listMemory(userId: string): Promise<MemoryRecord[]> {
  return listFrom(getPrisma(), userId);
}

export async function touchMemories(userId: string, ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return;
  const placeholders = uniqueIds.map((_, index) => `$${index + 2}`).join(", ");
  await getPrisma().$executeRawUnsafe(
    `UPDATE "Memory"
     SET "usedCount" = "usedCount" + 1, "lastUsedAt" = now()
     WHERE "userId" = $1 AND id IN (${placeholders})`,
    userId,
    ...uniqueIds,
  );
}

export async function deleteMemory(userId: string, id: string): Promise<void> {
  await deleteFrom(getPrisma(), userId, id);
}
