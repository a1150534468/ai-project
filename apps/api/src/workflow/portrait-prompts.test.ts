import { describe, expect, it } from "vitest";
import { buildPortraitPrompt, portraitOutputSize } from "./portrait-prompts.js";

describe("portrait prompts", () => {
  it("builds a deterministic identity-preserving prompt from structured options", () => {
    const prompt = buildPortraitPrompt({
      presetId: "business",
      aspectRatio: "3:4",
      options: {
        scene: "明亮办公室",
        outfit: "深灰色西装",
        expression: "自然微笑",
        extraPrompt: "柔和侧光",
      },
    });

    expect(prompt).toContain("严格保持人物身份一致");
    expect(prompt).toContain("画面中只出现这一位人物");
    expect(prompt).toContain("场景：明亮办公室");
    expect(prompt).toContain("服装：深灰色西装");
    expect(prompt).toContain("补充要求：柔和侧光");
    expect(prompt).toContain("画面比例：3:4");
    expect(prompt).not.toContain("undefined");
  });

  it("maps Seedream 5.0 Lite ratios to supported 2K and 4K pixel sizes", () => {
    expect(portraitOutputSize("2K", "1:1")).toBe("2048x2048");
    expect(portraitOutputSize("2K", "9:16")).toBe("1600x2848");
    expect(portraitOutputSize("4K", "16:9")).toBe("5504x3040");
  });
});
