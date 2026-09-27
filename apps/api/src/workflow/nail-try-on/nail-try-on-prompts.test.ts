import { describe, expect, it } from "vitest";
import { buildNailTryOnPrompt, NAIL_TRY_ON_CONSENT_VERSION } from "./nail-try-on-prompts.js";

describe("buildNailTryOnPrompt", () => {
  it("always demands a hand-locked, mask-only local repaint", () => {
    const prompt = buildNailTryOnPrompt({ hasDesignReference: false });
    expect(prompt).toContain("局部重绘");
    expect(prompt).toContain("必须原样保留的底图");
    expect(prompt).toContain("只在蒙版标出的指甲区域作画");
    expect(prompt).toContain("严格保持手不变");
    // 无样式参考时给出兜底描述，且不引用不存在的参考图 2。
    expect(prompt).toContain("按补充描述生成");
    expect(prompt).not.toContain("参考图 2");
  });

  it("references the design image and fits the pattern per nail when a style is provided", () => {
    const prompt = buildNailTryOnPrompt({ hasDesignReference: true });
    expect(prompt).toContain("参考图 2 是美甲样式参考");
    expect(prompt).toContain("绝不改变手本身");
    expect(prompt).toContain("透视变形");
    expect(prompt).not.toContain("按补充描述生成");
  });

  it("appends a trimmed free-text description when supplied", () => {
    const prompt = buildNailTryOnPrompt({ hasDesignReference: false, description: "  法式渐变 + 珍珠  " });
    expect(prompt).toContain("美甲样式补充描述：法式渐变 + 珍珠");
    expect(prompt.endsWith("美甲样式补充描述：法式渐变 + 珍珠")).toBe(true);
  });

  it("omits the description line when the text is empty or whitespace", () => {
    const prompt = buildNailTryOnPrompt({ hasDesignReference: false, description: "   " });
    expect(prompt).not.toContain("美甲样式补充描述");
  });

  it("keeps the consent version stable", () => {
    expect(NAIL_TRY_ON_CONSENT_VERSION).toBe("nail-try-on-consent-v1");
  });
});
