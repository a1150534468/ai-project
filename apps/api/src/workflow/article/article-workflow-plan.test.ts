import { articleWorkflowPlatformConfig } from "@ai-assistant/article-workflow";
import { describe, expect, it } from "vitest";
import { articleWorkflowTitleFromBody, normalizeArticleWorkflowPlan } from "./article-workflow-plan.js";

const wechat = articleWorkflowPlatformConfig("wechat");

function planWith(overrides: Partial<Parameters<typeof normalizeArticleWorkflowPlan>[0]["plan"]> = {}) {
  return {
    title: "定档消息",
    summary: "一句话摘要",
    bodyMarkdown: "第一段正文。\n\n第二段正文。",
    images: [
      { slot: "cover" as const, role: "cover" as const, alt: "封面", caption: "封面图", prompt: "cover prompt" },
    ],
    ...overrides,
  };
}

describe("articleWorkflowTitleFromBody", () => {
  it("取首个非空行并去掉 Markdown 标记", () => {
    expect(articleWorkflowTitleFromBody("\n\n## 小米新机定档\n\n正文", 120)).toBe("小米新机定档");
    expect(articleWorkflowTitleFromBody("> 引用起头的一行\n正文", 120)).toBe("引用起头的一行");
    expect(articleWorkflowTitleFromBody("- 列表起头的一行\n正文", 120)).toBe("列表起头的一行");
  });

  it("去掉结尾标点，标题不该带句号", () => {
    expect(articleWorkflowTitleFromBody("这是一句完整的话。\n\n后面还有", 120)).toBe("这是一句完整的话");
  });

  it("首行超长时在句读处收尾，不把标题截成半句", () => {
    const body = `${"一".repeat(12)}，${"二".repeat(40)}`;
    // limit 20 落在第二段中间，回退到第 12 字的逗号处
    expect(articleWorkflowTitleFromBody(body, 20)).toBe("一".repeat(12));
  });

  it("句读太靠前时宁可硬截，避免标题只剩两个字", () => {
    const body = `一，${"二".repeat(40)}`;
    // 逗号在第 1 字，不到 limit 的一半，硬截到 20 字
    expect(articleWorkflowTitleFromBody(body, 20)).toBe(`一，${"二".repeat(18)}`);
  });

  it("正文没有可用文字时返回空串，交给上层兜底", () => {
    expect(articleWorkflowTitleFromBody("\n\n   \n", 120)).toBe("");
    expect(articleWorkflowTitleFromBody("###", 120)).toBe("");
  });
});

describe("normalizeArticleWorkflowPlan", () => {
  it("title 为空时从正文兜一个，而不是整单失败", () => {
    // 回归：preserve-text 是默认模式，其提示词要求「不增删正文」，
    // 遇到无独立标题的纯正文素材，模型会交回空 title。
    // 此前 schema 的 min(1) 会让整单失败，用户白等一次生成。
    const result = normalizeArticleWorkflowPlan({
      plan: planWith({ title: "", bodyMarkdown: "小米澎程定档了\n\n更多细节在后面。" }),
      config: wechat,
    });
    expect(result.title).toBe("小米澎程定档了");
  });

  it("正文也兜不出标题时用占位名，保证 title 非空", () => {
    const result = normalizeArticleWorkflowPlan({
      plan: planWith({ title: "", bodyMarkdown: "###" }),
      config: wechat,
    });
    expect(result.title).toBe("未命名图文");
  });

  it("标题超出平台上限时截断", () => {
    const xiaohongshu = articleWorkflowPlatformConfig("xiaohongshu");
    const result = normalizeArticleWorkflowPlan({
      plan: planWith({ title: "标".repeat(50) }),
      config: xiaohongshu,
    });
    expect(result.title).toHaveLength(xiaohongshu.titleMaxLength);
  });

  it("模型给了标题就原样取用，只做去空格", () => {
    const result = normalizeArticleWorkflowPlan({
      plan: planWith({ title: "  定档消息  ", bodyMarkdown: "别的正文首行" }),
      config: wechat,
    });
    expect(result.title).toBe("定档消息");
  });

  it("首张强制 cover、其余按顺序补 inline，正文原样保留", () => {
    const result = normalizeArticleWorkflowPlan({
      plan: planWith({
        images: [
          { slot: "inline-3", role: "inline", alt: "a", caption: "", prompt: "p1" },
          { slot: "cover", role: "cover", alt: "b", caption: "", prompt: "p2" },
          { slot: "inline-1", role: "inline", alt: "c", caption: "", prompt: "p3" },
        ],
      }),
      config: wechat,
    });
    expect(result.images.map((image) => [image.slot, image.role])).toEqual([
      ["cover", "cover"],
      ["inline-1", "inline"],
      ["inline-2", "inline"],
    ]);
    expect(result.images.map((image) => image.prompt)).toEqual(["p1", "p2", "p3"]);
    expect(result.bodyMarkdown).toBe("第一段正文。\n\n第二段正文。");
  });

  it("超出平台图片上限的部分丢掉", () => {
    const images = Array.from({ length: 8 }, (_, index) => ({
      slot: "cover" as const,
      role: "cover" as const,
      alt: `a${index}`,
      caption: "",
      prompt: `p${index}`,
    }));
    const result = normalizeArticleWorkflowPlan({ plan: planWith({ images }), config: wechat });
    expect(result.images).toHaveLength(wechat.maxImages);
  });
});
