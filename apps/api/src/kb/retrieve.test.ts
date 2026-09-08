import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dedupeKbCitations,
  filterRelevantChunks,
  resolveEffectiveKbIds,
  retrieveChunks,
  shouldRetrieveKbForQuery,
  type RetrievedChunk,
} from "./retrieve.js";

const chunk = (docName: string, ordinal: number, score: number): RetrievedChunk => ({
  content: `${docName}:${ordinal}`,
  docName,
  ordinal,
  score,
});

const sorted = (values: readonly string[]) => [...values].sort();

function kbReader(...responses: unknown[][]) {
  const findMany = vi.fn();
  for (const response of responses) findMany.mockResolvedValueOnce(response);
  return { prisma: { knowledgeBase: { findMany } } as never, findMany };
}

describe("resolveEffectiveKbIds", () => {
  it("没有任何选择时仍读取 own 集，数据库故障不能伪装成空选择", async () => {
    const fixture = kbReader([]);
    await expect(resolveEffectiveKbIds(fixture.prisma, "u1", {})).resolves.toEqual([]);
    expect(fixture.findMany).toHaveBeenCalledOnce();
    expect(fixture.findMany).toHaveBeenCalledWith({
      where: { ownerType: "USER", userId: "u1" },
      select: { id: true },
    });
  });

  it("attach-all 只展开自己的 USER 库", async () => {
    const fixture = kbReader([{ id: "own-a" }, { id: "own-b" }]);
    await expect(resolveEffectiveKbIds(fixture.prisma, "u1", { kbAttachAllOwn: true }))
      .resolves.toEqual(["own-a", "own-b"]);
    expect(fixture.findMany).toHaveBeenCalledWith({
      where: { ownerType: "USER", userId: "u1" },
      select: { id: true },
    });
  });

  it("显式选择只保留自己的库和官方库，并去掉重复与不存在的 id", async () => {
    const fixture = kbReader(
      [],
      [
        { id: "own", ownerType: "USER", userId: "u1" },
        { id: "official", ownerType: "OFFICIAL", userId: null },
      ],
    );
    const result = await resolveEffectiveKbIds(fixture.prisma, "u1", {
      attachedKbIds: ["own", "official", "foreign", "missing", "official"],
    });
    expect(sorted(result)).toEqual(["official", "own"]);
    expect(fixture.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["own", "official", "foreign", "missing", "official"] },
        OR: [{ ownerType: "OFFICIAL" }, { ownerType: "USER", userId: "u1" }],
      },
      select: { id: true, ownerType: true, userId: true },
    });
  });

  it("显式选择中自己的库排在官方库之前", async () => {
    const fixture = kbReader(
      [],
      [
        { id: "official", ownerType: "OFFICIAL", userId: null },
        { id: "own", ownerType: "USER", userId: "u1" },
      ],
    );
    await expect(resolveEffectiveKbIds(fixture.prisma, "u1", { attachedKbIds: ["official", "own"] }))
      .resolves.toEqual(["own", "official"]);
  });

  it("attach-all 与显式官方库取并集", async () => {
    const fixture = kbReader(
      [{ id: "own" }],
      [{ id: "official", ownerType: "OFFICIAL", userId: null }],
    );
    await expect(resolveEffectiveKbIds(fixture.prisma, "u1", {
      kbAttachAllOwn: true,
      attachedKbIds: ["official"],
    })).resolves.toEqual(["own", "official"]);
  });

  it("数据库错误原样透传", async () => {
    const failure = new Error("db unavailable");
    const findMany = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(failure);
    await expect(resolveEffectiveKbIds({ knowledgeBase: { findMany } } as never, "u1", {
      attachedKbIds: ["official"],
    }))
      .rejects.toBe(failure);
  });
});

describe("shouldRetrieveKbForQuery", () => {
  it.each(["", "  \n ", "，。！？!?.,", "你好", " 您 好！！ ", "HELLO...", "ok", "谢谢"])('%j 不检索', (query) => {
    expect(shouldRetrieveKbForQuery(query)).toBe(false);
  });

  it.each(["知识库", "谢谢你", "hi there", "甲乙", "😀", "：："])('%j 会检索', (query) => {
    expect(shouldRetrieveKbForQuery(query)).toBe(true);
  });

  it("单个 BMP 字符不检索", () => {
    expect(shouldRetrieveKbForQuery("甲")).toBe(false);
  });
});

describe("filterRelevantChunks", () => {
  it("保持输入顺序，纳入阈值相等项，并同时执行两层上限", () => {
    const chunks = [
      chunk("A", 0, 0.35),
      chunk("A", 1, 0.9),
      chunk("A", 2, 0.8),
      chunk("B", 0, 0.34),
      chunk("C", 0, 0.7),
      chunk("D", 0, 0.6),
    ];
    expect(filterRelevantChunks(chunks, { minScore: 0.35, maxChunks: 3, maxChunksPerDocument: 2 }))
      .toEqual([chunks[0], chunks[1], chunks[4]]);
  });

  it("docName 区分大小写，结果保留原对象且不改输入", () => {
    const upper = chunk("Guide.md", 0, 0.9);
    const lower = chunk("guide.md", 0, 0.8);
    const input = Object.freeze([upper, lower]);
    const result = filterRelevantChunks(input, { minScore: 0, maxChunks: 2, maxChunksPerDocument: 1 });
    expect(result).toEqual([upper, lower]);
    expect(result[0]).toBe(upper);
  });

  it("非正容量返回空集", () => {
    const input = [chunk("A", 0, 1)];
    expect(filterRelevantChunks(input, { minScore: 0, maxChunks: 0, maxChunksPerDocument: 1 })).toEqual([]);
    expect(filterRelevantChunks(input, { minScore: 0, maxChunks: 1, maxChunksPerDocument: 0 })).toEqual([]);
  });
});

describe("dedupeKbCitations", () => {
  it("每个精确 docName 取第一次出现的 ordinal", () => {
    const input = [chunk("Guide", 4, 0.9), chunk("Guide", 1, 0.8), chunk("guide", 4, 0.7)];
    expect(dedupeKbCitations(input)).toEqual([
      { docName: "Guide", ordinal: 4 },
      { docName: "guide", ordinal: 4 },
    ]);
  });

  it("空输入返回空数组", () => {
    expect(dedupeKbCitations([])).toEqual([]);
  });
});

const queryVector = () => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));

describe("retrieveChunks 的 SQL 边界", () => {
  it("空 KB 集合零查询返回", async () => {
    const query = vi.fn();
    await expect(retrieveChunks({ $queryRawUnsafe: query } as never, [], queryVector(), 8)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("校验后用占位参数查询，保持行顺序并数值化 score", async () => {
    const query = vi.fn().mockResolvedValue([
      { content: "near", docName: "A", ordinal: 0, score: "1" },
      { content: "far", docName: "B", ordinal: 1, score: -1 },
    ]);
    const result = await retrieveChunks({ $queryRawUnsafe: query } as never, ["kb-a", "kb-b"], queryVector(), 2);
    expect(result.map(({ content, score }) => ({ content, score }))).toEqual([
      { content: "near", score: 1 },
      { content: "far", score: -1 },
    ]);
    const [sql, literal, ids, status, limit] = query.mock.calls[0];
    expect(sql).toContain('JOIN "Document" AS d');
    expect(sql).toContain('c."kbId" = ANY($2)');
    expect(sql).toContain("d.status = $3");
    expect(sql).toContain("ORDER BY c.embedding <=> $1::vector");
    expect(sql).toContain("LIMIT $4");
    expect(literal).toBe(`[${queryVector().join(",")}]`);
    expect(ids).toEqual(["kb-a", "kb-b"]);
    expect(status).toBe("indexed");
    expect(limit).toBe(2);
  });

  it.each([
    ["错维", [1], 1],
    ["NaN", Array(1024).fill(Number.NaN), 1],
    ["Infinity", Array(1024).fill(Number.POSITIVE_INFINITY), 1],
    ["zero vector", Array(1024).fill(0), 1],
    ["topK 0", queryVector(), 0],
    ["topK 小数", queryVector(), 1.5],
  ])("%s 在查询前拒绝", async (_name, vector, topK) => {
    const query = vi.fn();
    await expect(retrieveChunks({ $queryRawUnsafe: query } as never, ["kb"], vector as number[], topK as number))
      .rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

const databaseReady = Boolean(process.env.DATABASE_URL)
  && Number(process.env.EMBEDDING_DIM ?? 1024) === 1024;
const describeDatabase = databaseReady ? describe : describe.skip;

describeDatabase("retrieveChunks 的 pgvector 集成", () => {
  const prisma: PrismaClient = getPrisma();
  const prefix = `kb_retrieve_${randomUUID()}`;
  const createdKbIds: string[] = [];
  const createdUserIds: string[] = [];
  let selectedKb = "";
  let secondKb = "";
  let unselectedKb = "";

  const vector = (first: number, second: number) => {
    const value = Array(1024).fill(0);
    value[0] = first;
    value[1] = second;
    return value;
  };
  const literal = (value: number[]) => `[${value.join(",")}]`;

  async function createKb(userId: string, suffix: string) {
    const kb = await prisma.knowledgeBase.create({ data: { ownerType: "USER", userId, name: `${prefix}_${suffix}` } });
    createdKbIds.push(kb.id);
    return kb.id;
  }

  async function createDocument(kbId: string, suffix: string, status = "indexed") {
    return prisma.document.create({ data: { kbId, name: `${prefix}_${suffix}`, status, sourceType: "TEXT" } });
  }

  async function insertChunk(documentId: string, kbId: string, ordinal: number, content: string, embedding: number[]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Chunk"(id, "documentId", "kbId", ordinal, content, embedding, "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6::vector, now())`,
      randomUUID(), documentId, kbId, ordinal, content, literal(embedding),
    );
  }

  beforeAll(async () => {
    for (const suffix of ["one", "two"]) {
      const user = await prisma.user.create({ data: { uid: `${prefix}_${suffix}`, username: `${prefix}_${suffix}`, passwordHash: "x" } });
      createdUserIds.push(user.id);
    }
    selectedKb = await createKb(createdUserIds[0], "selected");
    secondKb = await createKb(createdUserIds[0], "second");
    unselectedKb = await createKb(createdUserIds[1], "foreign");

    const near = await createDocument(selectedKb, "near");
    const opposite = await createDocument(selectedKb, "opposite");
    const pending = await createDocument(selectedKb, "pending", "pending");
    const second = await createDocument(secondKb, "second-kb");
    const foreign = await createDocument(unselectedKb, "foreign");
    await insertChunk(near.id, selectedKb, 0, `${prefix}:near`, vector(1, 0));
    await insertChunk(opposite.id, selectedKb, 1, `${prefix}:opposite`, vector(-1, 0));
    await insertChunk(pending.id, selectedKb, 2, `${prefix}:pending`, vector(1, 0));
    await insertChunk(second.id, secondKb, 3, `${prefix}:second`, vector(0, 1));
    await insertChunk(foreign.id, unselectedKb, 4, `${prefix}:foreign`, vector(1, 0));
  });

  afterAll(async () => {
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("按余弦距离排序，score 合法范围包含负数，并排除非 indexed 文档", async () => {
    const hits = await retrieveChunks(prisma, [selectedKb], vector(1, 0), 10);
    const ours = hits.filter(({ content }) => content.startsWith(prefix));
    expect(ours.map(({ content }) => content)).toEqual([`${prefix}:near`, `${prefix}:opposite`]);
    expect(ours[0].score).toBeCloseTo(1);
    expect(ours[1].score).toBeCloseTo(-1);
    expect(ours.some(({ content }) => content.endsWith(":pending"))).toBe(false);
  });

  it("多 KB 并集、未选择库隔离和 topK 都生效", async () => {
    const hits = await retrieveChunks(prisma, [selectedKb, secondKb, selectedKb], vector(1, 0), 2);
    expect(hits).toHaveLength(2);
    expect(hits.map(({ content }) => content)).toEqual([`${prefix}:near`, `${prefix}:second`]);
    expect(hits.some(({ content }) => content.endsWith(":foreign"))).toBe(false);
  });
});
