// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

/**
 * motion 只在这里挡掉：真实现的 opacity/scale 过渡会跟 fake timer 抢时间轴。
 * 动画描述项摘掉、其余（含 style 与两个 mouse 回调）原样落到 <div> ——
 * 位置是靠 style 表达的，浮层的落点断言要读它。
 */
type MotionDivProps = ComponentProps<"div"> & {
  initial?: unknown;
  animate?: unknown;
  transition?: unknown;
};

vi.mock("motion/react", () => ({
  useReducedMotion: () => false,
  motion: {
    div: ({ initial, animate, transition, ...dom }: MotionDivProps) => <div {...dom} />,
  },
}));

import { HoverPopover } from "./HoverPopover";

const CONTENT = "浮层内容";
const ANCHOR = "锚点";

/** 浮层最大高度，与实现里的 MAX_POPOVER_HEIGHT 对齐 */
const MAX_H = 320;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function mount(disabled = false) {
  render(
    <HoverPopover disabled={disabled} content={<span>{CONTENT}</span>}>
      <button type="button">{ANCHOR}</button>
    </HoverPopover>,
  );
  return {
    /** 锚点包裹层（挂 mouse 回调的那一层），不是按钮本身 */
    anchorBox: screen.getByText(ANCHOR).parentElement as HTMLElement,
    anchor: () => screen.getByText(ANCHOR),
    popover: () => screen.queryByText(CONTENT),
  };
}

const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe("HoverPopover 开合", () => {
  it("未 hover 时浮层不在文档里", () => {
    expect(mount().popover()).toBeNull();
  });

  it("hover 锚点立刻展开，不等动画", () => {
    const ui = mount();
    fireEvent.mouseEnter(ui.anchor());
    expect(ui.popover()).toBeTruthy();
  });

  it("离开锚点留 150ms 缓冲，到点才收", () => {
    const ui = mount();
    fireEvent.mouseEnter(ui.anchor());
    fireEvent.mouseLeave(ui.anchor());

    wait(149);
    expect(ui.popover()).toBeTruthy();

    wait(1);
    expect(ui.popover()).toBeNull();
  });

  it("缓冲期内移进浮层就不再关闭（hover 三角）", () => {
    const ui = mount();
    fireEvent.mouseEnter(ui.anchor());
    fireEvent.mouseLeave(ui.anchor());
    wait(80);

    fireEvent.mouseEnter(screen.getByText(CONTENT));
    wait(5_000);
    expect(ui.popover()).toBeTruthy();
  });

  it("离开浮层本体同样走 150ms 关闭", () => {
    const ui = mount();
    fireEvent.mouseEnter(ui.anchor());
    fireEvent.mouseEnter(screen.getByText(CONTENT));

    fireEvent.mouseLeave(screen.getByText(CONTENT));
    wait(150);
    expect(ui.popover()).toBeNull();
  });

  it("反复进出只认最后一次，不会被前一次的预约提前收掉", () => {
    const ui = mount();
    fireEvent.mouseEnter(ui.anchor());
    fireEvent.mouseLeave(ui.anchor());
    wait(100);
    fireEvent.mouseEnter(ui.anchor());

    wait(100);
    expect(ui.popover()).toBeTruthy();
  });

  it("disabled 时 hover 无效", () => {
    const ui = mount(true);
    fireEvent.mouseEnter(ui.anchor());
    expect(ui.popover()).toBeNull();
  });
});

describe("HoverPopover 落点", () => {
  /** 让锚点报出一个确定的视口矩形，好断言浮层落在哪 */
  function stubAnchorRect(anchorBox: HTMLElement, box: { right: number; top: number }) {
    anchorBox.getBoundingClientRect = () => ({ ...box, left: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }

  it("贴在锚点右侧 8px、顶边对齐", () => {
    const ui = mount();
    stubAnchorRect(ui.anchorBox, { right: 72, top: 120 });

    fireEvent.mouseEnter(ui.anchor());
    const layer = screen.getByText(CONTENT).parentElement as HTMLElement;
    expect(layer.style.position).toBe("fixed");
    expect(layer.style.left).toBe("80px");
    expect(layer.style.top).toBe("120px");
  });

  it("锚点靠视口底部时上推，留足整屏浮层的高度", () => {
    const ui = mount();
    stubAnchorRect(ui.anchorBox, { right: 72, top: window.innerHeight - 10 });

    fireEvent.mouseEnter(ui.anchor());
    const layer = screen.getByText(CONTENT).parentElement as HTMLElement;
    expect(layer.style.top).toBe(`${window.innerHeight - MAX_H}px`);
  });
});
