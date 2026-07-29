// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  articleWorkflowSanitizeHtml,
  articleWorkflowSanitizeToFragment,
} from "./articleWorkflowHtmlSanitizer";

/** 生成结果的真实形态：section 套 section，纯内联样式，图片带槽位标记 */
const wechatFragment = [
  '<section style="margin:0;padding:0 16px;font-size:16px;line-height:1.9;color:#2c3e50">',
  '<section style="margin-bottom:24px;text-align:center">',
  '<section data-ai-assistant-image-slot="cover" style="margin:0 auto;max-width:100%">',
  '<img data-ai-assistant-image-slot="cover" src="https://cdn.example.com/cover.png" alt="封面" style="display:block;width:100%;border-radius:12px" />',
  "</section>",
  "</section>",
  '<section style="margin-bottom:20px">',
  '<p style="margin:0 0 18px;text-indent:2em">第一段正文，讲清楚背景。</p>',
  '<p style="margin:0"><strong style="color:#e74c3c">重点提示</strong>后面还有内容。</p>',
  "</section>",
  "</section>",
].join("");

describe("articleWorkflowSanitizeHtml", () => {
  it("公众号版式原样保留：section 嵌套、内联样式、图片槽位都不动", () => {
    const output = articleWorkflowSanitizeHtml(wechatFragment);

    expect(output.match(/<section/g)).toHaveLength(4);
    expect(output).toContain('data-ai-assistant-image-slot="cover"');
    expect(output.match(/data-ai-assistant-image-slot/g)).toHaveLength(2);
    expect(output).toContain("padding:0 16px");
    expect(output).toContain("text-indent:2em");
    expect(output).toContain('src="https://cdn.example.com/cover.png"');
    expect(output).toContain('alt="封面"');
  });

  it("反复过一遍不会越洗越少（幂等）", () => {
    const once = articleWorkflowSanitizeHtml(wechatFragment);
    expect(articleWorkflowSanitizeHtml(once)).toBe(once);
  });

  /**
   * 配图取图地址带短期签名，签名在查询串里。
   * 洗掉查询串就等于把签名洗没了，页面上全是碎图。
   */
  it("配图代理地址上的签名查询串留着", () => {
    const src = "/api/workflow/article-workflow/images/abc123/blob?exp=1700021600000&amp;sig=Zm9v-_x";
    const output = articleWorkflowSanitizeHtml(
      `<section data-ai-assistant-image-slot="cover"><img src="${src}" alt="封面" /></section>`,
    );

    expect(output).toContain("/api/workflow/article-workflow/images/abc123/blob");
    expect(output).toContain("exp=1700021600000");
    expect(output).toContain("sig=Zm9v-_x");
  });

  it("白名单外的标签只脱壳，里面的文字留着", () => {
    // h2 在白名单里（排版模型会用它），所以拿 article/section 当壳来验
    const output = articleWorkflowSanitizeHtml(
      '<article><h2 style="color:red">标题</h2><p>正文</p></article>',
    );

    expect(output).not.toContain("<article");
    expect(output).toContain("<h2");
    expect(output).toContain("标题");
    expect(output).toContain("<p>正文</p>");
  });

  it("危险标签整块删掉", () => {
    const output = articleWorkflowSanitizeHtml(
      '<p>前</p><script>alert(1)</script><iframe src="https://evil.example.com"></iframe><style>p{color:red}</style><p>后</p>',
    );

    expect(output).not.toContain("script");
    expect(output).not.toContain("iframe");
    expect(output).not.toContain("<style");
    expect(output).toContain("<p>前</p>");
    expect(output).toContain("<p>后</p>");
  });

  it("白名单外的属性清掉，事件处理器也一样", () => {
    const output = articleWorkflowSanitizeHtml(
      '<p onclick="alert(1)" class="w-e-text" id="x" style="color:#333">文字</p>',
    );

    expect(output).not.toContain("onclick");
    expect(output).not.toContain("class");
    expect(output).not.toContain("id=");
    expect(output).toContain("style=");
  });

  it.each([
    ["javascript:alert(1)", "javascript"],
    ["JaVaScRiPt:alert(1)", "javascript 大小写混写"],
    ["java\tscript:alert(1)", "javascript 中间插制表符"],
    ["  javascript:alert(1)", "javascript 前置空白"],
    ["vbscript:msgbox(1)", "vbscript"],
    ["data:text/html;base64,PHNjcmlwdD4=", "非图片 data URL"],
  ])("拦掉危险链接：%s", (href) => {
    const output = articleWorkflowSanitizeHtml(`<a href="${href}">点我</a>`);

    expect(output).not.toContain("href");
    expect(output).toContain("点我");
  });

  it("正常链接和图片 data URL 放行", () => {
    expect(articleWorkflowSanitizeHtml('<a href="https://example.com/a">看</a>')).toContain(
      'href="https://example.com/a"',
    );
    expect(
      articleWorkflowSanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=" />'),
    ).toContain("data:image/png;base64");
  });

  it("img 的 src 是脚本协议时只掉 src，不把图片节点留成炸弹", () => {
    const output = articleWorkflowSanitizeHtml('<img src="javascript:alert(1)" alt="x" />');

    expect(output).not.toContain("javascript");
    expect(output).toContain('alt="x"');
  });
});

describe("articleWorkflowSanitizeToFragment", () => {
  it("返回可直接插入的 DocumentFragment", () => {
    const fragment = articleWorkflowSanitizeToFragment(wechatFragment);

    expect(fragment).toBeInstanceOf(DocumentFragment);
    const host = document.createElement("div");
    host.appendChild(fragment);
    expect(host.querySelectorAll("section")).toHaveLength(4);
    expect(
      host.querySelector('section[data-ai-assistant-image-slot="cover"]'),
    ).not.toBeNull();
  });

  it("空字符串给出空 fragment", () => {
    expect(articleWorkflowSanitizeToFragment("").childNodes).toHaveLength(0);
  });
});
