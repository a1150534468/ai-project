import { describe, it, expect } from "vitest";
import { DIMENSIONS, MODE_BATCH, FANOUT_COUNTS, isFanoutDimensionId } from "./fanout-dimensions.js";

describe("fanout-dimensions", () => {
  it("每个非 SEO 维度都有枚举值和指令", () => {
    for (const [id, cfg] of Object.entries(DIMENSIONS)) {
      expect(cfg.instruction.length).toBeGreaterThan(0);
      if (id !== "seo") expect(cfg.values.length).toBeGreaterThan(0);
    }
  });
  it("每种模式都有正数 batchSize 与 maxOutputTokens", () => {
    for (const cfg of Object.values(MODE_BATCH)) {
      expect(cfg.batchSize).toBeGreaterThan(0);
      expect(cfg.maxOutputTokens).toBeGreaterThan(0);
    }
  });
  it("数量档为 10/30/50/100", () => {
    expect([...FANOUT_COUNTS]).toEqual([10, 30, 50, 100]);
  });
  it("isFanoutDimensionId 识别合法/非法", () => {
    expect(isFanoutDimensionId("platform")).toBe(true);
    expect(isFanoutDimensionId("nope")).toBe(false);
  });
});
