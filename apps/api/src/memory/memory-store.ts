import { randomUUID } from "node:crypto";
import { getPrisma } from "@yc/db";
import {
  clampImportance,
  type MemoryRecord,
  type MemoryShape,
  normalizeMemoryType,
  normalizeTags,
} from "./memory-types.js";

const toVec = (v: readonly number[]) => `[${v.join(",")}]`;

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

type QueryMemoryRow = MemoryRow & {
  dist: number;
};

export interface MemoryHit extends MemoryRecord {
  score: number;
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

export async function insertMemory(
  userId: string,
  memory: MemoryShape,
  embedding: number[],
  metadata: unknown,
): Promise<string> {
  const prisma = getPrisma();
  const id = randomUUID();

  await prisma.$executeRawUnsafe(
    `INSERT INTO "Memory"(
      id, "userId", title, text, type, importance, tags, embedding, metadata, "createdAt", "usedCount"
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::vector, $9::jsonb, now(), 0)`,
    id,
    userId,
    memory.title,
    memory.text,
    memory.type,
    memory.importance,
    JSON.stringify(memory.tags),
    toVec(embedding),
    JSON.stringify(metadata ?? {}),
  );

  return id;
}

export async function updateMemory(
  userId: string,
  id: string,
  memory: MemoryShape,
  embedding: number[] | null,
  metadata: unknown,
): Promise<void> {
  const prisma = getPrisma();

  if (embedding === null) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Memory"
       SET title = $1,
           text = $2,
           type = $3,
           importance = $4,
           tags = $5::jsonb,
           metadata = $6::jsonb
       WHERE id = $7 AND "userId" = $8`,
      memory.title,
      memory.text,
      memory.type,
      memory.importance,
      JSON.stringify(memory.tags),
      JSON.stringify(metadata ?? {}),
      id,
      userId,
    );
    return;
  }

  await prisma.$executeRawUnsafe(
    `UPDATE "Memory"
     SET title = $1,
         text = $2,
         type = $3,
         importance = $4,
         tags = $5::jsonb,
         embedding = $6::vector,
         metadata = $7::jsonb
     WHERE id = $8 AND "userId" = $9`,
    memory.title,
    memory.text,
    memory.type,
    memory.importance,
    JSON.stringify(memory.tags),
    toVec(embedding),
    JSON.stringify(metadata ?? {}),
    id,
    userId,
  );
}

export async function queryMemory(
  userId: string,
  embedding: number[],
  topK = 5,
): Promise<MemoryHit[]> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRawUnsafe<QueryMemoryRow[]>(
    `SELECT id, title, text, type, importance, tags, "createdAt", "lastUsedAt", "usedCount",
            (embedding <=> $1::vector) AS dist
     FROM "Memory"
     WHERE "userId" = $2
     ORDER BY dist ASC
     LIMIT $3`,
    toVec(embedding),
    userId,
    topK,
  );

  return rows.map((row) => ({
    ...toMemoryRecord(row),
    score: 1 - Number(row.dist),
  }));
}

export async function listMemory(userId: string): Promise<MemoryRecord[]> {
  const rows = await getPrisma().$queryRawUnsafe<MemoryRow[]>(
    `SELECT id, title, text, type, importance, tags, "createdAt", "lastUsedAt", "usedCount"
     FROM "Memory"
     WHERE "userId" = $1
     ORDER BY "createdAt" DESC`,
    userId,
  );

  return rows.map(toMemoryRecord);
}

export async function touchMemories(userId: string, ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return;
  }

  const placeholders = uniqueIds.map((_, index) => `$${index + 2}`).join(", ");
  await getPrisma().$executeRawUnsafe(
    `UPDATE "Memory"
     SET "usedCount" = "usedCount" + 1,
         "lastUsedAt" = now()
     WHERE "userId" = $1 AND id IN (${placeholders})`,
    userId,
    ...uniqueIds,
  );
}

export async function deleteMemory(userId: string, id: string): Promise<void> {
  await getPrisma().$executeRawUnsafe(
    `DELETE FROM "Memory" WHERE id = $1 AND "userId" = $2`,
    id,
    userId,
  );
}
