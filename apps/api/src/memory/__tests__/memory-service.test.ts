import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  search,
  addTurn,
} from "../memory-service.js";
import type { EmbeddingConfig } from "../embedding-client.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { MemoryHit } from "../memory-store.js";
import type { MemoryRecord } from "../memory-types.js";

// Mock 模块：embedding-client, fact-extractor, memory-store
vi.mock("../embedding-client.js");
vi.mock("../fact-extractor.js");
vi.mock("../memory-store.js");

// 获取 mock 后的导出
const embeddingClient = await import("../embedding-client.js");
const factExtractor = await import("../fact-extractor.js");
const memoryStore = await import("../memory-store.js");

const baseRecord = {
  title: "默认标题",
  text: "默认记忆",
  type: "OTHER",
  importance: 50,
  tags: [],
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  lastUsedAt: null,
  usedCount: 0,
} satisfies Omit<MemoryRecord, "id">;

const makeHit = (overrides: Partial<MemoryHit> = {}): MemoryHit => ({
  id: "m-hit",
  ...baseRecord,
  score: 0.8,
  ...overrides,
});

const makeRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "m-record",
  ...baseRecord,
  ...overrides,
});

describe("memory-service", () => {
  const cfg: EmbeddingConfig = {
    baseURL: "http://test.local",
    apiKey: "test-key",
    model: "test-embedding",
  };
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memoryStore.listMemory).mockResolvedValue([]);
    vi.mocked(memoryStore.deleteMemory).mockResolvedValue(undefined);
    vi.mocked(memoryStore.updateMemory).mockResolvedValue(undefined);
    vi.mocked(memoryStore.insertMemory).mockResolvedValue("new-memory");
  });

  describe("search", () => {
    it("embed → queryMemory → 过滤 score≥THRESHOLD(0.3) 返回", async () => {
      const mockVec = [0.1, 0.2, 0.3];
      const mockHits = [
        makeHit({ id: "m1", text: "记忆 1", score: 0.8 }),
        makeHit({ id: "m2", text: "记忆 2", score: 0.5 }),
        makeHit({ id: "m3", text: "记忆 3", score: 0.25 }), // score < 0.3 应被过滤
      ];

      vi.mocked(embeddingClient.embed).mockResolvedValue({ vector: mockVec, tokens: 10 });
      vi.mocked(memoryStore.queryMemory).mockResolvedValue(mockHits);

      const result = await search(cfg, userId, "用户查询", 5);

      expect(result).toEqual([
        expect.objectContaining({ id: "m1", text: "记忆 1", score: 0.8 }),
        expect.objectContaining({ id: "m2", text: "记忆 2", score: 0.5 }),
      ]);
      expect(embeddingClient.embed).toHaveBeenCalledWith(cfg, "用户查询");
      expect(memoryStore.queryMemory).toHaveBeenCalledWith(userId, mockVec, 5);
    });

    it("embed 超时 3s → 返回 [] 降级", async () => {
      vi.mocked(embeddingClient.embed).mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("timeout")),
              4000, // 4s > 3s 超时
            ),
          ),
      );

      const result = await search(cfg, userId, "查询", 5);

      expect(result).toEqual([]);
    });

    it("embed 抛错 → 返回 [] 降级不抛", async () => {
      vi.mocked(embeddingClient.embed).mockRejectedValue(
        new Error("network error"),
      );

      const result = await search(cfg, userId, "查询", 5);

      expect(result).toEqual([]);
    });

    it("queryMemory 全部低于阈值 → 返回 []", async () => {
      const mockVec = [0.1, 0.2];
      const mockHits = [
        makeHit({ id: "m1", text: "无关", score: 0.2 }),
        makeHit({ id: "m2", text: "更无关", score: 0.1 }),
      ];

      vi.mocked(embeddingClient.embed).mockResolvedValue({ vector: mockVec, tokens: 10 });
      vi.mocked(memoryStore.queryMemory).mockResolvedValue(mockHits);

      const result = await search(cfg, userId, "查询", 5);

      expect(result).toEqual([]);
    });
  });

  describe("addTurn", () => {
    const mockClient = {
      messages: { create: vi.fn() },
    } as unknown as Anthropic;

    it("extractMemoryActions ADD → 每条 embed → queryMemory 检查是否去重 > 0.95 skip", async () => {
      const actions = [
        { event: "ADD" as const, text: "用户喜欢 TypeScript" },
        { event: "ADD" as const, text: "用户在做 AI 助手项目" },
      ];
      const mockVec1 = [0.1, 0.2];
      const mockVec2 = [0.3, 0.4];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue(actions);
      vi.mocked(embeddingClient.embed)
        .mockResolvedValueOnce({ vector: mockVec1, tokens: 10 })
        .mockResolvedValueOnce({ vector: mockVec2, tokens: 15 });

      // 第一条最近邻相似度 0.97 > 0.95 → 去重跳过
      // 第二条最近邻相似度 0.93 < 0.95 → 插入
      vi.mocked(memoryStore.queryMemory)
        .mockResolvedValueOnce([
          makeHit({ id: "old1", text: "旧记忆 1", score: 0.97 }),
        ])
        .mockResolvedValueOnce([
          makeHit({ id: "old2", text: "旧记忆 2", score: 0.93 }),
        ]);

      await addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {
        sessionId: "s1",
      });

      expect(factExtractor.extractMemoryActions).toHaveBeenCalledWith(
        mockClient,
        "extract-model",
        "用户说",
        "助手说",
        [],
      );

      expect(embeddingClient.embed).toHaveBeenCalledTimes(2);
      expect(embeddingClient.embed).toHaveBeenNthCalledWith(1, cfg, "用户喜欢 TypeScript");
      expect(embeddingClient.embed).toHaveBeenNthCalledWith(2, cfg, "用户在做 AI 助手项目");
      expect(memoryStore.queryMemory).toHaveBeenCalledTimes(2);
      expect(memoryStore.insertMemory).toHaveBeenCalledTimes(1);
      expect(memoryStore.insertMemory).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          text: "用户在做 AI 助手项目",
          title: "用户在做 AI 助手项目",
          type: "OTHER",
        }),
        mockVec2,
        { sessionId: "s1" },
      );
    });

    it("规范化后等价的职业记忆即使向量分数低于 0.95 也跳过", async () => {
      const facts = ["职业是后端工程师"];
      const mockVec = [0.1, 0.2];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: facts[0] },
      ]);
      vi.mocked(embeddingClient.embed).mockResolvedValue({ vector: mockVec, tokens: 10 });
      vi.mocked(memoryStore.queryMemory).mockResolvedValue([
        makeHit({ id: "old1", text: "用户是一名后端工程师", score: 0.84 }),
      ]);

      await addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {});

      expect(memoryStore.insertMemory).not.toHaveBeenCalled();
    });

    it("同一轮抽取里的等价事实只插入一次", async () => {
      const facts = ["职业是后端工程师", "用户是一名后端工程师"];
      const mockVec1 = [0.1, 0.2];
      const mockVec2 = [0.3, 0.4];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: facts[0] },
        { event: "ADD", text: facts[1] },
      ]);
      vi.mocked(embeddingClient.embed)
        .mockResolvedValueOnce({ vector: mockVec1, tokens: 10 })
        .mockResolvedValueOnce({ vector: mockVec2, tokens: 10 });
      vi.mocked(memoryStore.queryMemory)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {});

      expect(memoryStore.insertMemory).toHaveBeenCalledTimes(1);
      expect(memoryStore.insertMemory).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          text: "职业是后端工程师",
          title: "职业是后端工程师",
          type: "OTHER",
        }),
        mockVec1,
        {},
      );
    });

    it("新的职业状态记忆会覆盖旧的同类职业记忆", async () => {
      const facts = ["职业状态：全职前端工程师"];
      const mockVec = [0.1, 0.2];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: facts[0] },
      ]);
      vi.mocked(embeddingClient.embed).mockResolvedValue({ vector: mockVec, tokens: 10 });
      vi.mocked(memoryStore.queryMemory).mockResolvedValue([]);
      vi.mocked(memoryStore.listMemory).mockResolvedValue([
        makeRecord({ id: "old1", text: "目前处于失业状态" }),
        makeRecord({ id: "old2", text: "已转行为兼职前端工程师" }),
        makeRecord({ id: "keep", text: "喜欢简洁的回复" }),
      ]);

      await addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {});

      expect(memoryStore.deleteMemory).toHaveBeenCalledWith(userId, "old1");
      expect(memoryStore.deleteMemory).toHaveBeenCalledWith(userId, "old2");
      expect(memoryStore.deleteMemory).not.toHaveBeenCalledWith(userId, "keep");
      expect(memoryStore.insertMemory).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ text: "职业状态:全职前端工程师" }),
        expect.any(Array),
        {},
      );
    });

    it("新的职业状态记忆不会覆盖正在开发的项目记忆", async () => {
      const mockVec = [0.1, 0.2];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: "用户是一名后端工程师" },
      ]);
      vi.mocked(embeddingClient.embed).mockResolvedValue({ vector: mockVec, tokens: 10 });
      vi.mocked(memoryStore.queryMemory).mockResolvedValue([]);
      vi.mocked(memoryStore.listMemory).mockResolvedValue([
        makeRecord({ id: "project", text: "用户正在开发 OpenClaw 项目" }),
        makeRecord({ id: "career", text: "用户之前是前端工程师" }),
      ]);

      await addTurn(cfg, mockClient, "extract-model", userId, "我现在是一名后端工程师", "已记录", {});

      expect(memoryStore.deleteMemory).not.toHaveBeenCalledWith(userId, "project");
      expect(memoryStore.deleteMemory).toHaveBeenCalledWith(userId, "career");
      expect(memoryStore.insertMemory).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ text: "用户是一名后端工程师" }),
        mockVec,
        {},
      );
    });

    it("UPDATE 动作会原地更新已有记忆并清理同类旧记忆", async () => {
      vi.mocked(memoryStore.listMemory).mockResolvedValue([
        makeRecord({ id: "career1", text: "用户之前是后端工程师" }),
        makeRecord({ id: "career2", text: "目前处于失业状态" }),
      ]);
      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "UPDATE", id: "career1", text: "用户现在是前端工程师" },
      ]);
      vi.mocked(embeddingClient.embed).mockResolvedValue({ vector: [0.5, 0.6], tokens: 10 });

      await addTurn(cfg, mockClient, "extract-model", userId, "我转行前端了", "已记录", {});

      expect(memoryStore.updateMemory).toHaveBeenCalledWith(
        userId,
        "career1",
        expect.objectContaining({
          text: "用户现在是前端工程师",
          title: "用户现在是前端工程师",
          type: "OTHER",
        }),
        [0.5, 0.6],
        {},
      );
      expect(memoryStore.deleteMemory).not.toHaveBeenCalledWith(userId, "career1");
      expect(memoryStore.deleteMemory).toHaveBeenCalledWith(userId, "career2");
    });

    it("DELETE 动作会删除指定旧记忆", async () => {
      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "DELETE", id: "m1" },
      ]);

      await addTurn(cfg, mockClient, "extract-model", userId, "这条记忆不对", "已删除", {});

      expect(memoryStore.deleteMemory).toHaveBeenCalledWith(userId, "m1");
      expect(embeddingClient.embed).not.toHaveBeenCalled();
    });

    it("extractMemoryActions 返回空数组 → 无操作", async () => {
      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([]);

      await addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {});

      expect(embeddingClient.embed).not.toHaveBeenCalled();
      expect(memoryStore.insertMemory).not.toHaveBeenCalled();
    });

    it("extractMemoryActions 失败 → 仅 log，不抛，不中断", async () => {
      vi.mocked(factExtractor.extractMemoryActions).mockRejectedValue(
        new Error("extraction failed"),
      );
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // 应该不抛错
      await expect(
        addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {}),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        "[memory] addTurn failed",
        expect.any(Error),
      );
      logSpy.mockRestore();
    });

    it("embed 失败 → 仅 log，不抛，继续处理其他 action", async () => {
      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: "用户喜欢 Rust" },
        { event: "ADD", text: "用户正在做桌面端项目" },
      ]);
      vi.mocked(embeddingClient.embed)
        .mockRejectedValueOnce(new Error("embed failed"))
        .mockResolvedValueOnce({ vector: [0.3, 0.4], tokens: 15 });
      vi.mocked(memoryStore.queryMemory).mockResolvedValue([]);

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // 应该不抛错
      await expect(
        addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {}),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        "[memory] addTurn action failed",
        expect.objectContaining({ event: "ADD", text: "用户喜欢 Rust" }),
        expect.any(Error),
      );
      expect(memoryStore.insertMemory).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ text: "用户正在做桌面端项目" }),
        [0.3, 0.4],
        {},
      );
      logSpy.mockRestore();
    });

    it("insertMemory 失败 → 仅 log，不抛", async () => {
      const facts = ["用户喜欢 TypeScript"];
      const mockVec = [0.1, 0.2];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: facts[0] },
      ]);
      vi.mocked(embeddingClient.embed).mockResolvedValue({ vector: mockVec, tokens: 10 });
      vi.mocked(memoryStore.queryMemory).mockResolvedValue([]); // 无去重
      vi.mocked(memoryStore.insertMemory).mockRejectedValue(
        new Error("insert failed"),
      );

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // 应该不抛错
      await expect(
        addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {}),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        "[memory] addTurn action failed",
        expect.objectContaining({ event: "ADD", text: "用户喜欢 TypeScript" }),
        expect.any(Error),
      );
      logSpy.mockRestore();
    });

    it("多条 facts，混合成功/失败 → 仅 log 不抛", async () => {
      const facts = ["用户喜欢 Go", "用户喜欢 Python", "用户喜欢 Java"];
      const mockVec1 = [0.1, 0.2];
      const mockVec3 = [0.3, 0.4];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: facts[0] },
        { event: "ADD", text: facts[1] },
        { event: "ADD", text: facts[2] },
      ]);
      vi.mocked(embeddingClient.embed)
        .mockResolvedValueOnce({ vector: mockVec1, tokens: 10 })
        .mockRejectedValueOnce(new Error("embed error"))
        .mockResolvedValueOnce({ vector: mockVec3, tokens: 15 });

      vi.mocked(memoryStore.queryMemory)
        .mockResolvedValueOnce([]) // 成功 1
        .mockResolvedValueOnce([]); // 成功 3

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // 应该不抛错，最终仅记录一次错误（第一次失败）
      await expect(
        addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {}),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        "[memory] addTurn action failed",
        expect.objectContaining({ event: "ADD", text: "用户喜欢 Python" }),
        expect.any(Error),
      );
      expect(memoryStore.insertMemory).toHaveBeenCalledTimes(2);
      logSpy.mockRestore();
    });

    it("低价值动作会被跳过", async () => {
      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: "你好" },
        { event: "ADD", text: "用户询问如何写代码" },
      ]);

      await addTurn(cfg, mockClient, "extract-model", userId, "你好", "你好", {});

      expect(embeddingClient.embed).not.toHaveBeenCalled();
      expect(memoryStore.insertMemory).not.toHaveBeenCalled();
    });

    it("all queryMemory scores > 0.95 → 所有 ADD 去重跳过，无 insert", async () => {
      const facts = ["用户喜欢 TypeScript", "用户正在做 AI 助手项目"];
      const mockVec1 = [0.1, 0.2];
      const mockVec2 = [0.3, 0.4];

      vi.mocked(factExtractor.extractMemoryActions).mockResolvedValue([
        { event: "ADD", text: facts[0] },
        { event: "ADD", text: facts[1] },
      ]);
      vi.mocked(embeddingClient.embed)
        .mockResolvedValueOnce({ vector: mockVec1, tokens: 10 })
        .mockResolvedValueOnce({ vector: mockVec2, tokens: 15 });

      // 两个都有高相似度的已存在记忆
      vi.mocked(memoryStore.queryMemory)
        .mockResolvedValueOnce([
          makeHit({ id: "dup1", text: "已存 1", score: 0.96 }),
        ])
        .mockResolvedValueOnce([
          makeHit({ id: "dup2", text: "已存 2", score: 0.99 }),
        ]);

      await addTurn(cfg, mockClient, "extract-model", userId, "用户说", "助手说", {});

      // 都被去重跳过，无 insert
      expect(memoryStore.insertMemory).not.toHaveBeenCalled();
    });
  });
});
