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
import { ecomModelSizeError, ecomSizeForResolution, isGptImageSizeSupported, isQwenImageSizeSupported } from "./ecom-resolution.js";

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

describe("按模型的尺寸门禁（主图尺寸表 × 详情图三档）", () => {
  const QWEN = "qwen-image-2.0-pro-2026-04-22";
  const GPT = "gpt-image-2";

  it("qwen：1K/2K 全部放行，4K 全部拒绝并给出切换提示", () => {
    for (const ratio of ECOM_MAIN_RATIOS) {
      expect(isQwenImageSizeSupported(ecomMainImageSize(ratio, "1K"))).toBe(true);
      expect(isQwenImageSizeSupported(ecomMainImageSize(ratio, "2K"))).toBe(true);
      expect(ecomModelSizeError(QWEN, ecomMainImageSize(ratio, "4K"))).toBe("Qwen 模型最高支持 2K，请切换清晰度或模型");
    }
    expect(ecomModelSizeError(QWEN, ecomSizeForResolution("2K"))).toBeNull();
    expect(ecomModelSizeError(QWEN, ecomSizeForResolution("4K"))).toBe("Qwen 模型最高支持 2K，请切换清晰度或模型");
  });

  it("gpt-image-2：仅 16:9/9:16 的 2K/4K（非 16 倍数）拒绝，详情图三档全放行", () => {
    for (const ratio of ECOM_MAIN_RATIOS) {
      for (const res of ["1K", "2K", "4K"] as const) {
        const size = ecomMainImageSize(ratio, res);
        const expected = !((ratio === "16:9" || ratio === "9:16") && res !== "1K");
        expect(isGptImageSizeSupported(size), `${ratio} ${res} ${size}`).toBe(expected);
      }
    }
    for (const res of ["1K", "2K", "4K"] as const) {
      expect(ecomModelSizeError(GPT, ecomSizeForResolution(res))).toBeNull();
    }
    expect(ecomModelSizeError(GPT, "1920x1080", "该比例可选清晰度：1K")).toBe("GPT Image 2 不支持尺寸 1920x1080，该比例可选清晰度：1K");
  });

  it("model 缺省或豆包直接放行", () => {
    expect(ecomModelSizeError(null, "9999x9999")).toBeNull();
    expect(ecomModelSizeError(undefined, "9999x9999")).toBeNull();
    expect(ecomModelSizeError("doubao-seedream-4-5-251128", ecomMainImageSize("1:1", "4K"))).toBeNull();
  });
});
