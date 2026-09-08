import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import {
  insertMemory,
  queryMemory,
  withUserMemoryTransaction,
} from "../memory-store.js";
import type { MemoryShape } from "../memory-types.js";

const databaseReady = Boolean(process.env.DATABASE_URL) && Number(process.env.EMBEDDING_DIM ?? 1024) === 1024;
const prisma = databaseReady ? getPrisma() : null;
const fixtureUsers = new Set<string>();
const vector = (seed: number) => Array.from({ length: 1024 }, (_, index) => Math.sin(seed + index));
const memory = (text: string): MemoryShape => ({ title: text, text, type: "OTHER", importance: 50, tags: [] });

function fixtureUser(): string {
  const id = `memory-test-${randomUUID()}`;
  fixtureUsers.add(id);
  return id;
}

/** 只清自己造的 userId；绝不能再 TRUNCATE 开发库里所有人的长期记忆。 */
afterEach(async () => {
  if (!prisma || fixtureUsers.size === 0) return;
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Memory" WHERE "userId" = ANY($1::text[])`,
    [...fixtureUsers],
  );
  fixtureUsers.clear();
});

describe.skipIf(!databaseReady)("memory-store (pgvector)", () => {
  it("按相似度召回并按 userId 隔离，不碰无关行", async () => {
    const owner = fixtureUser();
    const other = fixtureUser();
    await insertMemory(owner, memory("用户喜欢 TS"), vector(1), {});
    await insertMemory(owner, memory("用户在爬山"), vector(50), {});
    await insertMemory(other, memory("别人的记忆"), vector(1), {});

    const hits = await queryMemory(owner, vector(1), 5);
    expect(hits[0].text).toBe("用户喜欢 TS");
    expect(hits.every((hit) => hit.text !== "别人的记忆")).toBe(true);
  });

  it("用户事务里任一步失败，插入与删除一起回滚", async () => {
    const owner = fixtureUser();
    await insertMemory(owner, memory("旧职业"), vector(1), {});
    const old = (await queryMemory(owner, vector(1), 5))[0];

    await expect(
      withUserMemoryTransaction(owner, async (store) => {
        await store.insert(memory("新职业"), vector(2), {});
        await store.delete(old.id);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const remaining = await queryMemory(owner, vector(1), 5);
    expect(remaining.map((row) => row.text)).toEqual(["旧职业"]);
  });

  it("无效向量与 topK 在碰数据库之前被拒绝", async () => {
    const owner = fixtureUser();
    await expect(queryMemory(owner, [1, 2], 5)).rejects.toThrow("1024 finite dimensions");
    await expect(queryMemory(owner, vector(1), 0)).rejects.toThrow("integer from 1 to 50");
  });
});
