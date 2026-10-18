// @vitest-environment jsdom

/**
 * 分段控件的交互契约。要钉住的是它**不是**标签页：
 *   - 整组是 `role="group"`（`aria-label` 说这一组筛的是什么），不是 `role="tablist"` ——
 *     选项之间不切换面板，报成选项卡会与真实交互不符；
 *   - 选中态走 `aria-pressed`，读屏听到的是「已按下」，而不是「已选中」；
 *   - 「取消筛选」是**另一项**（素材库的「全部」、知识库的「官方」），不是再点一次选中项。
 *
 * 底板不在这里断言：它的位置靠 `getBoundingClientRect()` 量，jsdom 里全是 0，量不出有意义的值。
 * 能断言的只有「量不到时不炸」这一条（挂载成功即为证）。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";

type MediaFilter = "all" | "image" | "video";

const OPTIONS: readonly SegmentedOption<MediaFilter>[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
];

function mount(value: MediaFilter = "all") {
  const onChange = vi.fn();
  render(
    <SegmentedControl ariaLabel="素材类型" value={value} options={OPTIONS} onChange={onChange} />,
  );
  return { onChange };
}

describe("一组互斥选项", () => {
  it("整组是 group 而不是 tablist，组名来自 aria-label", () => {
    mount();

    const group = screen.getByRole("group", { name: "素材类型" });
    expect(group).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("选中项 aria-pressed=true，其余为 false", () => {
    mount("image");

    expect(screen.getByRole("button", { name: "图片" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "视频" })).toHaveAttribute("aria-pressed", "false");
  });

  it("点哪一项就把那一项的值报出去", () => {
    const { onChange } = mount();

    fireEvent.click(screen.getByRole("button", { name: "视频" }));
    expect(onChange).toHaveBeenCalledWith("video");
  });

  it("取消筛选是点回「全部」那一项，不是再点一次选中项", () => {
    const { onChange } = mount("video");

    // 分段控件里再点选中项仍然是选中它自己 —— 语义上「取消」必须有一个可见的去处。
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(onChange).toHaveBeenCalledWith("all");
  });
});
