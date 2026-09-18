import { describe, expect, it } from "vitest";
import {
  buildProductExtractionPrompt,
  isGeneralImageRequestId,
  isProductExtractionRequestId,
  productDescriptionFromPrompt,
} from "./productExtractionWorkflowModel";

describe("productExtractionWorkflowModel", () => {
  it("builds a white-background flat-lay edit prompt while preserving the user's product details", () => {
    const prompt = buildProductExtractionPrompt("  黑色皮质单肩包，保留金色搭扣  ");

    expect(prompt).toContain("商品描述：黑色皮质单肩包，保留金色搭扣");
    expect(prompt).toContain("严格保持商品的造型、比例、颜色、材质");
    expect(prompt).toContain("正上方俯拍的平铺陈列视角");
    expect(prompt).toContain("纯白色（#FFFFFF）");
    expect(prompt).toContain("不要环境、地面纹理、道具、装饰、人物、手、模特");
    expect(productDescriptionFromPrompt(prompt)).toBe("黑色皮质单肩包，保留金色搭扣");
  });

  it("keeps product extraction tasks out of the general image workspace", () => {
    expect(isProductExtractionRequestId("product-extract-12345678")).toBe(true);
    expect(isGeneralImageRequestId("product-extract-12345678")).toBe(false);
    expect(isGeneralImageRequestId("img-12345678")).toBe(true);
  });
});
