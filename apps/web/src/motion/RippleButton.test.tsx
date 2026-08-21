// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RippleButton } from "./RippleButton";

afterEach(() => {
  vi.useRealTimers();
});

describe("RippleButton", () => {
  it("renders children and forwards className", () => {
    const html = renderToStaticMarkup(<RippleButton className="btn-primary">发送</RippleButton>);
    expect(html).toContain("发送");
    expect(html).toContain("btn-primary");
  });

  it("forwards aria-label and id attributes", () => {
    const html = renderToStaticMarkup(
      <RippleButton aria-label="发送消息" id="send-btn">
        发送
      </RippleButton>,
    );
    expect(html).toContain('aria-label="发送消息"');
    expect(html).toContain('id="send-btn"');
  });

  it("clears pending ripple removal timers when unmounted", () => {
    vi.useFakeTimers();
    const { getByRole, unmount } = render(<RippleButton>发送</RippleButton>);

    fireEvent.click(getByRole("button"), { clientX: 10, clientY: 10 });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
