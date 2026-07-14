import { describe, it, expect, beforeEach } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { insertMemory, queryMemory, deleteMemory } from "../memory-store.js";
import type { MemoryShape } from "../memory-types.js";

const prisma = getPrisma();
const DIM = Number(process.env.EMBEDDING_DIM ?? 1024);
const vec = (seed: number) => Array.from({ length: DIM }, (_, i) => Math.sin(seed + i));
const memory = (text: string): MemoryShape => ({
  title: text,
  text,
  type: "OTHER",
  importance: 50,
  tags: [],
});

// Only run this test when EMBEDDING_DIM matches pgvector column dimension (1024)
describe.skipIf(DIM !== 1024)("memory-store (pgvector)", () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Memory"');
  });

  it("插入后按相似度召回，按 userId 隔离", async () => {
    await insertMemory("u1", memory("用户喜欢 TS"), vec(1), {});
    await insertMemory("u1", memory("用户在爬山"), vec(50), {});
    await insertMemory("u2", memory("别人的记忆"), vec(1), {}); // 不应被 u1 召回
    const hits = await queryMemory("u1", vec(1), 5);
    expect(hits[0].text).toBe("用户喜欢 TS");
    expect(hits.every((h) => h.text !== "别人的记忆")).toBe(true);
  });
});
