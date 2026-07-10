import { describe, expect, it } from "vitest";
import {
  ecomMainImageResourceKey,
  ecomMainImageSize,
  isEcomMainRatio,
  isEcomMainStyle,
  normalizeEcomMainResolution,
  ECOM_MAIN_RATIOS,
  ECOM_MAIN_STYLE_IDS,
} from "./ecom-main.js";

describe("ecom-main constants", () => {
  it("resource key 按清晰度归一化", () => {
    expect(ecomMainImageResourceKey("2K")).toBe("ecom_main_image_generation_2k");
    expect(ecomMainImageResourceKey("bad")).toBe("ecom_main_image_generation_1k");
    expect(ecomMainImageResourceKey(null)).toBe("ecom_main_image_generation_1k");
  });
  it("尺寸表覆盖全部比例×清晰度且为 WxH", () => {
    for (const ratio of ECOM_MAIN_RATIOS) {
      for (const res of ["1K", "2K", "4K"] as const) {
        expect(ecomMainImageSize(ratio, res)).toMatch(/^\d+x\d+$/);
      }
    }
    expect(ecomMainImageSize("1:1", "2K")).toBe("1536x1536");
  });
  it("类型守卫", () => {
    expect(isEcomMainRatio("16:9")).toBe(true);
    expect(isEcomMainRatio("2:2")).toBe(false);
    expect(isEcomMainStyle("custom")).toBe(true);
    expect(isEcomMainStyle("nope")).toBe(false);
    expect(ECOM_MAIN_STYLE_IDS).toContain("amazon_clean");
  });
  it("normalize 大小写不敏感", () => {
    expect(normalizeEcomMainResolution("2k")).toBe("2K");
  });
});
