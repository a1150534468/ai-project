// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

const noop = () => {};

describe("Modal", () => {
  it("open 为真时把面板内容渲染出来", () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={noop} label="示例弹窗">
        <p>modal-body</p>
      </Modal>,
    );

    expect(html).toContain("modal-body");
  });

  // 关着的时候整棵子树都不该挂：面板里常有拉数据的表单，渲染出来就会白发一轮请求
  it("open 为假时连子节点都不渲染", () => {
    const html = renderToStaticMarkup(
      <Modal open={false} onClose={noop} label="示例弹窗">
        <p>modal-body</p>
      </Modal>,
    );

    expect(html).not.toContain("modal-body");
  });

  it("className 给的是面板，不是遮罩", () => {
    const { container, getByText } = render(
      <Modal open onClose={noop} label="示例弹窗" className="panel-card">
        <p>modal-body</p>
      </Modal>,
    );

    expect(container.firstElementChild?.className).toBe("");
    expect(getByText("modal-body").parentElement?.className).toBe("panel-card");
  });

  // 语义挂在面板上而不是遮罩上：读屏软件要念的是内容那一层
  it("面板是带可访问名的 dialog", () => {
    const { getByRole, getByText } = render(
      <Modal open onClose={noop} label="示例弹窗">
        <p>modal-body</p>
      </Modal>,
    );

    const panel = getByRole("dialog", { name: "示例弹窗" });

    expect(panel).toBe(getByText("modal-body").parentElement);
    expect(panel.getAttribute("aria-modal")).toBe("true");
  });

  it("点遮罩关窗", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} label="示例弹窗">
        <p>modal-body</p>
      </Modal>,
    );

    fireEvent.click(container.firstElementChild as Element);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 面板里的点击不能冒到遮罩上，否则点输入框、点标题都会把窗关掉
  it("点面板里面不关窗", () => {
    const onClose = vi.fn();
    const { getByText } = render(
      <Modal open onClose={onClose} label="示例弹窗">
        <p>modal-body</p>
      </Modal>,
    );

    fireEvent.click(getByText("modal-body"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc 关窗", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} label="示例弹窗">
        <p>modal-body</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // onClose 给 undefined 就是「这一刻不许关」，点遮罩和 Esc 得一起失效
  it("onClose 为 undefined 时两条关窗路径都不响应", () => {
    const { container } = render(
      <Modal open onClose={undefined} label="示例弹窗">
        <p>modal-body</p>
      </Modal>,
    );

    const overlay = container.firstElementChild as Element;
    fireEvent.click(overlay);
    const escape = fireEvent.keyDown(document, { key: "Escape" });

    expect(escape).toBe(true);
    expect(overlay.isConnected).toBe(true);
  });
});
