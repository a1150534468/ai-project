// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReactNode } from "react";

// Mock motion/react 以消除 exit 动画在 fake timer 下的时序不确定性
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: (props: any) => {
      const { children, onMouseEnter, onMouseLeave, className } = props;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { initial, animate, exit, transition, style, ...restProps } = props;
      return (
        <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} className={className} {...restProps}>
          {children}
        </div>
      );
    },
  },
  useReducedMotion: () => false,
}));

import { HoverPopover } from "./HoverPopover";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = () =>
  render(
    <HoverPopover content={<span>浮层内容</span>}>
      <button>锚点</button>
    </HoverPopover>,
  );

describe("HoverPopover", () => {
  it("默认不显示浮层", () => {
    setup();
    expect(screen.queryByText("浮层内容")).toBeNull();
  });
  it("hover 锚点 → 立即显示", () => {
    setup();
    fireEvent.mouseEnter(screen.getByText("锚点"));
    expect(screen.getByText("浮层内容")).toBeTruthy();
  });
  it("离开锚点后 150ms 才关闭", () => {
    setup();
    const anchor = screen.getByText("锚点");
    fireEvent.mouseEnter(anchor);
    fireEvent.mouseLeave(anchor);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByText("浮层内容")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60); });
    expect(screen.queryByText("浮层内容")).toBeNull();
  });
  it("鼠标从锚点移入浮层 → 不关闭（hover 三角）", () => {
    setup();
    fireEvent.mouseEnter(screen.getByText("锚点"));
    fireEvent.mouseLeave(screen.getByText("锚点"));
    act(() => { vi.advanceTimersByTime(80); });
    fireEvent.mouseEnter(screen.getByText("浮层内容"));
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByText("浮层内容")).toBeTruthy();
  });
  it("离开浮层后 150ms 关闭", () => {
    setup();
    fireEvent.mouseEnter(screen.getByText("锚点"));
    fireEvent.mouseEnter(screen.getByText("浮层内容"));
    fireEvent.mouseLeave(screen.getByText("浮层内容"));
    act(() => { vi.advanceTimersByTime(160); });
    expect(screen.queryByText("浮层内容")).toBeNull();
  });
  it("disabled 时永不显示", () => {
    render(<HoverPopover disabled content={<span>浮层内容</span>}><button>锚点</button></HoverPopover>);
    fireEvent.mouseEnter(screen.getByText("锚点"));
    expect(screen.queryByText("浮层内容")).toBeNull();
  });
});
