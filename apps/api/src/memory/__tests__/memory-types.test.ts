import { describe, expect, it } from "vitest";
import {
  buildMemoryTitle,
  clampImportance,
  memoryTextLength,
  mergeMemoryUpdate,
  normalizeMemoryType,
  normalizeTags,
  sanitizeMemoryShape,
} from "../memory-types.js";

const existing = {
  title: "职业",
  text: "用户是后端工程师",
  type: "CORE" as const,
  importance: 90,
  tags: ["工作"],
};

describe("memory-types", () => {
  it("非对象或没有正文就返回 null", () => {
    for (const value of [null, "x", 1, [], {}, { text: "   " }]) {
      expect(() => sanitizeMemoryShape(value)).not.toThrow();
      expect(sanitizeMemoryShape(value)).toBeNull();
    }
  });

  it("ADD 统一做 NFKC、缺省值、取整和范围收口", () => {
    expect(
      sanitizeMemoryShape({
        text: "  用户使用 ＴｙｐｅＳｃｒｉｐｔ  ",
        importance: 120.6,
        tags: ["　前端　", "前端", 1, ""],
      }),
    ).toEqual({
      title: "用户使用 TypeScript",
      text: "用户使用 TypeScript",
      type: "OTHER",
      importance: 100,
      tags: ["前端"],
    });
    expect(normalizeMemoryType("core")).toBe("OTHER");
    expect(clampImportance(Number.NaN)).toBe(50);
  });

  it("标签保序去重，最多八个，每个最多二十个码点", () => {
    const tags = normalizeTags([
      `${"甲".repeat(19)}😀尾巴`,
      "一",
      "二",
      "三",
      "四",
      "五",
      "六",
      "七",
      "八",
    ]);
    expect(tags).toHaveLength(8);
    expect(tags[0]).toBe(`${"甲".repeat(19)}😀`);
    expect(memoryTextLength(tags[0])).toBe(20);
  });

  it("收满八个标签后不再读取后续输入", () => {
    const tags: unknown[] = ["一", "二", "三", "四", "五", "六", "七", "八"];
    Object.defineProperty(tags, 8, {
      get() {
        throw new Error("不该读取第九项");
      },
    });
    tags.length = 9;

    expect(normalizeTags(tags)).toEqual(["一", "二", "三", "四", "五", "六", "七", "八"]);
  });

  it("标题和正文按码点截断，不制造半个 emoji", () => {
    const text = `${"a".repeat(1999)}😀尾`;
    const shape = sanitizeMemoryShape({ title: `${"题".repeat(39)}😀尾`, text });
    expect(shape?.text).toBe(`${"a".repeat(1999)}😀`);
    expect(shape?.title).toBe(`${"题".repeat(39)}😀`);
    expect(buildMemoryTitle("", "😀".repeat(41))).toBe("😀".repeat(40));
  });

  it("UPDATE 缺少字段表示保持，显式字段才覆盖", () => {
    expect(mergeMemoryUpdate(existing, { text: "用户现在是前端工程师" })).toEqual({
      ...existing,
      text: "用户现在是前端工程师",
    });
    expect(
      mergeMemoryUpdate(existing, {
        text: "用户现在是前端工程师",
        type: "PERMANENT",
        importance: 72,
        tags: ["新工作"],
      }),
    ).toMatchObject({ type: "PERMANENT", importance: 72, tags: ["新工作"] });
  });
});
