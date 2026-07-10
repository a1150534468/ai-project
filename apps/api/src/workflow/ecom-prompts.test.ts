import { describe, expect, it } from "vitest";
import {
  ECOM_PLATFORMS,
  ECOM_TEMPLATES,
  buildEcomPrompt,
  getEcomPlatform,
  getEcomTemplate,
} from "./ecom-prompts.js";

type BuildInput = Parameters<typeof buildEcomPrompt>[0];

const DOMESTIC_PLATFORM_IDS = ["taobao", "tmall", "jd", "pdd", "xianyu"] as const;
const FOREIGN_PLATFORM_IDS = ["amazon", "ebay", "etsy", "shopee", "lazada", "shopify"] as const;
const TEMPLATE_IDS = ["general", "premium", "digital", "beauty", "food", "gift", "apparel", "home"] as const;

function createDomesticInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    platformId: "taobao",
    templateId: "general",
    kind: "master",
    name: "陶瓷餐盘",
    category: "餐厨用品",
    sellingPoints: ["高温釉下彩", "耐刮耐洗", "适合礼赠"],
    extra: "画面突出整套餐具与餐桌场景。",
    ...overrides,
  };
}

function createForeignInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    platformId: "amazon",
    templateId: "digital",
    kind: "segment",
    segmentIndex: 1,
    name: "无线降噪耳机",
    category: "Audio",
    sellingPoints: ["40mm drivers", "ANC", "USB-C fast charging"],
    extra: "Highlight commute and work scenarios.",
    ...overrides,
  };
}

function expectContains(prompt: string, snippets: readonly string[]): void {
  for (const snippet of snippets) expect(prompt).toContain(snippet);
}

function expectOmits(prompt: string, snippets: readonly string[]): void {
  for (const snippet of snippets) expect(prompt).not.toContain(snippet);
}

describe("ecom prompts", () => {
  it("groups platforms by market and returns null for unknown ids", () => {
    expect(ECOM_PLATFORMS.filter((platform) => platform.market === "domestic").map((platform) => platform.id)).toEqual(
      DOMESTIC_PLATFORM_IDS,
    );
    expect(ECOM_PLATFORMS.filter((platform) => platform.market === "foreign").map((platform) => platform.id)).toEqual(
      FOREIGN_PLATFORM_IDS,
    );

    for (const id of DOMESTIC_PLATFORM_IDS) expect(getEcomPlatform(id)?.market).toBe("domestic");
    for (const id of FOREIGN_PLATFORM_IDS) expect(getEcomPlatform(id)?.market).toBe("foreign");
    expect(getEcomPlatform("unknown")).toBeNull();
  });

  it("contains all eight templates and returns null for invalid template ids", () => {
    expect(ECOM_TEMPLATES.map((template) => template.id)).toEqual(TEMPLATE_IDS);
    expect(getEcomTemplate("beauty")).toEqual({
      id: "beauty",
      name: "美妆护肤成分模板",
      tag: "功效型",
      style: "清透、专业、成分可信，水润质感",
      master: "清透功效首屏、水润质感、明亮背景",
      segments: ["功效首屏", "成分说明 + 使用步骤", "肤感场景"],
    });
    expect(getEcomTemplate("missing")).toBeNull();
  });

  it("builds domestic master prompts with Chinese copy rules and product details", () => {
    expectContains(buildEcomPrompt(createDomesticInput()), [
      "平台：淘宝",
      "中文海报文案规则",
      "模板风格：干净、真实、转化导向，浅色背景",
      "主视觉要求：干净电商主视觉、商品居中、白底或浅渐变",
      "商品名称：陶瓷餐盘",
      "商品类目：餐厨用品",
      "卖点：高温釉下彩；耐刮耐洗；适合礼赠",
      "补充信息：画面突出整套餐具与餐桌场景。",
    ]);
  });

  it("builds foreign segment prompts with English-only copy rules and chosen segment focus", () => {
    expectContains(buildEcomPrompt(createForeignInput()), [
      "Platform: Amazon",
      "English-only poster copy instruction",
      "Template style: 科技、参数、性能感，冷色光效",
      "Segment name: Segment 2 of 3 - Feature breakdown",
      "Segment focus: 核心参数 + 功能拆解",
      "Single-slice task: Create only segment 2",
      "Anti-duplication rule: Do not repeat segment 1's main headline",
      "Product name: 无线降噪耳机",
      "Category: Audio",
      "Selling points: 40mm drivers; ANC; USB-C fast charging",
      "Extra context: Highlight commute and work scenarios.",
    ]);
  });

  it("builds distinct domestic single-slice prompts for every long-image segment", () => {
    const prompts = ([0, 1, 2] as const).map((segmentIndex) =>
      buildEcomPrompt(createDomesticInput({ templateId: "digital", kind: "segment", segmentIndex })),
    );

    expect(new Set(prompts).size).toBe(3);
    expectContains(prompts[0], [
      "分段名称：第 1 段（共 3 段）「首屏」",
      "分段焦点：科技主视觉",
      "只生成详情页第 1 段首屏切片",
      "不要把母版整张照抄",
    ]);
    expectContains(prompts[1], [
      "分段名称：第 2 段（共 3 段）「中段」",
      "分段焦点：核心参数 + 功能拆解",
      "只生成详情页第 2 段中段切片",
      "不要重复第 1 段的大标题",
      "多中段区别：本段为中段之一",
    ]);
    expectContains(prompts[2], [
      "分段名称：第 3 段（共 3 段）「尾段」",
      "分段焦点：场景体验",
      "只生成详情页第 3 段尾段切片",
      "不要重复前两段的主视觉大图",
    ]);
    for (const prompt of prompts) {
      expectContains(prompt, ["输出必须是一张单段竖版切片", "构图与内容必须和母版及相邻分段明显不同", "约 1/3"]);
    }
  });

  it("throws a clear error when segment index is outside the supported range", () => {
    for (const segmentIndex of [-1, 3] as const) {
      expect(() => buildEcomPrompt(createForeignInput({ segmentIndex }))).toThrow();
    }
  });

  it("omits blank product fields instead of rendering empty label lines", () => {
    const prompt = buildEcomPrompt(
      createDomesticInput({
        name: "   ",
        category: "",
        sellingPoints: ["  ", "耐高温", ""],
        extra: "   ",
      }),
    );

    expectContains(prompt, ["卖点：耐高温"]);
    expectOmits(prompt, ["商品名称：", "商品类目：", "补充信息：", "undefined"]);
  });

  it("uses localized fallback notices when every product field is blank", () => {
    const cases = [
      {
        prompt: buildEcomPrompt(
          createDomesticInput({ name: " ", category: " ", sellingPoints: [" ", "  "], extra: " " }),
        ),
        expected: "商品信息未提供，避免编造未经提供的具体参数或功效",
      },
      {
        prompt: buildEcomPrompt(
          createForeignInput({
            kind: "master",
            segmentIndex: 0,
            name: " ",
            category: " ",
            sellingPoints: [" "],
            extra: " ",
          }),
        ),
        expected: "Product information was not provided; avoid inventing unsupported specifications or claims.",
      },
    ] as const;

    for (const testCase of cases) {
      expectContains(testCase.prompt, [testCase.expected]);
      expectOmits(testCase.prompt, [
        "商品名称：",
        "商品类目：",
        "卖点：",
        "补充信息：",
        "Product name:",
        "Category:",
        "Selling points:",
        "Extra context:",
        "undefined",
      ]);
    }
  });

  it("throws for invalid platform or template ids when building prompts", () => {
    const cases = [
      {
        input: createDomesticInput({ platformId: "unknown" }),
        error: "Unknown e-commerce platform: unknown",
      },
      {
        input: createDomesticInput({ templateId: "missing" }),
        error: "Unknown e-commerce template: missing",
      },
    ] as const;

    for (const testCase of cases) {
      expect(() => buildEcomPrompt(testCase.input)).toThrow(testCase.error);
    }
  });

  it("supports variable segment counts with correct role mapping", () => {
    const prompts = ([0, 2, 4] as const).map((segmentIndex) =>
      buildEcomPrompt(createDomesticInput({ templateId: "digital", kind: "segment", segmentIndex, segmentCount: 5 })),
    );

    expect(new Set(prompts).size).toBe(3);
    expectContains(prompts[0], [
      "分段名称：第 1 段（共 5 段）「首屏」",
      "分段焦点：科技主视觉",
      "只生成详情页第 1 段首屏切片",
    ]);
    expectContains(prompts[1], [
      "分段名称：第 3 段（共 5 段）「中段」",
      "分段焦点：核心参数 + 功能拆解",
      "只生成详情页第 2 段中段切片",
      "多中段区别：本段为中段之一，构图/卖点角度必须与其它中段明显不同。",
    ]);
    expectContains(prompts[2], [
      "分段名称：第 5 段（共 5 段）「尾段」",
      "分段焦点：场景体验",
      "只生成详情页第 3 段尾段切片",
    ]);
    for (const prompt of prompts) {
      expectContains(prompt, ["约 1/5", "构图与内容必须和母版及相邻分段明显不同"]);
    }
  });
});
