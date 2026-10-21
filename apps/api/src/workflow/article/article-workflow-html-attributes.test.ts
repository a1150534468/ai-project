import { describe, expect, it } from "vitest";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { sanitizeAttributeProtocols } from "./article-workflow-html-attributes.js";
import { articleWorkflowStableBodyHtml } from "./article-workflow-image-url.js";

function firstElement(html: string): DefaultTreeAdapterTypes.Element {
  const node = parseFragment(html).childNodes[0];
  if (!node || !("attrs" in node)) throw new Error("测试 HTML 缺少首个元素");
  return node;
}

describe("sanitizeAttributeProtocols", () => {
  it.each([
    '<a href="javascript:alert(1)">x</a>',
    "<a href='JaVaScRiPt:alert(1)'>x</a>",
    '<a href="  javascript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
    "<a href=javascript:alert(1)>x</a>",
  ])("剥掉危险协议属性，保留标签：%s", (html) => {
    const out = sanitizeAttributeProtocols(html);
    expect(out).not.toMatch(/href\s*=|src\s*=/i);
    expect(out).toMatch(/^<(a|img)/);
  });

  it.each([
    '<a href="https://example.com/a?b=1&amp;c=2">x</a>',
    '<a href="http://example.com">x</a>',
    '<a href="mailto:a@example.com">x</a>',
    '<a href="tel:+8613800000000">x</a>',
    '<a href="#anchor">x</a>',
    '<a href="/relative/path">x</a>',
    '<img src="//cdn.example.com/a.png">',
  ])("放行安全协议与相对路径：%s", (html) => {
    expect(sanitizeAttributeProtocols(html)).toBe(html);
  });

  it.each([
    '<a href="javascript&colon;alert(1)">x</a>',
    '<a href="java&#9;script:alert(1)">x</a>',
    '<a href="java&Tab;script:alert(1)">x</a>',
    '<a href="java&NewLine;script:alert(1)">x</a>',
  ])("命名实体/内嵌控制字符拼出的危险协议同样剥除：%s", (html) => {
    expect(sanitizeAttributeProtocols(html)).toBe("<a>x</a>");
  });

  it("只剥目标属性，同标签其它属性与正文不动", () => {
    const html = '<a class="keep" href="javascript:alert(1)" title="t">正文</a>';
    expect(sanitizeAttributeProtocols(html)).toBe('<a class="keep" title="t">正文</a>');
  });

  it.each([
    `<a title=" href='https://safe.test" href="javascript:alert('review')">正文</a>`,
    `<a title=' href="https://safe.test"'href="javascript:alert(1)">正文</a>`,
    `<a title="src='https://safe.test'" href="javascript:alert(1)">正文</a>`,
  ])("引号内的伪属性无法掩盖真实危险链接：%s", (html) => {
    const out = sanitizeAttributeProtocols(html);
    const attributes = firstElement(out).attrs;

    expect(attributes.some((attribute) => attribute.name === "href")).toBe(false);
    expect(attributes.find((attribute) => attribute.name === "title")?.value)
      .toBe(firstElement(html).attrs.find((attribute) => attribute.name === "title")?.value);
    expect(out).toContain("正文");
    expect(sanitizeAttributeProtocols(out)).toBe(out);
  });

  it("删除首个危险属性时一并规范化重复属性，防止第二个危险 href 重新生效", () => {
    const html = '<a href="javascript:alert(1)" href="javascript:alert(2)">正文</a>';
    const out = sanitizeAttributeProtocols(html);

    expect(firstElement(out).attrs.some((attribute) => attribute.name === "href")).toBe(false);
    expect(out).toBe("<a>正文</a>");
  });

  it("其它属性里的 href 字样与正文不被当成真实链接清洗", () => {
    const html = `<p title=" href='javascript:alert(1)'"> href="javascript:alert(2)" </p>`;
    expect(sanitizeAttributeProtocols(html)).toBe(html);
  });

  it.each(["&#99999999;", "&#xFFFFFF;", "&#0;"])("超范围或空字符实体按浏览器规则处理，不抛异常：%s", (entity) => {
    const html = `<a href="https://example.com/${entity}">正文</a>`;
    expect(() => sanitizeAttributeProtocols(html)).not.toThrow();
    expect(firstElement(sanitizeAttributeProtocols(html)).attrs[0]?.value).toBe("https://example.com/�");
  });

  it("所有嵌套元素的 URL 属性与模板内容都经过检查", () => {
    const html = '<section><a href="ftp://example.com">正文</a><img src="data:text/html,bad"><template><a href="javascript:alert(1)">隐藏</a></template></section>';
    const out = sanitizeAttributeProtocols(html);

    expect(out).not.toMatch(/href\s*=|src\s*=/i);
    expect(out).toContain("正文");
    expect(out).toContain("隐藏");
  });

  it("带命名空间的 xlink:href 同样剥除危险协议", () => {
    expect(sanitizeAttributeProtocols('<svg><a xlink:href="javascript:alert(1)">正文</a></svg>'))
      .toBe("<svg><a>正文</a></svg>");
  });

  it("无法解析的 URL 不作为相对地址放行", () => {
    expect(sanitizeAttributeProtocols('<a href="https://[invalid">正文</a>')).toBe("<a>正文</a>");
  });

  it("含 < 的畸形输入不抛异常", () => {
    expect(() => sanitizeAttributeProtocols('<a href="x <b> <a href="unterminated')).not.toThrow();
    expect(sanitizeAttributeProtocols("<<<>>>")).toBe("<<<>>>");
  });

  it("与落库稳定化串联：正常外链保留、javascript 链接读回后属性消失", () => {
    const stored = articleWorkflowStableBodyHtml(
      sanitizeAttributeProtocols('<p><a href="https://example.com/post">外链</a><a href="javascript:alert(1)">坏链</a></p>'),
    );
    expect(stored).toContain('href="https://example.com/post"');
    expect(stored).not.toContain("javascript:");
  });
});
