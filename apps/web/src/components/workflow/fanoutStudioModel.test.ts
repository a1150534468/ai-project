import { describe, it, expect } from "vitest";
import {
  FANOUT_COUNT_OPTIONS, ENUM_DIMENSION_OPTIONS, MODE_OPTIONS, FANOUT_MIN_COUNT, FANOUT_MAX_COUNT,
  parseSellingPoints, formatSellingPoints, canGenerate, exportVariantsText, dedupAvailable, parseFanoutCount,
} from "./fanoutStudioModel";
import type { FanoutBrief } from "../../workflowFanoutApi";

const brief: FanoutBrief = { product: "AI助手", audience: "白领", sellingPoints: ["效率"], style: "口语", scene: "汇报" };

describe("fanoutStudioModel", () => {
  it("数量快捷档为 10/30/50/100", () => {
    expect(FANOUT_COUNT_OPTIONS.map((o) => o.value)).toEqual([10, 30, 50, 100]);
  });
  it("parseFanoutCount：合法整数返回 value", () => {
    expect(parseFanoutCount("7")).toEqual({ ok: true, value: 7 });
    expect(parseFanoutCount(` ${FANOUT_MIN_COUNT} `)).toEqual({ ok: true, value: FANOUT_MIN_COUNT });
    expect(parseFanoutCount(String(FANOUT_MAX_COUNT))).toEqual({ ok: true, value: FANOUT_MAX_COUNT });
  });
  it("parseFanoutCount：非整数/越界/空 返回错误", () => {
    expect(parseFanoutCount("").ok).toBe(false);
    expect(parseFanoutCount("abc").ok).toBe(false);
    expect(parseFanoutCount("3.5").ok).toBe(false);
    expect(parseFanoutCount("0").ok).toBe(false);
    expect(parseFanoutCount(String(FANOUT_MAX_COUNT + 1)).ok).toBe(false);
  });
  it("卖点输入解析：仅按换行分隔去空，保留行内标点（每行一个）", () => {
    expect(parseSellingPoints("效率、省钱\n 好看 ")).toEqual(["效率、省钱", "好看"]);
    expect(formatSellingPoints(["效率", "省钱"])).toBe("效率\n省钱");
  });
  it("卖点含中文逗号/顿号不被拆碎（回归：避免越过后端 max 条数）", () => {
    const points = [
      "客服AI自动应答，美工AI批量出图，投放AI自动监测；",
      "全域电商适用，客服、美工、投放三大场景全覆盖",
    ];
    expect(parseSellingPoints(formatSellingPoints(points))).toEqual(points);
  });
  it("canGenerate：enum 需 dimension，matrix/script 不需", () => {
    expect(canGenerate({ mode: "enum", brief, dimension: undefined })).toBe(false);
    expect(canGenerate({ mode: "enum", brief, dimension: "platform" })).toBe(true);
    expect(canGenerate({ mode: "matrix", brief, dimension: undefined })).toBe(true);
    expect(canGenerate({ mode: "enum", brief: { ...brief, product: "" }, dimension: "platform" })).toBe(false);
  });
  it("dedupAvailable：仅 enum 可切换", () => {
    expect(dedupAvailable("enum")).toBe(true);
    expect(dedupAvailable("matrix")).toBe(false);
    expect(dedupAvailable("script")).toBe(false);
  });
  it("导出文本：带标签分隔", () => {
    const txt = exportVariantsText([
      { id: "1", text: "文案A", label: "小红书", charCount: 3, similarity: 0, highSimilarity: false },
      { id: "2", text: "文案B", label: "抖音", charCount: 3, similarity: 0, highSimilarity: false },
    ]);
    expect(txt).toContain("【小红书】");
    expect(txt).toContain("文案A");
    expect(txt).toContain("文案B");
  });
  it("维度/模式选项非空", () => {
    expect(ENUM_DIMENSION_OPTIONS.length).toBeGreaterThan(0);
    expect(MODE_OPTIONS.length).toBe(3);
  });
});
