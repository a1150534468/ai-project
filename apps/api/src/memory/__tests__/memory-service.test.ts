import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingConfig } from "../embedding-client.js";
import { addTurn, search } from "../memory-service.js";
import type { MemoryHit, UserMemoryTransaction } from "../memory-store.js";
import type { MemoryRecord } from "../memory-types.js";

vi.mock("../embedding-client.js");
vi.mock("../fact-extractor.js");
vi.mock("../memory-store.js");

const embeddingClient = await import("../embedding-client.js");
const factExtractor = await import("../fact-extractor.js");
const memoryStore = await import("../memory-store.js");

const cfg: EmbeddingConfig = { baseURL: "http://embedding.test", apiKey: "key", model: "embed" };
const userId = "user-123";
const client = { messages: { create: vi.fn() } } as unknown as Anthropic;
const vector = [0.1, 0.2];
const base = {
  title: "默认标题",
  text: "默认记忆",
  type: "OTHER" as const,
  importance: 50,
  tags: [],
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  lastUsedAt: null,
  usedCount: 0,
};
const record = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({ id: "m1", ...base, ...overrides });
const hit = (overrides: Partial<MemoryHit> = {}): MemoryHit => ({ ...record(), score: 0.8, ...overrides });

let rows: MemoryRecord[];
let tx: UserMemoryTransaction;

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  rows = [];
  tx = {
    get: vi.fn(async (id) => rows.find((row) => row.id === id) ?? null),
    list: vi.fn(async () => [...rows]),
    query: vi.fn(async () => []),
    insert: vi.fn(async (shape) => {
      rows.push(record({ ...shape, id: `new-${rows.length}` }));
      return rows.at(-1)!.id;
    }),
    update: vi.fn(async (id, expected, shape) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return { kind: "missing" } as const;
      if (rows[index].text !== expected.text) return { kind: "conflict" } as const;
      rows[index] = { ...rows[index], ...shape };
      return { kind: "updated", record: rows[index] } as const;
    }),
    delete: vi.fn(async (id) => {
      const before = rows.length;
      rows = rows.filter((row) => row.id !== id);
      return before - rows.length;
    }),
    deleteMany: vi.fn(async (ids) => {
      const before = rows.length;
      const set = new Set(ids);
      rows = rows.filter((row) => !set.has(row.id));
      return before - rows.length;
    }),
  };
  vi.mocked(memoryStore.listMemory).mockImplementation(async () => [...rows]);
  vi.mocked(memoryStore.withUserMemoryTransaction).mockImplementation(async (_uid, work) => work(tx));
});

describe("search", () => {
  it("embedding 与查询共用三秒总期限，并过滤低分结果", async () => {
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 3 });
    vi.mocked(memoryStore.queryMemory).mockResolvedValue([
      hit({ id: "high", score: 0.8 }),
      hit({ id: "low", score: 0.29 }),
    ]);

    await expect(search(cfg, userId, "typescript")).resolves.toEqual([
      expect.objectContaining({ id: "high" }),
    ]);
    expect(embeddingClient.embed).toHaveBeenCalledWith(
      cfg,
      "typescript",
      fetch,
      expect.any(AbortSignal),
    );
  });

  it("预计算向量的数据库查询挂住也会在三秒降级", async () => {
    vi.useFakeTimers();
    vi.mocked(memoryStore.queryMemory).mockReturnValue(new Promise(() => {}));
    const pending = search(cfg, userId, "q", 5, vector);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual([]);
    vi.useRealTimers();
  });

  it("embedding 失败或查询失败都返回空数组", async () => {
    vi.mocked(embeddingClient.embed).mockRejectedValueOnce(new Error("down"));
    await expect(search(cfg, userId, "q")).resolves.toEqual([]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 0 });
    vi.mocked(memoryStore.queryMemory).mockRejectedValueOnce(new Error("db"));
    await expect(search(cfg, userId, "q")).resolves.toEqual([]);
  });
});

describe("addTurn", () => {
  it("ADD 在用户事务里复查去重，再原子插入并清理被替代事实", async () => {
    rows = [
      record({ id: "old-career", text: "用户之前是后端工程师" }),
      record({ id: "keep", text: "用户喜欢简洁回复" }),
    ];
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "ADD", text: "用户现在是前端工程师" },
    ]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 1 });

    await addTurn(cfg, client, "extract", userId, "我转行了", "已记录", { sessionId: "s1" });

    expect(factExtractor.extractMemoryActions).toHaveBeenCalledWith(
      client,
      "extract",
      "我转行了",
      "已记录",
      expect.arrayContaining([expect.objectContaining({ id: "old-career" })]),
      expect.any(Function),
    );
    expect(memoryStore.withUserMemoryTransaction).toHaveBeenCalledWith(userId, expect.any(Function));
    expect(tx.query).toHaveBeenCalledWith(vector, 5);
    expect(tx.insert).toHaveBeenCalledWith(
      expect.objectContaining({ text: "用户现在是前端工程师" }),
      vector,
      { sessionId: "s1" },
    );
    expect(tx.deleteMany).toHaveBeenCalledWith(["old-career"]);
    expect(rows.some((row) => row.id === "keep")).toBe(true);
  });

  it("锁内复查发现等价或高相似非职业事实就不插入", async () => {
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "ADD", text: "用户喜欢 TypeScript" },
    ]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 1 });
    vi.mocked(tx.query).mockResolvedValue([hit({ text: "用户喜欢 TS", score: 0.97 })]);

    await addTurn(cfg, client, "extract", userId, "x", "y", {});

    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.deleteMany).not.toHaveBeenCalled();
  });

  it("同一轮规范化后等价的 ADD 只写一次", async () => {
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "ADD", text: "职业是后端工程师" },
      { event: "ADD", text: "用户是一名后端工程师" },
    ]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 1 });

    await addTurn(cfg, client, "extract", userId, "x", "y", {});

    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(embeddingClient.embed).toHaveBeenCalledTimes(1);
  });

  it("UPDATE 保留模型没给的字段，成功后才清理同类旧事实", async () => {
    rows = [
      record({ id: "career1", title: "职业", text: "用户之前是后端工程师", type: "CORE", importance: 90, tags: ["工作"] }),
      record({ id: "career2", text: "目前处于失业状态" }),
    ];
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "UPDATE", id: "career1", text: "用户现在是前端工程师" },
    ]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 1 });

    await addTurn(cfg, client, "extract", userId, "x", "y", {});

    expect(tx.update).toHaveBeenCalledWith(
      "career1",
      expect.objectContaining({ id: "career1", type: "CORE" }),
      expect.objectContaining({
        title: "职业",
        text: "用户现在是前端工程师",
        type: "CORE",
        importance: 90,
        tags: ["工作"],
      }),
      vector,
      {},
    );
    expect(tx.deleteMany).toHaveBeenCalledWith(["career2"]);
  });

  it("不存在或过期的 UPDATE 绝不删掉现有职业事实", async () => {
    rows = [record({ id: "career1", text: "用户是后端工程师" })];
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "UPDATE", id: "missing", text: "用户现在是前端工程师" },
    ]);

    await addTurn(cfg, client, "extract", userId, "x", "y", {});

    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.deleteMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it("UPDATE CAS 冲突后不清理同类事实", async () => {
    rows = [record({ id: "career1", text: "用户是后端工程师" })];
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "UPDATE", id: "career1", text: "用户现在是前端工程师" },
    ]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 1 });
    vi.mocked(tx.update).mockResolvedValue({ kind: "conflict" });

    await addTurn(cfg, client, "extract", userId, "x", "y", {});

    expect(tx.deleteMany).not.toHaveBeenCalled();
  });

  it("DELETE 只执行抽取快照里真实存在的 id", async () => {
    rows = [record({ id: "real" })];
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "DELETE", id: "missing" },
      { event: "DELETE", id: "real" },
    ]);

    await addTurn(cfg, client, "extract", userId, "x", "y", {});

    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledWith("real", expect.objectContaining({ id: "real" }));
  });

  it("单条 action 失败只记录错误，后面的 action 继续", async () => {
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "ADD", text: "用户喜欢 Rust" },
      { event: "ADD", text: "用户正在做桌面端项目" },
    ]);
    vi.mocked(embeddingClient.embed)
      .mockRejectedValueOnce(new Error("embed failed"))
      .mockResolvedValueOnce({ vector, tokens: 1 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(addTurn(cfg, client, "extract", userId, "x", "y", {})).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(
      "[memory] addTurn action failed",
      expect.objectContaining({ text: "用户喜欢 Rust" }),
      expect.any(Error),
    );
    expect(tx.insert).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("事务失败不往外抛，后续 action 仍可处理", async () => {
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "ADD", text: "用户喜欢 TypeScript" },
      { event: "ADD", text: "用户正在维护记忆系统" },
    ]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({ vector, tokens: 1 });
    vi.mocked(memoryStore.withUserMemoryTransaction)
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockImplementationOnce(async (_uid, work) => work(tx));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await addTurn(cfg, client, "extract", userId, "x", "y", {});

    expect(log).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("低价值动作、NONE 和空动作都不做向量或写操作", async () => {
    vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
      { event: "ADD", text: "你好" },
      { event: "NONE" },
    ]);
    await addTurn(cfg, client, "extract", userId, "你好", "你好", {});
    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(memoryStore.withUserMemoryTransaction).not.toHaveBeenCalled();
  });
});
