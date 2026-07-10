import { describe, expect, it } from "vitest";
import { buildEcomMainImagePrompt } from "./ecom-main-prompts.js";

const product = { name: "家用意式咖啡机", category: "厨房电器", sellingPoints: ["1.2L 可拆卸水箱", "紧凑机身"], extra: "适合家庭办公室" };

describe("buildEcomMainImagePrompt", () => {
  it("index 0 主图：融入核心卖点，出图 prompt 含卖点文本", () => {
    const r = buildEcomMainImagePrompt({ platformId: "tmall", language: "zh", ratio: "1:1", style: "amazon_clean", customStyle: "", product, index: 0 });
    expect(r.theme).toContain("主图");
    expect(r.theme).toContain("卖点");
    expect(r.sceneRequirement).toContain("1:1");
    expect(r.sceneRequirement).toContain("1.2L 可拆卸水箱");
    expect(r.copyRequirement).toContain("中文");
    expect(r.prompt).toContain("1.2L 可拆卸水箱");
    expect(r.prompt.toLowerCase()).toContain("callout");
  });
  it("index>0 是辅图并绑定某个卖点", () => {
    const r = buildEcomMainImagePrompt({ platformId: "tmall", language: "zh", ratio: "3:4", style: "infographic", customStyle: "", product, index: 1 });
    expect(r.theme).toContain("辅图");
    expect(r.prompt).toContain("1.2L");
  });
  it("卖点多(>4)时主图控制密度只突出重点", () => {
    const many = { name: "咖啡机", category: "厨房", sellingPoints: ["卖点一", "卖点二", "卖点三", "卖点四", "卖点五", "卖点六"], extra: "" };
    const r = buildEcomMainImagePrompt({ platformId: "tmall", language: "zh", ratio: "1:1", style: "amazon_clean", customStyle: "", product: many, index: 0 });
    expect(r.sceneRequirement).toContain("只突出最重要");
    // 角标只取前 4 条：场景要求不列第 5、6 条；出图 prompt 含密度控制指令
    expect(r.sceneRequirement).not.toContain("卖点五");
    expect(r.sceneRequirement).not.toContain("卖点六");
    expect(r.prompt.toLowerCase()).toContain("feature only the 3-4 most important");
  });
  it("custom 风格用 customStyle 文本", () => {
    const r = buildEcomMainImagePrompt({ platformId: "amazon", language: "en", ratio: "1:1", style: "custom", customStyle: "cyberpunk neon", product, index: 0 });
    expect(r.prompt.toLowerCase()).toContain("cyberpunk neon");
    expect(r.copyRequirement).toContain("英文");
  });
  it("空卖点主图退回少字无字，不抛异常", () => {
    const r = buildEcomMainImagePrompt({ platformId: "tmall", language: "zh", ratio: "1:1", style: "premium_studio", customStyle: "", product: { name: "", category: "", sellingPoints: [], extra: "" }, index: 0 });
    expect(r.copyRequirement).toContain("少字或无字");
    expect(r.prompt.length).toBeGreaterThan(10);
  });
  it("无字模式：主图与辅图都不叠文字", () => {
    const hero = buildEcomMainImagePrompt({ platformId: "tmall", language: "zh", ratio: "1:1", style: "amazon_clean", customStyle: "", product, index: 0, withText: false });
    expect(hero.copyRequirement).toContain("无字模式");
    expect(hero.prompt.toLowerCase()).toContain("no text");
    expect(hero.prompt.toLowerCase()).not.toContain("callout");
    const sub = buildEcomMainImagePrompt({ platformId: "tmall", language: "zh", ratio: "3:4", style: "amazon_clean", customStyle: "", product, index: 1, withText: false });
    expect(sub.copyRequirement).toContain("无字模式");
    expect(sub.prompt.toLowerCase()).toContain("no text");
  });
  it("默认(不传 withText)=有字，主图仍融入卖点角标", () => {
    const hero = buildEcomMainImagePrompt({ platformId: "tmall", language: "zh", ratio: "1:1", style: "amazon_clean", customStyle: "", product, index: 0 });
    expect(hero.prompt.toLowerCase()).toContain("callout");
  });
});
