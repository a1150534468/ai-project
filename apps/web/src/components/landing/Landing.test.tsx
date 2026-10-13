// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionRoot } from "../../motion";
import Landing from "./Landing";

let container: HTMLDivElement;
let root: Root;

function mount(onEnter: () => void, onLogin: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MotionRoot>
        <Landing onEnter={onEnter} onLogin={onLogin} />
      </MotionRoot>,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 取含某段文案的 button。 */
function buttonsWith(label: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((b) => b.textContent?.includes(label));
}

describe("Landing 落地页", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("渲染主张、功能、工作流各区块", () => {
    mount(vi.fn(), vi.fn());
    expect(container.textContent).toContain("先看见，再决定怎样被看见");
    expect(container.textContent).toContain("智能对话");
    expect(container.textContent).toContain("创作工作流");
    expect(container.textContent).toContain("六大工作流，随点随用");
  });

  it("「开始使用」触发 onEnter", () => {
    const onEnter = vi.fn();
    mount(onEnter, vi.fn());
    const [button] = buttonsWith("开始使用");
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("「登录」触发 onLogin", () => {
    const onLogin = vi.fn();
    mount(vi.fn(), onLogin);
    const [button] = buttonsWith("登录");
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("渲染怎么用、工作流一览、FAQ 等完整营销结构", () => {
    mount(vi.fn(), vi.fn());
    expect(container.textContent).toContain("三步就能开始");
    expect(container.textContent).toContain("六大工作流，随点随用");
    expect(container.textContent).toContain("常见问题");
    expect(container.textContent).toContain("不登录能用吗？");
  });

  it("不写任何收费/价格内容", () => {
    mount(vi.fn(), vi.fn());
    const text = container.textContent ?? "";
    // 计价口径随模型与分辨率变，静态页上怎么写都会和模型广场对不上，索性不写
    for (const word of ["¥", "计费", "价格", "定价", "收费", "付费", "免费"]) {
      expect(text).not.toContain(word);
    }
  });

  it("根节点是定高滚动容器：body 全局 overflow:hidden，用 min-height 会滚不动", () => {
    mount(vi.fn(), vi.fn());
    const rootEl = container.querySelector('[data-testid="landing-root"]');
    expect(rootEl?.className).toContain("h-dvh");
    expect(rootEl?.className).toContain("overflow-y-auto");
    expect(rootEl?.className).not.toContain("min-h-dvh");
  });
});
