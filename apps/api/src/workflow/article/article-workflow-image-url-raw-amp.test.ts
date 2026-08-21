import { describe, expect, it } from "vitest";
import { assertArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";
import { articleWorkflowStableBodyHtml } from "./article-workflow-image-url.js";

/**
 * 编辑器把属性里的 `&amp;` 反序列化回裸 `&` 是常见行为，而正文保存要过一遍 XML 解析。
 * 裸 `&` 会不会把整篇稿子的保存打挂，得有个用例钉住。
 */
describe("正文里带查询串的图片地址", () => {
  const withRawAmp = '<h1>标题</h1><section data-ai-assistant-image-slot="hero">'
    + '<img src="/api/workflow/article-workflow/images/a1/blob?exp=1700021600000&sig=abc" alt="封面" />'
    + "</section><p>正文</p>";

  it("裸 & 的地址也能过 HTML 校验", () => {
    expect(() => assertArticleWorkflowHtmlFragment({
      html: withRawAmp,
      expectedVisibleText: "标题正文",
    })).not.toThrow();
  });

  it("裸 & 的地址也能还原成稳定地址", () => {
    expect(articleWorkflowStableBodyHtml(withRawAmp))
      .toContain('src="/api/workflow/article-workflow/images/a1/blob"');
    expect(articleWorkflowStableBodyHtml(withRawAmp)).not.toContain("sig=");
  });

  /** 真实保存顺序是「先过校验、再还原地址」，assetId 必须活着走完这两步 */
  it("过一遍校验再还原，assetId 不丢", () => {
    const guarded = assertArticleWorkflowHtmlFragment({
      html: withRawAmp,
      expectedVisibleText: "标题正文",
    });
    const stable = articleWorkflowStableBodyHtml(guarded);
    expect(stable).toContain("/api/workflow/article-workflow/images/a1/blob");
    expect(stable).not.toContain("sig=");
    expect(stable).not.toContain("exp=");
  });
});
