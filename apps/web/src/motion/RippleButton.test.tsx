import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { RippleButton } from "./RippleButton";

describe("RippleButton", () => {
  it("renders children and forwards className", () => {
    const html = renderToStaticMarkup(
      <RippleButton className="btn-primary">发送</RippleButton>,
    );
    expect(html).toContain("发送");
    expect(html).toContain("btn-primary");
  });

  it("forwards aria-label and id attributes", () => {
    const html = renderToStaticMarkup(
      <RippleButton aria-label="发送消息" id="send-btn">发送</RippleButton>,
    );
    expect(html).toContain('aria-label="发送消息"');
    expect(html).toContain('id="send-btn"');
  });
});
