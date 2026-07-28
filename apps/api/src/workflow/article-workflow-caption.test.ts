import { describe, expect, it } from "vitest";
import { articleWorkflowPlatformConfig } from "@ai-assistant/article-workflow";
import {
  articleWorkflowCaptionSummary,
  normalizeArticleWorkflowCaptionPlan,
} from "./article-workflow-caption.js";
import type { ArticleWorkflowCaptionPlan } from "./article-workflow-schema.js";

const xhs = articleWorkflowPlatformConfig("xiaohongshu");
const douyin = articleWorkflowPlatformConfig("douyin");

function plan(overrides?: Partial<ArticleWorkflowCaptionPlan>): ArticleWorkflowCaptionPlan {
  return {
    title: "夏天必备的冰咖啡",
    captionText: "第一段体验。\n第二段细节。",
    tags: ["咖啡", "夏日饮品", "居家好物"],
    images: [
      { slot: "cover", role: "cover", alt: "封面", caption: "", prompt: "cover prompt" },
      { slot: "inline-1", role: "inline", alt: "细节", caption: "", prompt: "detail prompt" },
    ],
    ...overrides,
  };
}

describe("normalizeArticleWorkflowCaptionPlan", () => {
  it("标题超过平台上限时截断而不抛错", () => {
    const result = normalizeArticleWorkflowCaptionPlan({
      plan: plan({ title: "一".repeat(40) }),
      config: xhs,
    });
    expect(result.title).toHaveLength(20);
  });

  it("正文超长时优先在换行处收尾", () => {
    const captionText = `${"甲".repeat(700)}\n${"乙".repeat(400)}`;
    const result = normalizeArticleWorkflowCaptionPlan({
      plan: plan({ captionText }),
      config: xhs,
    });
    expect(result.captionText).toBe("甲".repeat(700));
    expect(result.captionText.length).toBeLessThanOrEqual(xhs.captionMaxLength);
  });

  it("换行点太靠前时硬截，避免丢掉大半内容", () => {
    const captionText = `短开头\n${"丙".repeat(2000)}`;
    const result = normalizeArticleWorkflowCaptionPlan({
      plan: plan({ captionText }),
      config: xhs,
    });
    expect(result.captionText).toHaveLength(xhs.captionMaxLength);
  });

  it("标签去掉 # 号、去重并按平台上限截取", () => {
    const result = normalizeArticleWorkflowCaptionPlan({
      plan: plan({ tags: ["#咖啡", "咖啡", "##夏日", " 好物 ", "a", "b", "c", "d"] }),
      config: douyin,
    });
    expect(result.tags).toEqual(["咖啡", "夏日", "好物", "a", "b"]);
    expect(result.tags).toHaveLength(douyin.maxTags);
  });

  it("空标签与纯 # 号被丢弃", () => {
    const result = normalizeArticleWorkflowCaptionPlan({
      plan: plan({ tags: ["#", "  ", "有效标签"] }),
      config: xhs,
    });
    expect(result.tags).toEqual(["有效标签"]);
  });

  it("图片超量截取，并强制首张 cover、其余顺序 inline", () => {
    const result = normalizeArticleWorkflowCaptionPlan({
      plan: plan({
        images: Array.from({ length: 7 }, (_, index) => ({
          slot: "inline-2" as const,
          role: "inline" as const,
          alt: `图${index}`,
          caption: "",
          prompt: `prompt ${index}`,
        })),
      }),
      config: xhs,
    });
    expect(result.images).toHaveLength(5);
    expect(result.images.map((image) => image.slot))
      .toEqual(["cover", "inline-1", "inline-2", "inline-3", "inline-4"]);
    expect(result.images[0].role).toBe("cover");
    expect(result.images[1].role).toBe("inline");
  });

  it("未超限时内容原样保留", () => {
    const input = plan();
    const result = normalizeArticleWorkflowCaptionPlan({ plan: input, config: xhs });
    expect(result.title).toBe(input.title);
    expect(result.captionText).toBe(input.captionText);
    expect(result.tags).toEqual(input.tags);
  });
});

describe("articleWorkflowCaptionSummary", () => {
  it("取首个非空行", () => {
    expect(articleWorkflowCaptionSummary("\n\n第一段。\n第二段。")).toBe("第一段。");
  });

  it("首行超长时截到 100 字", () => {
    expect(articleWorkflowCaptionSummary("字".repeat(300))).toHaveLength(100);
  });

  it("空文案返回空串", () => {
    expect(articleWorkflowCaptionSummary("")).toBe("");
  });
});
