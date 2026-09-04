// @vitest-environment jsdom

/**
 * 桌面端记忆表格 + 三种占位（`MemoryChrome` 里的 `memoryListState` / `MemoryPlaceholder`）。
 * 占位这套原来在表格和移动端列表里各写一遍，这里连判定顺序一起钉住。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoryNode } from "../../memoryTypes";
import MemoryTable from "./MemoryTable";

function node(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    title: `记忆 ${id}`,
    text: `${id} 的正文`,
    type: "CORE",
    importance: 50,
    tags: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    lastUsedAt: null,
    usedCount: 7,
    ...overrides,
  };
}

const ROWS = [
  node("a", { title: "深色主题偏好", tags: ["偏好", "界面", "第三个标签"], importance: 91 }),
  node("b", { title: "常驻的项目背景", type: "PERMANENT" }),
];

function mount(overrides: Partial<Parameters<typeof MemoryTable>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <MemoryTable
      nodes={ROWS}
      selectedId={null}
      highlightedIds={new Set()}
      loading={false}
      error=""
      onSelect={onSelect}
      {...overrides}
    />,
  );

  return { onSelect, rows: () => screen.getAllByRole("row").slice(1) };
}

describe("占位三态", () => {
  it("加载中只给转圈，不给空表", () => {
    mount({ loading: true, nodes: [] });

    expect(screen.getByText("正在加载记忆表格...")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("加载中优先于空：还在加载就没资格说「没有记忆」", () => {
    mount({ loading: true, nodes: [], error: "先前那次失败了" });

    expect(screen.getByText("正在加载记忆表格...")).toBeInTheDocument();
    expect(screen.queryByText("当前筛选下没有记忆")).toBeNull();
  });

  it("出错把后端那句话原样带出来", () => {
    mount({ nodes: [], error: "记忆服务没醒" });

    expect(screen.getByText("记忆表格加载失败")).toBeInTheDocument();
    expect(screen.getByText("记忆服务没醒")).toBeInTheDocument();
  });

  it("既没加载也没出错才谈空", () => {
    mount({ nodes: [] });

    expect(screen.getByText("当前筛选下没有记忆")).toBeInTheDocument();
    expect(screen.getByText("调整搜索或类型筛选后再查看。")).toBeInTheDocument();
  });
});

describe("表体", () => {
  it("七列表头齐全，顺序固定", () => {
    mount();

    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "记忆内容",
      "类型",
      "重要度",
      "标签",
      "使用",
      "创建时间",
      "操作",
    ]);
  });

  it("每条记忆一行，类型与重要度落在自己那格", () => {
    const ui = mount();

    expect(ui.rows()).toHaveLength(2);
    expect(screen.getByText("深色主题偏好")).toBeInTheDocument();
    expect(screen.getByText("核心记忆")).toBeInTheDocument();
    expect(screen.getByText("常驻记忆")).toBeInTheDocument();
    expect(screen.getByText("91")).toBeInTheDocument();
    expect(screen.getAllByText("7 次")).toHaveLength(2);
  });

  it("标签这一列最多露两个，第三个留给右侧详情", () => {
    mount();

    expect(screen.getByText("偏好")).toBeInTheDocument();
    expect(screen.getByText("界面")).toBeInTheDocument();
    expect(screen.queryByText("第三个标签")).toBeNull();
  });

  it("一个标签都没有的写「暂无」", () => {
    mount();
    expect(screen.getByText("暂无")).toBeInTheDocument();
  });
});

describe("命中与选中", () => {
  it("搜索命中的行挂一个「命中」角标", () => {
    mount({ highlightedIds: new Set(["a"]) });

    expect(screen.getAllByText("命中")).toHaveLength(1);
  });

  it("选中的行报 aria-selected，其余为 false", () => {
    const ui = mount({ selectedId: "b" });

    expect(ui.rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });
});

describe("交互", () => {
  it("整行可点", () => {
    const ui = mount();
    fireEvent.click(ui.rows()[1] as HTMLElement);

    expect(ui.onSelect).toHaveBeenCalledOnce();
    expect(ui.onSelect).toHaveBeenCalledWith("b");
  });

  it("操作列那个按钮是给键盘和读屏用的，名字带上记忆标题", () => {
    const ui = mount();
    fireEvent.click(screen.getByRole("button", { name: "查看记忆：深色主题偏好" }));

    // stopPropagation 拦住了外层的行点击，不能记成两次
    expect(ui.onSelect).toHaveBeenCalledOnce();
    expect(ui.onSelect).toHaveBeenCalledWith("a");
  });
});

