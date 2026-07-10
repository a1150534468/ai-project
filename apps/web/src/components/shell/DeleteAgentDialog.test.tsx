// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DeleteAgentDialog } from "./DeleteAgentDialog";

const props = { open: true, agentName: "我的法务", sessionCount: 12, onCancel: vi.fn(), onConfirm: vi.fn() };

describe("DeleteAgentDialog", () => {
  it("有对话时，提示语写明会删掉多少个对话", () => {
    render(<DeleteAgentDialog {...props} />);
    expect(screen.getByText(/12 个对话/)).toBeTruthy();
  });
  it("有对话时，未输入名称 → 删除按钮 disabled", () => {
    render(<DeleteAgentDialog {...props} />);
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
  });
  it("输入正确名称 → 删除按钮可用", () => {
    render(<DeleteAgentDialog {...props} />);
    fireEvent.change(screen.getByPlaceholderText("我的法务"), { target: { value: "我的法务" } });
    expect(screen.getByRole("button", { name: "删除" })).toBeEnabled();
  });
  it("输入错误名称 → 仍 disabled", () => {
    render(<DeleteAgentDialog {...props} />);
    fireEvent.change(screen.getByPlaceholderText("我的法务"), { target: { value: "我的法" } });
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
  });
  it("sessionCount 为 0 时不要求输入名称", () => {
    render(<DeleteAgentDialog {...props} sessionCount={0} />);
    expect(screen.queryByPlaceholderText("我的法务")).toBeNull();
    expect(screen.getByRole("button", { name: "删除" })).toBeEnabled();
  });
  it("点删除 → 回调", () => {
    const onConfirm = vi.fn();
    render(<DeleteAgentDialog {...props} sessionCount={0} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
