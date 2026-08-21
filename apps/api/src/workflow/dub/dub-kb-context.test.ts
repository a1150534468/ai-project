import { describe, it, expect, vi, beforeAll } from "vitest";
import { formatKbContext, buildKbContext } from "./dub-kb-context.js";

// loadEmbeddingConfig 缺 env 会抛错→被降级 catch 吞掉，须先配好才能测到真实检索路径
beforeAll(() => {
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.EMBEDDING_MODEL ??= "test-embedding-model";
});

describe("formatKbContext", () => {
  it("无命中返回 null", () => {
    expect(formatKbContext([])).toBeNull();
  });
  it("命中拼成参考资料串并截断长内容", () => {
    const s = formatKbContext([{ docName: "手册", ordinal: 1, content: "a".repeat(300), score: 0.9 } as any]);
    expect(s).toContain("参考资料");
    expect(s).toContain("手册#1");
    expect(s).toContain("...");
  });
});

describe("buildKbContext", () => {
  it("kbIds 为空直接返回 null，不 embed 不检索", async () => {
    const embed = vi.fn(); const retrieve = vi.fn();
    const r = await buildKbContext({ prisma: {} as any, billing: {} as any, userId: "u1", kbIds: [], query: "x", embedFn: embed, retrieveFn: retrieve, resolveFn: vi.fn().mockResolvedValue([]) });
    expect(r).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("有有效库：embed→检索→拼串", async () => {
    const embed = vi.fn().mockResolvedValue({ vector: [1, 2, 3] });
    const retrieve = vi.fn().mockResolvedValue([{ docName: "d", ordinal: 1, content: "内容", score: 0.9 }]);
    const resolve = vi.fn().mockResolvedValue(["kb1"]);
    const r = await buildKbContext({ prisma: {} as any, billing: {} as any, userId: "u1", kbIds: ["kb1"], query: "查询", embedFn: embed, retrieveFn: retrieve, resolveFn: resolve });
    expect(embed).toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith(expect.anything(), ["kb1"], [1, 2, 3], expect.any(Number));
    expect(r).toContain("d#1");
  });

  it("有效库为空（越权/不存在）返回 null，不 embed", async () => {
    const embed = vi.fn();
    const resolve = vi.fn().mockResolvedValue([]);
    const r = await buildKbContext({ prisma: {} as any, billing: {} as any, userId: "u1", kbIds: ["notmine"], query: "q", embedFn: embed, retrieveFn: vi.fn(), resolveFn: resolve });
    expect(r).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("检索抛错时降级返回 null（不阻断洗稿）", async () => {
    const embed = vi.fn().mockResolvedValue({ vector: [1] });
    const retrieve = vi.fn().mockRejectedValue(new Error("kb down"));
    const resolve = vi.fn().mockResolvedValue(["kb1"]);
    const r = await buildKbContext({ prisma: {} as any, billing: {} as any, userId: "u1", kbIds: ["kb1"], query: "q", embedFn: embed, retrieveFn: retrieve, resolveFn: resolve });
    expect(r).toBeNull();
  });
});
