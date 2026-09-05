// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDialog } from "./useDialog";

interface PanelProps {
  readonly open: boolean;
  readonly onClose?: (() => void) | undefined;
  readonly label?: string;
  readonly children?: ReactNode;
}

/**
 * 只留 useDialog 关心的那点结构：一个能接焦点的面板，外面搁一个「打开它的」按钮。
 * `onClose` 故意不给默认值 —— 给了默认值，「传 undefined 就是不许关」那条就测不出来了。
 */
function Panel({ open, onClose, label = "面板", children }: PanelProps) {
  const dialogProps = useDialog({ open, onClose, label });
  return (
    <>
      <button type="button">opener</button>
      {open ? <div {...dialogProps}>{children}</div> : null}
    </>
  );
}

function TwoButtons() {
  return (
    <>
      <button type="button">第一个</button>
      <button type="button">最后一个</button>
    </>
  );
}

describe("useDialog", () => {
  it("打开时焦点落到面板上", () => {
    const { getByRole, rerender } = render(<Panel open={false} />);
    getByRole("button", { name: "opener" }).focus();

    rerender(<Panel open />);

    expect(getByRole("dialog", { name: "面板" })).toHaveFocus();
  });

  // 「局部改写」那个 textarea 带 autoFocus，抢过来光标就跑到面板上了
  it("焦点已经在面板里就不抢", () => {
    const { getByRole } = render(
      <Panel open>
        <input autoFocus aria-label="内层" />
      </Panel>,
    );

    expect(getByRole("textbox", { name: "内层" })).toHaveFocus();
  });

  it("onClose 给 undefined 时 Esc 不拦", () => {
    render(<Panel open onClose={undefined} />);

    expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(true);
  });

  // 里层自己收掉的按键不抢：重命名输入框的 Esc 是「撤销这次改名」，不是「关掉整个面板」
  it("里层已经处理过的 Esc 不抢", () => {
    const onClose = vi.fn();
    const { getByRole } = render(
      <Panel open onClose={onClose}>
        <input aria-label="内层" onKeyDown={(event) => event.preventDefault()} />
      </Panel>,
    );

    fireEvent.keyDown(getByRole("textbox", { name: "内层" }), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("叠着开的时候 Esc 只关最上面那个", () => {
    const bottom = vi.fn();
    const top = vi.fn();
    render(
      <>
        <Panel open onClose={bottom} label="下面" />
        <Panel open onClose={top} label="上面" />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
  });

  it("Tab 走到最后一个再按就绕回第一个", () => {
    const { getByRole } = render(
      <Panel open>
        <TwoButtons />
      </Panel>,
    );
    getByRole("button", { name: "最后一个" }).focus();

    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(getByRole("button", { name: "第一个" })).toHaveFocus();
  });

  it("shift+Tab 在第一个上就绕回最后一个", () => {
    const { getByRole } = render(
      <Panel open>
        <TwoButtons />
      </Panel>,
    );
    getByRole("button", { name: "第一个" }).focus();

    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(false);
    expect(getByRole("button", { name: "最后一个" })).toHaveFocus();
  });

  // 中间那些 Tab 顺序交给浏览器排：焦点还在面板本身时往后走本来就进第一个，别插手
  it("焦点在面板本身时往后 Tab 不拦", () => {
    const { getByRole } = render(
      <Panel open>
        <TwoButtons />
      </Panel>,
    );

    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    expect(getByRole("dialog", { name: "面板" })).toHaveFocus();
  });

  it("焦点在面板本身时往前 Tab 接到最后一个", () => {
    const { getByRole } = render(
      <Panel open>
        <TwoButtons />
      </Panel>,
    );

    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(false);
    expect(getByRole("button", { name: "最后一个" })).toHaveFocus();
  });

  // 点过遮罩之后焦点会掉到面板外面，这时候按 Tab 得先拽回来
  it("焦点跑出面板就拽回第一个", () => {
    const { getByRole } = render(
      <Panel open>
        <TwoButtons />
      </Panel>,
    );
    getByRole("button", { name: "opener" }).focus();

    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(getByRole("button", { name: "第一个" })).toHaveFocus();
  });

  it("面板里一个能聚焦的都没有就把 Tab 吞掉", () => {
    const { getByRole } = render(<Panel open>只有一段字</Panel>);

    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(getByRole("dialog", { name: "面板" })).toHaveFocus();
  });

  it("关掉之后焦点还给打开它的元素", () => {
    const { getByRole, rerender } = render(<Panel open={false} />);
    const opener = getByRole("button", { name: "opener" });
    opener.focus();
    rerender(<Panel open />);

    rerender(<Panel open={false} />);

    expect(opener).toHaveFocus();
  });

  // 人在浮层开着的时候自己点到别处去了，关窗时就别把焦点抢回来
  it("焦点已经落在别处就不抢回来", () => {
    const { getByRole, rerender } = render(
      <Panel open={false}>
        <TwoButtons />
      </Panel>,
    );
    getByRole("button", { name: "opener" }).focus();
    rerender(
      <Panel open>
        <TwoButtons />
      </Panel>,
    );
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    rerender(
      <Panel open={false}>
        <TwoButtons />
      </Panel>,
    );

    expect(outside).toHaveFocus();
    outside.remove();
  });
});
