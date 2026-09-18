import { describe, expect, it } from "vitest";
import { ApiError } from "../../apiError";
import {
  ECOM_MAIN_RATIO_OPTIONS,
  ECOM_MAIN_RESOLUTION_OPTIONS,
  ECOM_MAIN_SIZE_TABLE,
  ECOM_MAIN_STYLE_OPTIONS,
  ECOM_MAIN_COUNT_OPTIONS,
  allowedEcomMainResolutions,
  buildCreateMainPayload,
  coerceEcomMainResolution,
  ecomMainImageSize,
  estimateMainPointCost,
  formatEcomMainError,
  isEcomMainResolutionBlocked,
  isEcomMainSizeSupported,
  isMainJobGenerating,
} from "./ecomMainImageModel";
import type { EcomMainRatio, EcomMainResolution } from "../../workflowEcomMainApi";
import type { ImageModel } from "../../workflowState";

describe("ecomMainImageModel", () => {
  it("选项常量非空且含关键值", () => {
    expect(ECOM_MAIN_RATIO_OPTIONS.map((o) => o.value)).toContain("1:1");
    expect(ECOM_MAIN_STYLE_OPTIONS.map((o) => o.value)).toContain("custom");
    expect(ECOM_MAIN_COUNT_OPTIONS).toHaveLength(8);
    expect(ECOM_MAIN_RESOLUTION_OPTIONS.map((o) => o.value)).toEqual(["1K", "2K"]);
  });
  it("payload：卖点按行拆分、去空、trim，并带上所选模型", () => {
    const payload = buildCreateMainPayload({
      platformId: "tmall", ratio: "1:1", resolution: "2K", model: "gpt-image-2", style: "amazon_clean", customStyle: "", withText: false,
      productName: " 咖啡机 ", category: "厨房", sellingPointsInput: "紧凑\n\n 大水箱 ", extra: "", referenceAssetIds: ["a"], count: 3,
    });
    expect(payload.product.name).toBe("咖啡机");
    expect(payload.product.sellingPoints).toEqual(["紧凑", "大水箱"]);
    expect(payload.count).toBe(3);
    expect(payload.withText).toBe(false);
    expect(payload.referenceAssetIds).toEqual(["a"]);
    expect(payload.model).toBe("gpt-image-2");
  });
  it("qwen 屏蔽 4K：档位判定与自动回落（未来 UI 开放 4K 也保持拦截）", () => {
    expect(isEcomMainResolutionBlocked("qwen-image-2.0-pro-2026-04-22", "4K")).toBe(true);
    expect(isEcomMainResolutionBlocked("qwen-image-2.0-pro-2026-04-22", "2K")).toBe(false);
    expect(isEcomMainResolutionBlocked("gpt-image-2", "4K")).toBe(false);
    expect(isEcomMainResolutionBlocked("doubao-seedream-4-5-251128", "4K")).toBe(false);
    expect(isEcomMainResolutionBlocked(null, "4K")).toBe(false);
    expect(coerceEcomMainResolution("qwen-image-2.0-pro-2026-04-22", "4K")).toBe("2K");
    expect(coerceEcomMainResolution("qwen-image-2.0-pro-2026-04-22", "1K")).toBe("1K");
    expect(coerceEcomMainResolution("gpt-image-2", "4K")).toBe("4K");
  });
  it("payload 构建时把 qwen 的 4K 档位回落到 2K", () => {
    const payload = buildCreateMainPayload({
      platformId: "tmall", ratio: "1:1", resolution: "4K", model: "qwen-image-2.0-pro-2026-04-22", style: "amazon_clean", customStyle: "", withText: true,
      productName: "咖啡机", category: "厨房", sellingPointsInput: "", extra: "", referenceAssetIds: [], count: 1,
    });
    expect(payload.resolution).toBe("2K");
    expect(payload.model).toBe("qwen-image-2.0-pro-2026-04-22");
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

describe("主图尺寸门禁（与服务端 ecom-resolution 规则一致）", () => {
  const ratios = Object.keys(ECOM_MAIN_SIZE_TABLE) as EcomMainRatio[];
  const resolutions: readonly EcomMainResolution[] = ["1K", "2K", "4K"];
  // 期望矩阵按服务端规则手算：gpt-image-2 要求宽高被 16 整除、像素在 [655360, 8294400]、长边 ≤3840、宽高比 ≤3；qwen 要求像素 ≤2048×2048。
  const expected: Record<EcomMainRatio, Record<EcomMainResolution, { gpt: boolean; qwen: boolean }>> = {
    "1:1": { "1K": { gpt: true, qwen: true }, "2K": { gpt: true, qwen: true }, "4K": { gpt: true, qwen: false } },
    "3:4": { "1K": { gpt: true, qwen: true }, "2K": { gpt: true, qwen: true }, "4K": { gpt: true, qwen: false } },
    "4:5": { "1K": { gpt: true, qwen: true }, "2K": { gpt: true, qwen: true }, "4K": { gpt: true, qwen: false } },
    "16:9": { "1K": { gpt: true, qwen: true }, "2K": { gpt: false, qwen: true }, "4K": { gpt: false, qwen: false } },
    "9:16": { "1K": { gpt: true, qwen: true }, "2K": { gpt: false, qwen: true }, "4K": { gpt: false, qwen: false } },
  };

  it("尺寸表与服务端 SIZE_TABLE 同形：每个比例都有三档尺寸", () => {
    for (const ratio of ratios) {
      for (const resolution of resolutions) {
        expect(ecomMainImageSize(ratio, resolution)).toMatch(/^\d+x\d+$/);
      }
    }
  });

  it("逐个比例 × 清晰度 × 模型判定尺寸是否被支持", () => {
    for (const ratio of ratios) {
      for (const resolution of resolutions) {
        const size = ecomMainImageSize(ratio, resolution);
        const want = expected[ratio][resolution];
        expect({ ratio, resolution, ok: isEcomMainSizeSupported("gpt-image-2", size) })
          .toEqual({ ratio, resolution, ok: want.gpt });
        expect({ ratio, resolution, ok: isEcomMainSizeSupported("qwen-image-2.0-pro-2026-04-22", size) })
          .toEqual({ ratio, resolution, ok: want.qwen });
        // 未纳入门禁的模型与「默认模型」交给服务端判定，前端不拦
        expect(isEcomMainSizeSupported("doubao-seedream-4-5-251128", size)).toBe(true);
        expect(isEcomMainSizeSupported(null, size)).toBe(true);
      }
    }
  });

  it("isEcomMainResolutionBlocked 与尺寸判定互为反向", () => {
    const models: readonly (ImageModel | null)[] = [
      "gpt-image-2",
      "qwen-image-2.0-pro-2026-04-22",
      "doubao-seedream-4-5-251128",
      null,
    ];
    for (const ratio of ratios) {
      for (const resolution of resolutions) {
        for (const model of models) {
          expect(isEcomMainResolutionBlocked(model, resolution, ratio))
            .toBe(!isEcomMainSizeSupported(model, ecomMainImageSize(ratio, resolution)));
        }
      }
    }
  });

  it("gpt-image-2 在 16:9 / 9:16 下只剩 1K（2K 的 1080 边不被 16 整除，服务端会 400）", () => {
    expect(allowedEcomMainResolutions("gpt-image-2", "16:9")).toEqual(["1K"]);
    expect(allowedEcomMainResolutions("gpt-image-2", "9:16")).toEqual(["1K"]);
    expect(allowedEcomMainResolutions("gpt-image-2", "1:1")).toEqual(["1K", "2K"]);
    expect(allowedEcomMainResolutions("qwen-image-2.0-pro-2026-04-22", "16:9")).toEqual(["1K", "2K"]);
    expect(allowedEcomMainResolutions(null, "16:9")).toEqual(["1K", "2K"]);
  });

  it("切到被屏蔽组合时清晰度自动回落到仍可用的最高档", () => {
    expect(coerceEcomMainResolution("gpt-image-2", "2K", "16:9")).toBe("1K");
    expect(coerceEcomMainResolution("gpt-image-2", "2K", "9:16")).toBe("1K");
    expect(coerceEcomMainResolution("gpt-image-2", "2K", "1:1")).toBe("2K");
    expect(coerceEcomMainResolution("gpt-image-2", "4K", "16:9")).toBe("1K");
    expect(coerceEcomMainResolution("qwen-image-2.0-pro-2026-04-22", "4K", "16:9")).toBe("2K");
    expect(coerceEcomMainResolution(null, "2K", "16:9")).toBe("2K");
  });

  it("UI 开放的每个比例 × 档位在任一模型下都不会构造出会被 400 的 payload", () => {
    const models: readonly ImageModel[] = ["gpt-image-2", "qwen-image-2.0-pro-2026-04-22", "doubao-seedream-4-5-251128"];
    for (const ratio of ratios) {
      for (const option of ECOM_MAIN_RESOLUTION_OPTIONS) {
        for (const model of models) {
          const payload = buildCreateMainPayload({
            platformId: "tmall", ratio, resolution: option.value, model, style: "amazon_clean", customStyle: "",
            withText: false, productName: "咖啡机", category: "厨房", sellingPointsInput: "", extra: "",
            referenceAssetIds: [], count: 1,
          });
          expect({ ratio, model, size: ecomMainImageSize(ratio, payload.resolution), ok: true })
            .toEqual({
              ratio,
              model,
              size: ecomMainImageSize(ratio, payload.resolution),
              ok: isEcomMainSizeSupported(model, ecomMainImageSize(ratio, payload.resolution)),
            });
        }
      }
    }
  });

  it("payload 构建时按比例回落：gpt-image-2 + 16:9 + 2K → 1K", () => {
    const payload = buildCreateMainPayload({
      platformId: "tmall", ratio: "16:9", resolution: "2K", model: "gpt-image-2", style: "amazon_clean", customStyle: "",
      withText: false, productName: "咖啡机", category: "厨房", sellingPointsInput: "", extra: "",
      referenceAssetIds: [], count: 1,
    });
    expect(payload.resolution).toBe("1K");
  });
});
