import { describe, expect, it } from "vitest";
import {
  buildPortraitPrompt,
  LEGACY_PORTRAIT_PRESET_NAMES,
  PORTRAIT_MODEL,
  PORTRAIT_MODELS,
  PORTRAIT_PRESETS,
  portraitOutputSize,
} from "./portrait-prompts.js";

describe("portrait prompts", () => {
  it("ships 15 style presets plus custom with finish metadata", () => {
    expect(PORTRAIT_PRESETS).toHaveLength(16);
    expect(new Set(PORTRAIT_PRESETS.map((preset) => preset.id)).size).toBe(16);
    expect(PORTRAIT_PRESETS.at(-1)?.id).toBe("custom");
    expect(PORTRAIT_PRESETS.filter((preset) => preset.finish === "art").map((preset) => preset.id))
      .toEqual(["oil-painting", "ink-gongbi", "fairytale"]);
    expect(PORTRAIT_PRESETS.filter((preset) => preset.allowText).map((preset) => preset.id))
      .toEqual(["poster", "founder-ip"]);
    expect(PORTRAIT_PRESETS.every((preset) => preset.prompt.length > 0 && preset.name.length > 0)).toBe(true);
  });

  it("keeps legacy preset ids displayable for historical tasks", () => {
    expect(LEGACY_PORTRAIT_PRESET_NAMES).toEqual({
      business: "商务头像",
      social: "社交头像",
      lifestyle: "生活写真",
      traditional: "传统服饰",
    });
    // 历史 id 与在售 preset id 不重叠，前端回落查表不会覆盖当前预设名
    const currentIds = new Set<string>(PORTRAIT_PRESETS.map((preset) => preset.id));
    expect(Object.keys(LEGACY_PORTRAIT_PRESET_NAMES).filter((id) => currentIds.has(id))).toEqual([]);
  });

  it("builds a deterministic identity-preserving photo prompt from structured options", () => {
    const args = {
      presetId: "business-elite",
      aspectRatio: "3:4",
      options: {
        scene: "明亮办公室",
        outfit: "深灰色西装",
        expression: "自然微笑",
        extraPrompt: "柔和侧光",
      },
    } as const;
    const prompt = buildPortraitPrompt(args);

    expect(prompt).toContain("严格保持人物身份一致");
    expect(prompt).toContain("保持自然皮肤纹理");
    expect(prompt).toContain("画面中只出现这一位人物");
    expect(prompt).toContain("不添加文字、水印、Logo、边框或身份证件样式元素");
    expect(prompt).toContain("场景：明亮办公室");
    expect(prompt).toContain("服装：深灰色西装");
    expect(prompt).toContain("补充要求：柔和侧光");
    expect(prompt).toContain("画面比例：3:4");
    expect(prompt).toContain("成片应为可直接使用的高品质摄影作品");
    expect(prompt).not.toContain("undefined");
    expect(buildPortraitPrompt(args)).toBe(prompt);
  });

  it("switches to art wording for art presets while keeping identity constraints", () => {
    const prompt = buildPortraitPrompt({ presetId: "oil-painting", aspectRatio: "1:1", options: {} });

    expect(prompt).toContain("严格保持人物身份一致");
    expect(prompt).toContain("人物面部特征仍须与参考照片高度一致、可辨识");
    expect(prompt).toContain("允许绘画/动画风格化处理，画面完成度高");
    expect(prompt).not.toContain("保持自然皮肤纹理");
    expect(prompt).not.toContain("成片应为可直接使用的高品质摄影作品");
  });

  it("allows designed Chinese typography only for text-enabled presets", () => {
    const poster = buildPortraitPrompt({ presetId: "poster", aspectRatio: "3:4", options: {} });
    expect(poster).toContain("不添加水印、Logo 与证件样式元素，但允许按创作方向排版设计感中文文字");
    expect(poster).not.toContain("不添加文字、水印、Logo、边框或身份证件样式元素");

    const plain = buildPortraitPrompt({ presetId: "linkedin", aspectRatio: "1:1", options: {} });
    expect(plain).toContain("不添加文字、水印、Logo、边框或身份证件样式元素");
    expect(plain).not.toContain("允许按创作方向排版设计感中文文字");
  });

  it("exposes selectable models with 4K capability flags", () => {
    expect(PORTRAIT_MODELS.map((model) => model.value)).toEqual(["doubao-seedream-5-0-260128", "gpt-image-2"]);
    expect(PORTRAIT_MODELS.find((model) => model.value === "gpt-image-2")?.supports4K).toBe(false);
    expect(PORTRAIT_MODEL).toBe("doubao-seedream-5-0-260128");
  });

  it("maps Seedream ratios to supported 2K and 4K pixel sizes", () => {
    expect(portraitOutputSize("2K", "1:1")).toBe("2048x2048");
    expect(portraitOutputSize("2K", "9:16")).toBe("1600x2848");
    expect(portraitOutputSize("4K", "16:9")).toBe("5504x3040");
  });

  it("keeps every 1K size inside gpt-image-2 constraints", () => {
    const ratios = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
    for (const ratio of ratios) {
      const size = portraitOutputSize("1K", ratio);
      const [width, height] = size.split("x").map(Number);
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      // gpt-image-2 下限 655360 像素、长边 ≤3840、长短边比 ≤3
      expect(width * height).toBeGreaterThanOrEqual(655_360);
      expect(Math.max(width, height)).toBeLessThanOrEqual(3_840);
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);
      // 1K 档必须真的比 2K 小，否则计费档位与成片不匹配
      const [w2k, h2k] = portraitOutputSize("2K", ratio).split("x").map(Number);
      expect(width * height).toBeLessThan(w2k * h2k);
    }
  });

  it("marks 1K support per model so pricing tiers match delivered pixels", () => {
    expect(PORTRAIT_MODELS.find((model) => model.value === "gpt-image-2")?.supports1K).toBe(true);
    // 豆包上游会把 1K 请求提升到 2K 出图，开放该档会造成价差漏洞
    expect(PORTRAIT_MODELS.find((model) => model.value === "doubao-seedream-5-0-260128")?.supports1K).toBe(false);
  });
});
