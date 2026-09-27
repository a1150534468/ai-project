import { describe, expect, it } from "vitest";
import { containRect, humanTierDimensions, parseTierSize, stripDataUrlPrefix } from "./nailMaskCanvas";

describe("parseTierSize", () => {
  it("解析「宽x高」为数字", () => {
    expect(parseTierSize("1728x2304")).toEqual({ width: 1728, height: 2304 });
    expect(parseTierSize("  1024x1024 ")).toEqual({ width: 1024, height: 1024 });
  });
  it("认不出或非正数返回 null", () => {
    expect(parseTierSize("1024")).toBeNull();
    expect(parseTierSize("0x100")).toBeNull();
    expect(parseTierSize("axb")).toBeNull();
  });
});

describe("containRect", () => {
  it("横图铺进方框：按宽约束，垂直居中，不裁任何一边", () => {
    expect(containRect(100, 50, 200, 200)).toEqual({ dx: 0, dy: 50, dw: 200, dh: 100 });
  });
  it("竖图铺进方框：按高约束，水平居中", () => {
    expect(containRect(50, 100, 200, 200)).toEqual({ dx: 50, dy: 0, dw: 100, dh: 200 });
  });
  it("源尺寸非法时铺满目标，避免除零", () => {
    expect(containRect(0, 0, 300, 400)).toEqual({ dx: 0, dy: 0, dw: 300, dh: 400 });
  });
});

describe("stripDataUrlPrefix", () => {
  it("去掉 data URL 前缀只留裸 b64", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,AAAB")).toBe("AAAB");
  });
  it("没有逗号时原样返回", () => {
    expect(stripDataUrlPrefix("AAAB")).toBe("AAAB");
  });
});

describe("humanTierDimensions", () => {
  it("命中档位表返回对应像素尺寸", () => {
    expect(humanTierDimensions("2K", "3:4")).toEqual({ width: 1728, height: 2304 });
    expect(humanTierDimensions("1K", "1:1")).toEqual({ width: 1024, height: 1024 });
    expect(humanTierDimensions("4K", "16:9")).toEqual({ width: 5504, height: 3040 });
  });
  it("认不出档位回落到 2K 方形，绝不返回 0", () => {
    expect(humanTierDimensions("8K" as never, "1:1")).toEqual({ width: 2048, height: 2048 });
  });
});
