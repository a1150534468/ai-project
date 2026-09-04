// @vitest-environment jsdom

/**
 * 新建 / 编辑共用的那张表单。要钉住的是：它自己不认「模式」，标题、按钮和取消键
 * 全由 `editing` 一个值决定；以及它是个真 `<form>`，在名称框里按回车就能提交。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import KbForm from "./KbForm";

function mount(overrides: Partial<Parameters<typeof KbForm>[0]> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <KbForm
      draft={{ name: "", description: "" }}
      editing={false}
      saving={false}
      onChange={onChange}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />,
  );

  return { onChange, onSubmit, onCancel, name: () => screen.getByLabelText("知识库名称") };
}

describe("两种态由 editing 一个值决定", () => {
  it("新建态：标题「新建知识库」，没有取消键", () => {
    mount();

    expect(screen.getByText("新建知识库")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("编辑态：标题、按钮换文案，取消键出现", () => {
    const { onCancel } = mount({ editing: true, draft: { name: "我的库", description: "" } });

    expect(screen.getByText("编辑知识库")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存修改" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("提交", () => {
  it("名称只有空格就不给提交", () => {
    const { onSubmit } = mount({ draft: { name: "   ", description: "" } });

    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "创建" }).closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("名称框里按回车就提交 —— 这是张真表单，不是两个 div 加一个 onClick", () => {
    const { onSubmit, name } = mount({ draft: { name: "新库", description: "" } });

    fireEvent.submit(name().closest("form") as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("存盘中不接受第二次提交", () => {
    const { onSubmit } = mount({ saving: true, draft: { name: "新库", description: "" } });

    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "创建" }).closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("两个输入框各自只报自己那一格", () => {
    const { onChange, name } = mount();

    fireEvent.change(name(), { target: { value: "新库" } });
    expect(onChange).toHaveBeenCalledWith({ name: "新库" });

    fireEvent.change(screen.getByLabelText("知识库描述"), { target: { value: "一句话" } });
    expect(onChange).toHaveBeenCalledWith({ description: "一句话" });
  });
});
