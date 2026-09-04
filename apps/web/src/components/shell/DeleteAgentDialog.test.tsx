// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeleteAgentDialog } from "./DeleteAgentDialog";

const NAME = "我的法务";

function mount(overrides: Partial<Parameters<typeof DeleteAgentDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(<DeleteAgentDialog open agentName={NAME} sessionCount={12} onCancel={onCancel} onConfirm={onConfirm} {...overrides} />);
  return {
    onCancel,
    onConfirm,
    confirm: () => screen.getByRole("button", { name: "删除" }),
    cancel: () => screen.getByRole("button", { name: "取消" }),
    /** 抄名字用的输入框，没有这道闸时为 null */
    gate: () => screen.queryByPlaceholderText(NAME),
  };
}

describe("DeleteAgentDialog 名下有对话", () => {
  it("提示语点明会连带删掉多少个对话", () => {
    mount();
    expect(screen.getByText(/12 个对话/)).toBeTruthy();
  });

  it("名字没抄对之前删不掉", () => {
    const ui = mount();
    expect(ui.confirm()).toBeDisabled();

    fireEvent.change(ui.gate() as HTMLElement, { target: { value: "我的法" } });
    expect(ui.confirm()).toBeDisabled();
  });

  it("名字抄对了才放行", () => {
    const ui = mount();
    fireEvent.change(ui.gate() as HTMLElement, { target: { value: NAME } });
    expect(ui.confirm()).toBeEnabled();

    fireEvent.click(ui.confirm());
    expect(ui.onConfirm).toHaveBeenCalledOnce();
  });
});

describe("DeleteAgentDialog 名下没有对话", () => {
  const empty = { sessionCount: 0 };

  it("不要求抄名字，直接可删", () => {
    const ui = mount(empty);
    expect(ui.gate()).toBeNull();
    expect(ui.confirm()).toBeEnabled();
  });

  it("点删除就把决定交出去", () => {
    const ui = mount(empty);
    fireEvent.click(ui.confirm());
    expect(ui.onConfirm).toHaveBeenCalledOnce();
  });
});

describe("DeleteAgentDialog 开合", () => {
  it("open=false 时整个弹窗不在文档里", () => {
    render(<DeleteAgentDialog open={false} agentName={NAME} sessionCount={3} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("点取消只回调，不误触删除", () => {
    const ui = mount();
    fireEvent.click(ui.cancel());
    expect(ui.onCancel).toHaveBeenCalledOnce();
    expect(ui.onConfirm).not.toHaveBeenCalled();
  });
});
