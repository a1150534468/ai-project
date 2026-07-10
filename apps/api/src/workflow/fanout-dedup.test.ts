import { describe, it, expect } from "vitest";
import { jaccard3gram, filterByDedup } from "./fanout-dedup.js";

describe("jaccard3gram", () => {
  it("完全相同返回 1", () => {
    expect(jaccard3gram("一分钟做好PPT", "一分钟做好PPT")).toBe(1);
  });
  it("完全不同返回接近 0", () => {
    expect(jaccard3gram("苹果香蕉橙子葡萄", "键盘鼠标屏幕主机")).toBeLessThan(0.1);
  });
  it("空串两两为 0，不抛错", () => {
    expect(jaccard3gram("", "")).toBe(0);
    expect(jaccard3gram("abc", "")).toBe(0);
  });
  it("短于 3 字用整串比对", () => {
    expect(jaccard3gram("ab", "ab")).toBe(1);
    expect(jaccard3gram("ab", "cd")).toBe(0);
  });
});

describe("filterByDedup", () => {
  it("阈值内的重复被丢弃，返回接受项与被丢弃项", () => {
    const texts = ["一分钟做好PPT", "一分钟做好PPT", "三分钟搞定领导要的汇报稿"];
    const { accepted, dropped } = filterByDedup(texts, [], 0.7);
    expect(accepted).toEqual(["一分钟做好PPT", "三分钟搞定领导要的汇报稿"]);
    expect(dropped).toEqual([1]); // 第 2 条与第 1 条重复
  });
  it("与已接受集合(seed)跨批比对", () => {
    const { accepted, dropped } = filterByDedup(["一分钟做好PPT"], ["一分钟做好PPT"], 0.7);
    expect(accepted).toEqual([]);
    expect(dropped).toEqual([0]);
  });
});
