import { describe, expect, it } from "vitest";
import { completedNovelChapterCount, nextNovelChapterIndex } from "./chapter-progress.js";

describe("novel chapter progress", () => {
  it("uses compact progress without requiring chapter prose", () => {
    expect(nextNovelChapterIndex([{ chapterIndex: 1, hasContent: true }, { chapterIndex: 2, hasContent: false }, { chapterIndex: 3, hasContent: true }])).toBe(2);
    expect(completedNovelChapterCount([{ chapterIndex: 1, hasContent: true }, { chapterIndex: 2, hasContent: true }])).toBe(2);
  });

  it("starts from chapter one for an empty book", () => {
    expect(nextNovelChapterIndex([])).toBe(1);
    expect(completedNovelChapterCount([])).toBe(0);
  });

  it("ignores planned empty chapters when locating the next chapter", () => {
    const chapters = Array.from({ length: 24 }, (_, index) => ({
      chapterIndex: index + 1,
      content: index === 0 ? "第一章正文" : "",
    }));
    expect(nextNovelChapterIndex(chapters)).toBe(2);
    expect(completedNovelChapterCount(chapters)).toBe(1);
  });

  it("does not let an accidentally completed future chapter hide an earlier gap", () => {
    expect(nextNovelChapterIndex([
      { chapterIndex: 1, content: "第一章" },
      { chapterIndex: 2, content: "" },
      { chapterIndex: 25, content: "错误生成的未来章节" },
    ])).toBe(2);
  });

  it("advances across a contiguous completed prefix", () => {
    expect(nextNovelChapterIndex([
      { chapterIndex: 3, content: "第三章" },
      { chapterIndex: 1, content: "第一章" },
      { chapterIndex: 2, content: "第二章" },
    ])).toBe(4);
  });

  it("continues a finished thirty-chapter book from chapter thirty-one", () => {
    const chapters = Array.from({ length: 30 }, (_, index) => ({
      chapterIndex: index + 1,
      content: `第 ${index + 1} 章正文`,
    }));
    expect(nextNovelChapterIndex(chapters)).toBe(31);
    expect(completedNovelChapterCount(chapters)).toBe(30);
  });
});
