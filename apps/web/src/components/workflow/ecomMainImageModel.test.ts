import { describe, expect, it } from "vitest";
import { ApiError } from "../../apiError";
import {
  ECOM_MAIN_RATIO_OPTIONS,
  ECOM_MAIN_STYLE_OPTIONS,
  ECOM_MAIN_COUNT_OPTIONS,
  buildCreateMainPayload,
  estimateMainPointCost,
  formatEcomMainError,
  isMainJobGenerating,
} from "./ecomMainImageModel";

describe("ecomMainImageModel", () => {
  it("选项常量非空且含关键值", () => {
    expect(ECOM_MAIN_RATIO_OPTIONS.map((o) => o.value)).toContain("1:1");
    expect(ECOM_MAIN_STYLE_OPTIONS.map((o) => o.value)).toContain("custom");
    expect(ECOM_MAIN_COUNT_OPTIONS).toHaveLength(8);
  });
  it("payload：卖点按行拆分、去空、trim", () => {
    const payload = buildCreateMainPayload({
      platformId: "tmall", ratio: "1:1", resolution: "2K", style: "amazon_clean", customStyle: "", withText: false,
      productName: " 咖啡机 ", category: "厨房", sellingPointsInput: "紧凑\n\n 大水箱 ", extra: "", referenceAssetIds: ["a"], count: 3,
    });
    expect(payload.product.name).toBe("咖啡机");
    expect(payload.product.sellingPoints).toEqual(["紧凑", "大水箱"]);
    expect(payload.count).toBe(3);
    expect(payload.withText).toBe(false);
    expect(payload.referenceAssetIds).toEqual(["a"]);
  });
  it("预估点数 = 单张费率 × 张数", () => {
    expect(estimateMainPointCost(20, 4)).toBe(80);
    expect(estimateMainPointCost(null, 4)).toBeNull();
  });
  it("402 → 积分不足", () => {
    expect(formatEcomMainError(new ApiError("x", 402), "兜底")).toBe("积分不足，请充值");
    expect(formatEcomMainError(new Error("boom"), "兜底")).toBe("boom");
    expect(formatEcomMainError("weird", "兜底")).toBe("兜底");
  });
  it("生成中判断", () => {
    expect(isMainJobGenerating("running")).toBe(true);
    expect(isMainJobGenerating("ready")).toBe(false);
  });
});
