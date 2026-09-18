// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Workflow from "./Workflow";

const probe = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("../components/workflow/useImageWorkflowStudio", () => ({
  useImageWorkflowStudio: (options: unknown) => {
    probe.hook(options);
    return { studioProps: {} };
  },
}));
function Draft({ label }: { label: string }) {
  const [value, setValue] = useState("");
  return <input aria-label={`${label}草稿`} value={value} onChange={(event) => setValue(event.target.value)} />;
}
vi.mock("../components/workflow/ImageWorkflowStudio", () => ({
  ImageWorkflowStudio: () => <Draft label="通用生图" />,
}));
vi.mock("../components/workflow/CommerceImageStudio", () => ({ CommerceImageStudio: () => <Draft label="电商图" /> }));
vi.mock("../components/workflow/ProductExtractionWorkflowStudio", () => ({
  ProductExtractionWorkflowStudio: () => <Draft label="商品提取" />,
}));
vi.mock("../components/workflow/PortraitWorkflowStudio", () => ({
  PortraitWorkflowStudio: () => <Draft label="形象照" />,
}));
vi.mock("../components/workflow/TryOnWorkflowStudio", () => ({
  TryOnWorkflowStudio: () => <Draft label="万物试穿" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("完整生图工作台回归", () => {
  it("五个入口挂载各自工作台，来回切换不丢任何已填写草稿", () => {
    render(<Workflow token="local-test" activeModuleId="image" />);
    const labels = ["通用生图", "电商图", "商品提取", "形象照", "万物试穿"];
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(screen.queryByLabelText("形象照草稿")).toBeNull();
    for (const label of labels) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
        screen.getByRole("tab", { name: label }).id,
      );
      fireEvent.change(screen.getByRole("textbox", { name: `${label}草稿` }), { target: { value: `保留${label}` } });
    }
    for (const label of labels) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      expect((screen.getByRole("textbox", { name: `${label}草稿` }) as HTMLInputElement).value).toBe(`保留${label}`);
    }
  });

  it("通用生图被关闭时自动展示电商图，该默认工作台也保留草稿", () => {
    render(<Workflow token="local-test" activeModuleId="image" menuVisibility={{ "workflow.image.general": false }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "电商图草稿" }), { target: { value: "不能丢失" } });
    fireEvent.click(screen.getByRole("tab", { name: "形象照" }));
    fireEvent.click(screen.getByRole("tab", { name: "电商图" }));
    expect((screen.getByRole("textbox", { name: "电商图草稿" }) as HTMLInputElement).value).toBe("不能丢失");
    expect(screen.queryByRole("tab", { name: "通用生图" })).toBeNull();
  });

  it("菜单动态关闭当前场景后回落到可见场景，全部关闭显示明确空态", () => {
    const { rerender } = render(<Workflow token="local-test" activeModuleId="image" />);
    fireEvent.click(screen.getByRole("tab", { name: "万物试穿" }));
    rerender(
      <Workflow token="local-test" activeModuleId="image" menuVisibility={{ "workflow.image.try-on": false }} />,
    );
    expect(screen.getByRole("tab", { name: "通用生图" }).getAttribute("aria-selected")).toBe("true");
    rerender(
      <Workflow
        token="local-test"
        activeModuleId="image"
        menuVisibility={{
          "workflow.image.general": false,
          "workflow.image.ecom": false,
          "workflow.image.product-extraction": false,
          "workflow.image.portrait": false,
          "workflow.image.try-on": false,
        }}
      />,
    );
    expect(screen.getByText("生图模块暂未开放")).toBeTruthy();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("通用生图历史过滤商品提取任务，避免两个场景串历史", () => {
    render(<Workflow token="local-test" activeModuleId="image" />);
    const { requestFilter } = probe.hook.mock.calls[0]![0] as { requestFilter: (requestId: string) => boolean };
    expect(requestFilter("img-qa-1")).toBe(true);
    expect(requestFilter("product-extract-qa-1")).toBe(false);
  });
});
