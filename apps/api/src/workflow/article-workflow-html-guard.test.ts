import { describe, expect, it } from "vitest";
import { assertArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";

describe("article-workflow html guard", () => {
  it("accepts wechat-safe fragment html", () => {
    const html = [
      '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
      '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">开头第一段。</p>',
      '<section data-ai-assistant-image-slot="cover"></section>',
      '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">第二段继续说明。</p>',
      "</section>",
    ].join("");

    expect(assertArticleWorkflowHtmlFragment({
      html,
      expectedVisibleText: "开头第一段。\n第二段继续说明。",
      requiredImageSlots: ["cover"],
    })).toContain('data-ai-assistant-image-slot="cover"');
  });

  it("rejects blacklisted tags and changed visible text", () => {
    expect(() => assertArticleWorkflowHtmlFragment({
      html: "<script>alert(1)</script>",
      expectedVisibleText: "",
    })).toThrow("不支持的标签");

    expect(() => assertArticleWorkflowHtmlFragment({
      html: '<p style="font-size:16px;">改写后的正文</p>',
      expectedVisibleText: "原始正文",
    })).toThrow("可见文字与预期内容不一致");
  });
});
