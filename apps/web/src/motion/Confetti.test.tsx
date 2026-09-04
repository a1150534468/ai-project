// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Confetti, shouldRenderDecoration } from "./Confetti";

describe("shouldRenderDecoration", () => {
  // 三态里只有明确的 true 才关掉：null 是「还没测出来」，那时候按照常渲染处理
  for (const [reducedMotion, expected] of [
    [true, false],
    [false, true],
    [null, true],
  ] as const) {
    it(`reducedMotion=${JSON.stringify(reducedMotion)} → ${expected}`, () => {
      expect(shouldRenderDecoration(reducedMotion)).toBe(expected);
    });
  }
});

describe("Confetti", () => {
  it("没触发就一片纸屑都不画", () => {
    expect(renderToStaticMarkup(<Confetti trigger={false} />)).toBe("");
  });

  // 首帧刻意是空的：effect 里才把 burst 从 0 推上去，否则纸屑会在挂载与重挂之间闪两遍
  it("触发了但 effect 还没跑（服务端渲染）时也是空的", () => {
    expect(renderToStaticMarkup(<Confetti trigger />)).toBe("");
  });

  it("挂载到浏览器里、触发之后撒出固定 26 片", () => {
    const { container } = render(<Confetti trigger />);

    expect(container.querySelectorAll("span")).toHaveLength(26);
  });

  it("触发撤掉就收干净", () => {
    const { container, rerender } = render(<Confetti trigger />);
    rerender(<Confetti trigger={false} />);

    expect(container.querySelectorAll("span")).toHaveLength(0);
  });
});
