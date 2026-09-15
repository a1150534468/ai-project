import { describe, expect, it, vi } from "vitest";
import { buildNovelVectorQuery, formatNovelVectorMemoryContext } from "./novel-vector-memory.js";
import { deleteNovelVectors, findNearestNovelVectors } from "./novel-vector-store.js";
import type { NovelVectorStore } from "./novel-vector-types.js";

function rawStore() {
  return {
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(async () => 1),
  } as unknown as NovelVectorStore;
}

describe("novel vector memory", () => {
  it("builds a compact chapter query without empty fields", () => {
    expect(buildNovelVectorQuery({
      projectTitle: "寒泉烬",
      genre: "",
      chapterIndex: 3,
      chapterTitle: "旧院",
      chapterSummary: "发现密室",
    })).toBe("项目：寒泉烬\n章节序号：第 3 章\n章节标题：旧院\n章节目标：发现密室");
  });

  it("clips recalled Unicode text by characters", () => {
    const context = formatNovelVectorMemoryContext([{
      id: "v1",
      sourceType: "chapter",
      sourceId: "c1",
      sourceKind: "chapter:1",
      title: "第一章",
      content: `线索 ${"火".repeat(800)}`,
      score: 0.91,
    }]);
    expect(context).toContain("【第一章】");
    expect(context).toContain("...");
    expect(context.length).toBeLessThan(800);
  });

  it("bounds retrieval and converts database scores to numbers", async () => {
    const store = rawStore();
    vi.mocked(store.$queryRawUnsafe).mockResolvedValue([{
      id: "v1",
      sourceType: "bible",
      sourceId: "p1",
      sourceKind: "story-contract",
      title: "设定",
      content: "规则",
      score: "0.75",
    }]);

    const rows = await findNearestNovelVectors({ store, projectId: "p1", vector: [0.1, 0.2], limit: 99 });

    expect(rows[0]?.score).toBe(0.75);
    expect(vi.mocked(store.$queryRawUnsafe).mock.calls[0]?.slice(1)).toEqual([
      "[0.1,0.2]", "p1", "", 8,
    ]);
  });

  it("deletes only explicit project rows and skips an empty deletion", async () => {
    const store = rawStore();
    await deleteNovelVectors(store, "p1", []);
    expect(store.$executeRawUnsafe).not.toHaveBeenCalled();

    await deleteNovelVectors(store, "p1", ["v1", "v2"]);
    expect(vi.mocked(store.$executeRawUnsafe).mock.calls[0]?.slice(1)).toEqual(["p1", "v1", "v2"]);
  });
});
