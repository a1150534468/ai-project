import { describe, expect, it } from "vitest";
import { normalizeNovelStorylineMilestones } from "./structured-sync.js";

describe("normalizeNovelStorylineMilestones", () => {
  it("deduplicates repeated model output that would violate the storyline milestone constraint", () => {
    expect(normalizeNovelStorylineMilestones([
      { chapterNumber: 10, title: "主角发现真相", description: "第一次" },
      { chapterNumber: 10, title: "主角发现真相", description: "重复项" },
      { chapterNumber: 10, title: "反派暴露弱点", description: "同章不同事件" },
    ], 100)).toEqual([
      { chapterNumber: 10, title: "主角发现真相", description: "第一次" },
      { chapterNumber: 10, title: "反派暴露弱点", description: "同章不同事件" },
    ]);
  });

  it("keeps generated chapter numbers inside the project range", () => {
    expect(normalizeNovelStorylineMilestones([
      { chapterNumber: 0, title: "开局" },
      { chapterNumber: 999, title: "终局" },
    ], 120).map((item) => item.chapterNumber)).toEqual([1, 120]);
  });

  it("preserves string milestones and distributes them across the book", () => {
    expect(normalizeNovelStorylineMilestones([
      "主角在锈带展露实力",
      "白盒圣所揭开真相",
      "云巅之城完成决战",
    ], 24)).toEqual([
      { chapterNumber: 6, title: "主角在锈带展露实力", description: "" },
      { chapterNumber: 12, title: "白盒圣所揭开真相", description: "" },
      { chapterNumber: 18, title: "云巅之城完成决战", description: "" },
    ]);
  });
});
