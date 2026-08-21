import { describe, expect, it } from "vitest";
import { DELIVERED_TIER_TOLERANCE, deliveredImageResolution, minDeliveredPixels, pixelsFromSize } from "./image-delivered-tier.js";
import type { ImageResolutionLabel } from "./image-upstream-options.js";

// 形象照 3:4 三档的承诺像素，用来复现"请求 2K 实际只给 1.57MP"这个真实场景。
const portrait34: Record<ImageResolutionLabel, number> = {
  "1K": 864 * 1152,
  "2K": 1728 * 2304,
  "4K": 2784 * 3712,
};
const pixelsForPortrait34 = (resolution: ImageResolutionLabel) => portrait34[resolution];

describe("pixelsFromSize", () => {
  it("解析常规尺寸串", () => {
    expect(pixelsFromSize("1086x1448")).toBe(1_572_528);
    expect(pixelsFromSize(" 1024 X 1024 ")).toBe(1_048_576);
    expect(pixelsFromSize("1024×1536")).toBe(1_572_864);
  });

  it("解析不出来时返回 0 而不是抛错", () => {
    expect(pixelsFromSize("auto")).toBe(0);
    expect(pixelsFromSize("")).toBe(0);
    expect(pixelsFromSize(null)).toBe(0);
    expect(pixelsFromSize(undefined)).toBe(0);
    expect(pixelsFromSize("0x100")).toBe(0);
  });
});

describe("deliveredImageResolution", () => {
  it("请求 2K 但只交付 1.57MP 时降到 1K 结算", () => {
    expect(deliveredImageResolution({
      requested: "2K",
      deliveredPixels: 1086 * 1448,
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("1K");
  });

  it("请求 4K 只交付 1.57MP 时一路降到 1K", () => {
    expect(deliveredImageResolution({
      requested: "4K",
      deliveredPixels: 1086 * 1448,
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("1K");
  });

  it("真的交付了 2K 就按 2K 结算", () => {
    expect(deliveredImageResolution({
      requested: "2K",
      deliveredPixels: 1728 * 2304,
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("2K");
  });

  it("结算档位不会超过请求档位，上游多给像素也不多收钱", () => {
    expect(deliveredImageResolution({
      requested: "1K",
      deliveredPixels: 1448 * 1086,
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("1K");
  });

  it("差一点点（容差内）仍按该档结算", () => {
    const promised = portrait34["2K"];
    expect(deliveredImageResolution({
      requested: "2K",
      deliveredPixels: Math.ceil(promised * DELIVERED_TIER_TOLERANCE),
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("2K");
    expect(deliveredImageResolution({
      requested: "2K",
      deliveredPixels: Math.floor(promised * DELIVERED_TIER_TOLERANCE) - 1,
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("1K");
  });

  it("一张都没交付时原样返回请求档位，由调用方走退款", () => {
    expect(deliveredImageResolution({
      requested: "2K",
      deliveredPixels: 0,
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("2K");
  });

  it("档位承诺像素算不出来时保守停在该档，不乱降级", () => {
    expect(deliveredImageResolution({
      requested: "2K",
      deliveredPixels: 1086 * 1448,
      pixelsForResolution: () => 0,
    })).toBe("2K");
  });

  it("未知档位字符串原样返回", () => {
    expect(deliveredImageResolution({
      requested: "8K" as ImageResolutionLabel,
      deliveredPixels: 1086 * 1448,
      pixelsForResolution: pixelsForPortrait34,
    })).toBe("8K");
  });
});

describe("minDeliveredPixels", () => {
  it("按最小的那张算，宁可少收", () => {
    expect(minDeliveredPixels(["1728x2304", "1086x1448"])).toBe(1086 * 1448);
  });

  it("忽略解析不出来的条目", () => {
    expect(minDeliveredPixels(["auto", "1086x1448", null])).toBe(1086 * 1448);
  });

  it("全都解析不出来时返回 0", () => {
    expect(minDeliveredPixels(["auto", "", undefined])).toBe(0);
  });
});
