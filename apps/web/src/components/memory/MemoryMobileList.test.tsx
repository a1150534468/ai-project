// @vitest-environment jsdom

/** 移动端记忆列表。跟表格共用 `MemoryChrome` 的占位，但文案是自己的一套。 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoryNode } from "../../memoryTypes";
import MemoryMobileList from "./MemoryMobileList";

const ROWS: readonly MemoryNode[] = [
  {
    id: "a",
    title: "深色主题偏好",
    text: "夜里写代码，界面一律深色。",
    type: "CORE",
    importance: 91,
    tags: ["偏好", "界面", "第三个", "第四个"],
    createdAt: "2026-08-01T10:00:00.000Z",
    lastUsedAt: null,
    usedCount: 7,
  },
  {
    id: "b",
    title: "常驻的项目背景",
    text: "这个仓库在做记忆管理。",
    type: "PERMANENT",
    importance: 60,
    tags: [],
    createdAt: "2026-08-02T10:00:00.000Z",
    lastUsedAt: "2026-08-30T10:00:00.000Z",
    usedCount: 1,
  },
];

function mount(overrides: Partial<Parameters<typeof MemoryMobileList>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <MemoryMobileList
      nodes={ROWS}
      selectedId={null}
      highlightedIds={new Set()}
      loading={false}
      error=""
      onSelect={onSelect}
      {...overrides}
    />,
  );

  return { onSelect, cards: () => screen.getAllByRole("button") };
}

describe("卡片", () => {
  it("一条记忆一张卡，整张卡就是按钮", () => {
    const ui = mount();

    expect(ui.cards()).toHaveLength(2);
    expect(screen.getByText("深色主题偏好")).toBeInTheDocument();
    expect(screen.getByText("重要度 91")).toBeInTheDocument();
    expect(screen.getByText("核心记忆")).toBeInTheDocument();
  });

  it("标签最多露三个", () => {
    mount();

    expect(screen.getByText("第三个")).toBeInTheDocument();
    expect(screen.queryByText("第四个")).toBeNull();
  });

  it("选中的卡报 aria-pressed", () => {
    const ui = mount({ selectedId: "b" });

    expect(ui.cards().map((card) => card.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
  });

  it("命中的卡挂「搜索命中」", () => {
    mount({ highlightedIds: new Set(["b"]) });
    expect(screen.getByText("搜索命中")).toBeInTheDocument();
  });

  it("点卡片把 id 交出去", () => {
    const ui = mount();
    fireEvent.click(ui.cards()[0] as HTMLElement);

    expect(ui.onSelect).toHaveBeenCalledOnce();
    expect(ui.onSelect).toHaveBeenCalledWith("a");
  });
});

describe("占位", () => {
  it("空态文案是列表自己的一套，不是表格那句", () => {
    mount({ nodes: [] });

    expect(screen.getByText("当前筛选下没有记忆")).toBeInTheDocument();
    expect(
      screen.getByText("调整类型筛选或开始更多对话，让新的内容进入你的长期记忆。"),
    ).toBeInTheDocument();
  });

  it("加载中给自己的转圈文案", () => {
    mount({ nodes: [], loading: true });
    expect(screen.getByText("正在加载记忆列表...")).toBeInTheDocument();
  });

  it("出错标题是「记忆列表加载失败」", () => {
    mount({ nodes: [], error: "网络断了" });

    expect(screen.getByText("记忆列表加载失败")).toBeInTheDocument();
    expect(screen.getByText("网络断了")).toBeInTheDocument();
  });
});

