import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  it("渲染成带 alt 的 img", () => {
    const html = renderToStaticMarkup(<BrandLogo />);

    expect(html).toContain("<img");
    expect(html).toContain('alt="AI 助手"');
  });

  // 宽高必须显式写在属性上：图没下载完时浏览器才能按这个尺寸占位，侧栏不会先塌一下
  it("size 同时落到 width 与 height，不给就是 40", () => {
    expect(renderToStaticMarkup(<BrandLogo />)).toContain('width="40" height="40"');
    expect(renderToStaticMarkup(<BrandLogo size={28} />)).toContain('width="28" height="28"');
  });
});
