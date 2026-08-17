import { describe, expect, it } from "vitest";
import { buildTryOnPrompt } from "./try-on-prompts.js";

describe("buildTryOnPrompt", () => {
  it("labels garment references in order and generates a model when none is supplied", () => {
    const prompt = buildTryOnPrompt({
      aspectRatio: "3:4",
      hasGarmentDetail: true,
      hasModelReference: false,
      description: "短发女性，明亮影棚",
    });
    expect(prompt).toContain("参考图 1 是必须准确还原的服装正面图");
    expect(prompt).toContain("参考图 2 是同一件服装的背面或细节图");
    expect(prompt).toContain("创建一位自然、真实、适合展示该服装的单人模特");
    expect(prompt).toContain("补充描述：短发女性，明亮影棚");
    expect(prompt).toContain("画面比例：3:4");
    expect(prompt).not.toContain("锁定人物身份");
  });

  it("uses the final reference for identity and prioritizes garment fidelity", () => {
    const prompt = buildTryOnPrompt({ aspectRatio: "9:16", hasGarmentDetail: true, hasModelReference: true });
    expect(prompt).toContain("参考图 3 是模特人物图");
    expect(prompt).toContain("严格保持模特人物身份一致");
    expect(prompt).toContain("服装还原是最高优先级");
    expect(prompt).toContain("不要保留人物图里的原服装");
  });
});
