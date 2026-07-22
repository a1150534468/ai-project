import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Workflow from "./Workflow";
import { ToastProvider } from "../motion";

describe("Workflow image hub", () => {
  it("keeps general, e-commerce, and portrait studios mounted under separate tabs", () => {
    const html = renderToStaticMarkup(<ToastProvider><Workflow token="token" activeModuleId="image" /></ToastProvider>);
    expect(html).toContain("通用生图");
    expect(html).toContain("电商生图");
    expect(html).toContain("形象照");
    expect(html).toContain('data-testid="portrait-studio"');
    expect(html).toContain("产品资料");
    expect(html).toContain("商品主图");
    expect(html).toContain("生成图片");
    expect(html).toMatch(/class="hidden"[^>]*><section data-testid="portrait-studio"/);
  });
});
