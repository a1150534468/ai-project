// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RippleButton } from "./RippleButton";

afterEach(() => {
  vi.useRealTimers();
});

describe("RippleButton", () => {
  it("原样渲染子节点，className 透传给真正的 button", () => {
    const html = renderToStaticMarkup(<RippleButton className="btn-primary">发送</RippleButton>);

    expect(html).toContain("发送");
    expect(html).toContain("btn-primary");
  });

  // 样式全靠外面给，所以 a11y 属性和 id 这类也必须能穿过去，否则调用方没法给按钮起名字
  it("aria-label / id / disabled 这些原生属性都能穿过去", () => {
    const html = renderToStaticMarkup(
      <RippleButton aria-label="发送消息" id="send-btn" disabled>
        发送
      </RippleButton>,
    );

    expect(html).toContain('aria-label="发送消息"');
    expect(html).toContain('id="send-btn"');
    expect(html).toContain("disabled");
  });

  it("自己的定位样式与外面传的 style 合并，且外面的优先级更高", () => {
    const html = renderToStaticMarkup(<RippleButton style={{ overflow: "visible" }}>发送</RippleButton>);

    expect(html).toContain("position:relative");
    expect(html).toContain("overflow:visible");
  });

  it("点击会先铺一圈水波，再把点击事件交给调用方", () => {
    const onClick = vi.fn();
    const { getByRole, container } = render(<RippleButton onClick={onClick}>发送</RippleButton>);

    fireEvent.click(getByRole("button"), { clientX: 10, clientY: 10 });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("span")).toHaveLength(1);
  });

  it("连点两下是两圈水波，不会因为同一毫秒撞成一个", () => {
    const { getByRole, container } = render(<RippleButton>发送</RippleButton>);
    const button = getByRole("button");

    fireEvent.click(button, { clientX: 4, clientY: 4 });
    fireEvent.click(button, { clientX: 6, clientY: 6 });

    expect(container.querySelectorAll("span")).toHaveLength(2);
  });

  it("卸载时把还没到点的清理定时器一起撤掉", () => {
    vi.useFakeTimers();
    const { getByRole, unmount } = render(<RippleButton>发送</RippleButton>);

    fireEvent.click(getByRole("button"), { clientX: 10, clientY: 10 });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
