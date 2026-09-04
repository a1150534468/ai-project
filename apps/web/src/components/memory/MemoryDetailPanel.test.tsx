// @vitest-environment jsdom

/**
 * 记忆详情面板 + 编辑器。编辑态整块靠一个 `draft` 表达，进/退/校验/落库都在这条路上，
 * 所以从 DOM 这一侧测：点开编辑、改字段、按保存，看交出去的 payload 与之后的去向。
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoryNode } from "../../memoryTypes";
import MemoryDetailPanel from "./MemoryDetailPanel";

const NODE: MemoryNode = {
  id: "core",
  title: "用户偏好深色主题",
  text: "夜里写代码，界面一律深色。",
  type: "CORE",
  importance: 72,
  tags: ["偏好", "界面"],
  createdAt: "2026-08-01T10:00:00.000Z",
  lastUsedAt: null,
  usedCount: 3,
};

function mount(overrides: Partial<Parameters<typeof MemoryDetailPanel>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(true);
  const onDelete = vi.fn();
  render(<MemoryDetailPanel node={NODE} pending={null} onSave={onSave} onDelete={onDelete} {...overrides} />);

  return {
    onSave,
    onDelete,
    /** 查看态与编辑态是 `AnimatePresence mode="wait"` 的两个 key，换过去要等前一个退完 */
    open: async () => {
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
      await screen.findByLabelText("标题");
    },
    save: () => screen.getByRole("button", { name: "保存修改" }),
    remove: () => screen.getByRole("button", { name: "删除" }),
    title: () => screen.getByLabelText("标题"),
    text: () => screen.getByLabelText("内容"),
    tags: () => screen.getByLabelText("标签"),
  };
}

describe("查看态", () => {
  it("摘要行给出类型、重要度与使用次数，正文照原样铺开", () => {
    mount();

    expect(screen.getByText("核心记忆")).toBeInTheDocument();
    expect(screen.getByText("重要度 72")).toBeInTheDocument();
    expect(screen.getByText("使用 3 次")).toBeInTheDocument();
    expect(screen.getByText(NODE.text)).toBeInTheDocument();
  });

  it("没被召回过的记忆，最近使用写「尚未使用」", () => {
    mount();
    expect(screen.getByText("尚未使用")).toBeInTheDocument();
  });

  it("没进编辑态之前没有输入框", () => {
    mount();
    expect(screen.queryByLabelText("标题")).toBeNull();
  });

  it("关闭按钮只在给了 onClose 时出现（桌面右栏常驻，不需要）", () => {
    const { unmount } = render(
      <MemoryDetailPanel node={NODE} pending={null} onSave={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "关闭记忆详情" })).toBeNull();
    unmount();

    const onClose = vi.fn();
    render(<MemoryDetailPanel node={NODE} pending={null} onSave={vi.fn()} onDelete={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭记忆详情" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("编辑态", () => {
  it("点编辑就把当前值预填进表单", async () => {
    const ui = mount();
    await ui.open();

    expect(ui.title()).toHaveValue(NODE.title);
    expect(ui.text()).toHaveValue(NODE.text);
    expect(ui.tags()).toHaveValue("偏好, 界面");
    expect(screen.getByLabelText("重要度")).toHaveValue("72");
  });

  it("取消回到查看态，改过的内容不落库", async () => {
    const ui = mount();
    await ui.open();
    fireEvent.change(ui.title(), { target: { value: "改了但不保存" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await screen.findByText(NODE.text);
    expect(screen.queryByLabelText("标题")).toBeNull();
    expect(ui.onSave).not.toHaveBeenCalled();
  });

  it("标题或内容空着不许保存，报错就地显示", async () => {
    const ui = mount();
    await ui.open();
    fireEvent.change(ui.title(), { target: { value: "   " } });
    fireEvent.click(ui.save());

    expect(screen.getByRole("alert")).toHaveTextContent("标题和内容不能为空");
    expect(ui.onSave).not.toHaveBeenCalled();
  });
});

describe("保存", () => {
  it("交出去的 payload 已经修剪好：首尾空白去掉、标签去空去重", async () => {
    const ui = mount();
    await ui.open();
    fireEvent.change(ui.title(), { target: { value: "  深色主题  " } });
    fireEvent.change(ui.text(), { target: { value: "  夜里一律深色。 " } });
    fireEvent.change(ui.tags(), { target: { value: "偏好, ,界面 , 偏好" } });
    fireEvent.click(screen.getByRole("button", { name: "常驻记忆" }));
    fireEvent.change(screen.getByLabelText("重要度"), { target: { value: "40" } });

    await act(async () => {
      fireEvent.click(ui.save());
    });

    expect(ui.onSave).toHaveBeenCalledWith({
      title: "深色主题",
      text: "夜里一律深色。",
      type: "PERMANENT",
      importance: 40,
      tags: ["偏好", "界面"],
    });
  });

  it("保存成功退回查看态", async () => {
    const ui = mount();
    await ui.open();
    await act(async () => {
      fireEvent.click(ui.save());
    });

    await screen.findByText(NODE.text);
    expect(screen.queryByLabelText("标题")).toBeNull();
  });

  it("保存失败留在编辑态，内容不丢", async () => {
    const ui = mount({ onSave: vi.fn().mockResolvedValue(false) });
    await ui.open();
    fireEvent.change(ui.title(), { target: { value: "写库会失败" } });
    await act(async () => {
      fireEvent.click(ui.save());
    });

    expect(ui.title()).toHaveValue("写库会失败");
  });
});

describe("没有标题的记忆", () => {
  const untitled: MemoryNode = { ...NODE, title: "", text: "甲".repeat(60) };

  it("编辑框里的建议标题截 40 字且不带省略号 —— 它会被原样存回库", async () => {
    const ui = mount({ node: untitled });
    await ui.open();

    expect(ui.title()).toHaveValue("甲".repeat(40));
    expect(screen.getByText("已根据内容生成建议标题，可编辑后保存")).toBeInTheDocument();
  });

  it("标题栏上显示的是给人看的那份：24 字加省略号", () => {
    mount({ node: untitled });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(`${"甲".repeat(24)}...`);
  });
});

describe("删除", () => {
  it("点删除只把决定交出去，弹确认框是页面的事", () => {
    const ui = mount();
    fireEvent.click(ui.remove());

    expect(ui.onDelete).toHaveBeenCalledOnce();
  });

  it("正在删的时候按钮锁住，防连点", () => {
    const ui = mount({ pending: "delete" });
    expect(ui.remove()).toBeDisabled();
  });

  it("正在保存的时候删除也一起锁住", () => {
    const ui = mount({ pending: "save" });
    expect(ui.remove()).toBeDisabled();
  });
});

