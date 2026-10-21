import { describe, expect, it } from "vitest";
import { sanitizeAttributeProtocols } from "./article-workflow-html-attributes.js";
import { articleWorkflowStableBodyHtml } from "./article-workflow-image-url.js";

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

  it("只剥目标属性，同标签其它属性与正文不动", () => {
    const html = '<a class="keep" href="javascript:alert(1)" title="t">正文</a>';
    expect(sanitizeAttributeProtocols(html)).toBe('<a class="keep" title="t">正文</a>');
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
