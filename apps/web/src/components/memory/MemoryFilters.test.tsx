// @vitest-environment jsdom

/**
 * 筛选条。三件事值得钉：搜索框有没有可读的名字（原来只有 placeholder，读屏念不出来）、
 * 提交走的是 form 而不是只有点按钮、开关与类型 chip 有没有把状态说清楚。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_TYPE_ORDER, getMemoryTypeMeta } from "../../memoryGalaxy";
import MemoryFilters from "./MemoryFilters";

function mount(overrides: Partial<Parameters<typeof MemoryFilters>[0]> = {}) {
  const onQueryChange = vi.fn();
  const onSearch = vi.fn();
  const onToggleEnabled = vi.fn();
  const onToggleType = vi.fn();
  render(
    <MemoryFilters
      enabled
      pending={null}
      query=""
      activeTypes={MEMORY_TYPE_ORDER}
      counts={{ total: 12, visible: 5, hit: 2 }}
      onQueryChange={onQueryChange}
      onSearch={onSearch}
      onToggleEnabled={onToggleEnabled}
      onToggleType={onToggleType}
      {...overrides}
    />,
  );

  return {
    onQueryChange,
    onSearch,
    onToggleEnabled,
    onToggleType,
    input: () => screen.getByLabelText("搜索记忆"),
    submit: () => screen.getByRole("button", { name: "搜索" }),
    toggle: () => screen.getByRole("switch"),
  };
}

describe("搜索", () => {
  it("输入框有可读的名字，不靠 placeholder 顶", () => {
    const ui = mount();

    expect(ui.input()).toHaveAccessibleName("搜索记忆");
    expect(ui.input()).toHaveAttribute("placeholder", "搜索标题、内容或标签");
  });

  it("敲字往上报，自己不留状态", () => {
    const ui = mount({ query: "深色" });
    expect(ui.input()).toHaveValue("深色");

    fireEvent.change(ui.input(), { target: { value: "深色主题" } });
    expect(ui.onQueryChange).toHaveBeenCalledWith("深色主题");
  });

  it("回车就能搜，不用非得点按钮", () => {
    const ui = mount();
    fireEvent.submit(ui.input());

    expect(ui.onSearch).toHaveBeenCalledOnce();
  });

  it("搜索在飞的时候按钮锁住", () => {
    const ui = mount({ pending: "search" });
    expect(ui.submit()).toBeDisabled();
  });

  it("别的写操作在飞不影响搜索", () => {
    const ui = mount({ pending: "save" });
    expect(ui.submit()).toBeEnabled();
  });
});

describe("计数", () => {
  it("总数、当前显示、命中三个数报在一行里", () => {
    mount();
    expect(screen.getByText("共 12 条，显示 5 条，命中 2 条")).toBeInTheDocument();
  });
});

describe("长期记忆开关", () => {
  it("开着的时候 aria-checked 和文案一致", () => {
    const ui = mount();

    expect(ui.toggle()).toHaveAttribute("aria-checked", "true");
    expect(ui.toggle()).toHaveTextContent("长期记忆已启用");
  });

  it("关着的时候同样一致", () => {
    const ui = mount({ enabled: false });

    expect(ui.toggle()).toHaveAttribute("aria-checked", "false");
    expect(ui.toggle()).toHaveTextContent("长期记忆已关闭");
  });

  it("点一下只回调，状态由上面说了算", () => {
    const ui = mount();
    fireEvent.click(ui.toggle());

    expect(ui.onToggleEnabled).toHaveBeenCalledOnce();
    expect(ui.toggle()).toHaveAttribute("aria-checked", "true");
  });

  it("正在写设置的时候锁住，防连点打架", () => {
    const ui = mount({ pending: "toggle" });
    expect(ui.toggle()).toBeDisabled();
  });
});

describe("类型筛选", () => {
  it("五类按固定顺序列全", () => {
    mount();
    const group = screen.getByRole("group", { name: "按类型筛选" });

    expect([...group.querySelectorAll("button")].map((button) => button.textContent)).toEqual(
      MEMORY_TYPE_ORDER.map((type) => getMemoryTypeMeta(type).label),
    );
  });

  it("勾着的报 aria-pressed=true，没勾的 false", () => {
    mount({ activeTypes: ["CORE", "OTHER"] });

    expect(screen.getByRole("button", { name: "核心记忆" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "常驻记忆" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "其他记忆" })).toHaveAttribute("aria-pressed", "true");
  });

  it("点哪个就把哪个类型交出去", () => {
    const ui = mount();
    fireEvent.click(screen.getByRole("button", { name: "知识星云" }));

    expect(ui.onToggleType).toHaveBeenCalledWith("KNOWLEDGE");
  });
});

