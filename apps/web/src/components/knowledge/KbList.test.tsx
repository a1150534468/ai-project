// @vitest-environment jsdom

/**
 * 「我的库」和「官方库」共用的那份清单。要钉住的是原来最坏的那一处：卡片本体现在是
 * `<button>`，Tab 走得到、读屏会念它可点，而且它里面不再嵌按钮 —— 两个动作是它的兄弟节点。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBase } from "../../kbApi";
import KbList from "./KbList";

const MINE: KnowledgeBase = {
  id: "mine",
  name: "我的库",
  description: "自己建的",
  ownerType: "USER",
  latticeCount: 12,
};
const OTHER: KnowledgeBase = { id: "other", name: "另一个库", ownerType: "USER" };

function mount(overrides: Partial<Parameters<typeof KbList>[0]> = {}) {
  const onSelect = vi.fn();
  const onRefresh = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(
    <KbList
      title="我的知识库"
      items={[MINE, OTHER]}
      selectedId={null}
      emptyText="暂无知识库"
      maxHeight="max-h-96"
      onSelect={onSelect}
      onRefresh={onRefresh}
      onEdit={onEdit}
      onDelete={onDelete}
      {...overrides}
    />,
  );

  return { onSelect, onRefresh, onEdit, onDelete };
}

describe("卡片本体是按钮", () => {
  it("点它报的是自己那个 id，且按钮里没有再嵌按钮", () => {
    const { onSelect } = mount();

    const card = screen.getByRole("button", { name: /我的库/ });
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith("mine");
    expect(card.querySelector("button")).toBeNull();
  });

  it("选中的那张带 aria-current，别的没有", () => {
    mount({ selectedId: "other" });

    expect(screen.getByRole("button", { name: /另一个库/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /我的库/ })).not.toHaveAttribute("aria-current");
  });

  it("描述可以没有，晶格数没有就算 0", () => {
    mount();

    expect(screen.getByText("自己建的")).toBeInTheDocument();
    expect(screen.getByText("已建立知识晶格数量：12")).toBeInTheDocument();
    expect(screen.getByText("已建立知识晶格数量：0")).toBeInTheDocument();
  });
});

describe("一份实现两处用", () => {
  it("官方库：标角标，不给编辑和删除", () => {
    mount({ title: "官方知识库", items: [MINE], official: true, onEdit: undefined, onDelete: undefined });

    expect(screen.getByText("官方")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("我的库：两个动作各自把整个库交回去", () => {
    const { onEdit, onDelete } = mount({ items: [MINE] });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(onEdit).toHaveBeenCalledWith(MINE);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledWith(MINE);
  });
});

describe("刷新键与空态", () => {
  it("有活在飞就锁住，图标转起来", () => {
    const { onRefresh } = mount({ busy: true });

    const refresh = screen.getByRole("button", { name: "刷新我的知识库" });
    expect(refresh).toBeDisabled();
    expect(refresh.querySelector("[data-icon]")?.className).toContain("animate-spin");

    fireEvent.click(refresh);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("没给 onRefresh 就不画这个键 —— 官方库那栏就是这么用的", () => {
    mount({ onRefresh: undefined });

    expect(screen.queryByRole("button", { name: "刷新我的知识库" })).toBeNull();
  });

  it("一条都没有时文案由调用方给：加载中和真的空是两回事", () => {
    mount({ items: [], emptyText: "正在加载…" });

    expect(screen.getByText("正在加载…")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
