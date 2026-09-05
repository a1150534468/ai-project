// @vitest-environment jsdom

/**
 * 生图工作台外壳的用例。这一层自己只做三件事 —— 判工作区档位、把 id 换成对象、把 props 分给四个子
 * 组件 —— 所以下面按这三件事分组，顺带把子组件的几处约定（历史条报数、页内下拉、抽屉里的重试行）
 * 也钉在这里：它们没有自己的用例文件。
 *
 * 上一版整套 `renderToStaticMarkup` + `expect(html).toContain('class="h-full"')`，把类名当契约钉。
 * 这里换成 jsdom + 角色/文案查询，并且删掉两条从写下那天起就不可能红的断言：`h-[min(62vh,620px)]`
 * 与 `class="h-full min-h-[340px]"` 这两个串全仓库一个都搜不到。它们想说的是「单张结果不再是固定
 * 高度的盒子」，现在改成钉那条真有行为的规矩 —— **单张铺原图、多张铺缩略图**。
 *
 * 新加的都是外壳自己的判断，之前一条都没盖住：
 *  - 不给 `workspaceMode` 时既不进编辑态也不进对比态（原来那句「按有没有预览图算 result / empty」
 *    的回落，算出来的两个值下游一个都不区分，已经在组件里去掉）；
 *  - 顶栏标题的三档：对比 / 选中任务的提示词 / 缺省；
 *  - 任务列表按钮上的「生成中 N」与朗读区的联动 —— 没有在跑就不念；
 *  - `compareImageIds` 缺失时退回结果区，顶栏跟着退；
 *  - 对比两侧的 id 是在 `images` 里查的，`previewImages` 空着也能对比；
 *  - `onSetCurrentVersion` / `onSelectImage` 都不给时，「设为当前版本」落到 `onSelectHistoryImage`。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowImageAsset } from "../../api";
import type { ImageTask } from "../../workflowState";
import { ImageWorkflowStudio } from "./ImageWorkflowStudio";

function image(over: Partial<WorkflowImageAsset> = {}): WorkflowImageAsset {
  const id = over.id ?? "image-current";
  return {
    id,
    requestId: "task-running",
    requestIndex: 0,
    prompt: "当前任务图片",
    model: "gpt-image-2",
    size: "1024x1024",
    originalUrl: `https://example.test/${id}.png`,
    thumbnailUrl: `https://example.test/${id}-thumb.png`,
    mime: "image/png",
    createdAt: "2026-06-30T05:35:37.103Z",
    ...over,
  };
}

/** 缺省是一个「重试中」的任务：running 且带着上一轮的报错，抽屉里那行就该写「正在重试」 */
function task(over: Partial<ImageTask> = {}): ImageTask {
  return {
    id: "task-running",
    prompt: "商业美食摄影",
    size: "1024x1024",
    count: 1,
    status: "running",
    completedCount: 0,
    error: "image relay 503 busy",
    createdAt: "2026-06-30T05:34:37.103Z",
    updatedAt: "2026-06-30T05:34:40.103Z",
    ...over,
  };
}

const current = image();
const history = image({ id: "image-history", requestId: "task-history", prompt: "历史任务图片" });

type Props = ComponentProps<typeof ImageWorkflowStudio>;

/** 只给必填项。可选回调一个都不传，顺带盖住「缺省成空函数、点了不炸」那条。 */
function mount(over: Partial<Props> = {}) {
  return render(
    <ImageWorkflowStudio
      prompt="新的生成任务"
      model="qwen-image-2.0-pro-2026-04-22"
      size="1024x1024"
      aspectRatio="1:1"
      resolution="1K"
      countInput="1"
      selectedQuickCount={1}
      error=""
      notice=""
      tasks={[task()]}
      images={[]}
      previewImages={[]}
      isGenerating={false}
      generatingCount={0}
      isOptimizingPrompt={false}
      referenceImages={[]}
      isUploadingReference={false}
      onPromptChange={vi.fn()}
      onModelChange={vi.fn()}
      onAspectRatioChange={vi.fn()}
      onResolutionChange={vi.fn()}
      onCountInputChange={vi.fn()}
      onQuickCountChange={vi.fn()}
      onSubmit={vi.fn()}
      onCancelTask={vi.fn()}
      onSelectTask={vi.fn()}
      onSelectHistoryImage={vi.fn()}
      onOptimizePrompt={vi.fn()}
      onDownloadOne={vi.fn()}
      onDownloadAll={vi.fn()}
      onReferenceUpload={vi.fn()}
      onRemoveReference={vi.fn()}
      {...over}
    />,
  );
}

const canvas = () => screen.getByRole("region", { name: "当前生成结果" });
const strip = () => screen.getByRole("region", { name: "最近生成历史记录" });
const drawerTrigger = () => screen.getByRole("button", { name: /任务列表/ });

/** 顶栏那个只给屏幕阅读器的朗读区。结果区在生成时也挂一个 role="status"（「正在生成 N 张」）。 */
function announced(): string {
  const regions = screen.getAllByRole("status").filter((node) => !node.textContent?.startsWith("正在生成"));
  expect(regions).toHaveLength(1);
  return regions[0].textContent ?? "";
}

/** 顶栏没有自己的 landmark，就从「任务列表」按钮的父节点取 —— 标题、按钮、朗读区都在这一格里。 */
const topBar = () => drawerTrigger().parentElement as HTMLElement;

describe("ImageWorkflowStudio 工作区档位", () => {
  it("不给 workspaceMode 时既不进编辑态也不进对比态", () => {
    mount({ images: [current], previewImages: [current] });

    expect(screen.getByRole("heading", { name: "创建图片" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成图片" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消编辑" })).toBeNull();
    expect(screen.queryByRole("region", { name: "版本对比" })).toBeNull();
    expect(canvas()).toBeInTheDocument();
  });

  it("editing 档换掉左栏的标题与提交按钮，并把底图带进结果区", () => {
    mount({
      workspaceMode: "editing",
      editBaseImageId: current.id,
      images: [current],
      previewImages: [],
      isGenerating: true,
      generatingCount: 1,
      onCancelEditing: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "基于结果修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成新版本" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消编辑" })).toBeInTheDocument();
    // 底图不在 previewImages 里，是结果区自己补进去的；生成中才挂「原图保留中」
    expect(within(canvas()).getByAltText("当前任务图片")).toBeInTheDocument();
    expect(within(canvas()).getByText("原图保留中")).toBeInTheDocument();
  });

  it("comparing 档铺对比区，两侧的 id 在 images 里查，previewImages 空着也能对比", () => {
    const next = image({ id: "image-new", prompt: "新版本图片" });
    mount({
      workspaceMode: "comparing",
      compareImageIds: [current.id, next.id],
      images: [current, next],
      previewImages: [],
      selectedRequestId: "task-running",
    });

    expect(screen.getByRole("region", { name: "版本对比" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前生成结果" })).toBeNull();
    expect(screen.getByAltText("V1 原图 当前任务图片")).toBeInTheDocument();
    // 窄屏那一格默认铺新版本，所以 V2 出现两次
    expect(screen.getAllByAltText("V2 新版本 新版本图片")).toHaveLength(2);
    // 顶栏跟着换成「版本对比」，不再显示选中任务的提示词
    expect(topBar()).toHaveTextContent("版本对比");
    expect(topBar()).not.toHaveTextContent("商业美食摄影");
  });

  it("compareImageIds 缺失时退回结果区，顶栏一起退", () => {
    mount({
      workspaceMode: "comparing",
      compareImageIds: null,
      images: [current],
      previewImages: [current],
    });

    expect(canvas()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "版本对比" })).toBeNull();
    expect(topBar()).toHaveTextContent("通用生图工作台");
  });

  it("对比的 id 已经不在历史里时，两侧各说各的缺失文案", () => {
    mount({ workspaceMode: "comparing", compareImageIds: ["gone-v1", "gone-v2"], images: [] });

    // 桌面两列一句 V1 的缺失文案 + 一句 V2 的；窄屏那一格铺的是 V2，却也用 V1 那句
    // —— `ImageCompareView` 自己的毛病，这里先钉住现状（那个文件不在本批范围里）
    expect(screen.getAllByText("原始图片已不在最近历史中")).toHaveLength(2);
    expect(screen.getByText("新版本暂不可用")).toBeInTheDocument();
    // 两侧都没图，四颗动作按钮一颗都不该有
    expect(screen.queryByRole("button", { name: "设为当前版本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下载 V1" })).toBeNull();
  });
});

describe("ImageWorkflowStudio 顶栏与任务列表按钮", () => {
  it("没有选中任务时顶栏写缺省标题，结果区写「等待开始」", () => {
    mount();

    expect(topBar()).toHaveTextContent("通用生图工作台");
    expect(within(canvas()).getByRole("heading", { name: "等待开始" })).toBeInTheDocument();
  });

  it("选中任务后顶栏写它的提示词，任务本身也一起下发给结果区", () => {
    mount({ selectedRequestId: "task-running" });

    expect(topBar()).toHaveTextContent("商业美食摄影");
    expect(within(canvas()).getByRole("heading", { name: "1 张 · 1024x1024" })).toBeInTheDocument();
  });

  it("选中的 id 不在任务列表里就退回缺省标题", () => {
    mount({ selectedRequestId: "task-gone" });

    expect(topBar()).toHaveTextContent("通用生图工作台");
    expect(within(canvas()).getByRole("heading", { name: "等待开始" })).toBeInTheDocument();
  });

  it("有任务在跑时按钮报数，朗读区念同一个数", () => {
    mount({ tasks: [task(), task({ id: "task-2", prompt: "另一个任务", error: undefined })] });

    expect(drawerTrigger()).toHaveAccessibleName("任务列表 · 生成中 2");
    expect(announced()).toBe("生成中 2");
  });

  it("没有在跑的任务时按钮只写「任务列表」，朗读区什么都不念", () => {
    mount({ tasks: [task({ status: "completed", completedCount: 1, error: undefined })] });

    expect(drawerTrigger()).toHaveAccessibleName("任务列表");
    expect(announced()).toBe("");
  });

  it("抽屉是受控的：默认关着，点按钮只上报一次，自己不打开", () => {
    const onOpenTaskDrawer = vi.fn();
    mount({ onOpenTaskDrawer });

    expect(drawerTrigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(drawerTrigger());

    expect(onOpenTaskDrawer).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isTaskDrawerOpen 为真时抽屉在，关闭按钮上报 onCloseTaskDrawer", () => {
    const onCloseTaskDrawer = vi.fn();
    mount({ isTaskDrawerOpen: true, onCloseTaskDrawer });

    expect(drawerTrigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "生图任务队列" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭任务队列" }));

    expect(onCloseTaskDrawer).toHaveBeenCalledTimes(1);
  });

  it("不给 onOpenTaskDrawer / onCloseTaskDrawer 也点得动", () => {
    mount({ isTaskDrawerOpen: true });

    expect(() => {
      fireEvent.click(drawerTrigger());
      fireEvent.click(screen.getByRole("button", { name: "关闭任务队列" }));
    }).not.toThrow();
  });
});

describe("ImageWorkflowStudio 预览区与历史条", () => {
  it("历史图只进历史条，不进预览区；历史条按 50 张报数", () => {
    mount({ images: [current, history], previewImages: [current] });

    expect(within(canvas()).getByAltText("当前任务图片")).toBeInTheDocument();
    expect(within(canvas()).queryByAltText("历史任务图片")).toBeNull();
    expect(within(strip()).getByRole("heading", { name: "最近生成（2 / 50）" })).toBeInTheDocument();
    expect(within(strip()).getByAltText("历史任务图片 第 1 张")).toBeInTheDocument();
  });

  it("单张结果铺原图", () => {
    mount({ images: [current], previewImages: [current] });

    expect(within(canvas()).getByAltText("当前任务图片")).toHaveAttribute("src", current.originalUrl);
  });

  it("多张结果铺缩略图", () => {
    const second = image({ id: "image-second", requestIndex: 1, prompt: "批量结果 2" });
    mount({ images: [current, second], previewImages: [current, second] });

    expect(within(canvas()).getByAltText("当前任务图片")).toHaveAttribute("src", current.thumbnailUrl);
    expect(within(canvas()).getByAltText("批量结果 2")).toHaveAttribute("src", second.thumbnailUrl);
  });

  it("历史条按任务分组、铺缩略图，点一张上报 onSelectHistoryImage", () => {
    const onSelectHistoryImage = vi.fn();
    mount({ images: [current, history], previewImages: [], onSelectHistoryImage });

    expect(within(strip()).getByText("当前任务图片")).toBeInTheDocument();
    expect(within(strip()).getByText("历史任务图片")).toBeInTheDocument();
    expect(within(strip()).getByAltText("当前任务图片 第 1 张")).toHaveAttribute("src", current.thumbnailUrl);

    fireEvent.click(within(strip()).getByRole("button", { name: "历史任务图片 第 1 张" }));

    expect(onSelectHistoryImage).toHaveBeenCalledWith(history);
  });

  it("一张都没有时历史条写空态，「全部原图链接」点不动", () => {
    const onDownloadAll = vi.fn();
    mount({ onDownloadAll });

    expect(within(strip()).getByText("暂无生成图片")).toBeInTheDocument();
    expect(within(strip()).getByRole("button", { name: "全部原图链接" })).toBeDisabled();
    expect(within(canvas()).getByText("填写左侧提示词后开始生成")).toBeInTheDocument();
    expect(onDownloadAll).not.toHaveBeenCalled();
  });
});

describe("ImageWorkflowStudio 左栏与任务抽屉", () => {
  it("页内下拉选完比例，值原样上报", () => {
    const onAspectRatioChange = vi.fn();
    mount({ onAspectRatioChange });

    // 触发器的可读名就是当前项的文案
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "16:9" }));

    expect(onAspectRatioChange).toHaveBeenCalledWith("16:9");
  });

  it("有任务在跑时「生成图片」照样能点 —— 这一层不往下传 busy", () => {
    const onSubmit = vi.fn();
    mount({ tasks: [task()], isGenerating: true, generatingCount: 2, onSubmit });

    const submit = screen.getByRole("button", { name: "生成图片" });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("抽屉里 running 带着上一轮报错就写「正在重试」，报错原文照抄", () => {
    const onCancelTask = vi.fn();
    mount({ isTaskDrawerOpen: true, onCancelTask });
    const drawer = screen.getByRole("dialog", { name: "生图任务队列" });

    expect(within(drawer).getByText("正在重试")).toBeInTheDocument();
    expect(within(drawer).getByText("image relay 503 busy")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "取消任务" }));

    expect(onCancelTask).toHaveBeenCalledWith(task());
  });

  it("取消中的任务按钮写「取消中」且点不动，失败的那行给「重新提交」", () => {
    mount({
      isTaskDrawerOpen: true,
      tasks: [task(), task({ id: "task-failed", prompt: "失败任务", status: "failed" })],
      cancellingTaskIds: ["task-running"],
    });
    const drawer = screen.getByRole("dialog", { name: "生图任务队列" });

    expect(within(drawer).getByRole("button", { name: "取消中" })).toBeDisabled();
    expect(within(drawer).getByRole("button", { name: "重新提交" })).toBeInTheDocument();
  });

  it("空态抽屉写「暂无生图任务」", () => {
    mount({ isTaskDrawerOpen: true, tasks: [] });

    expect(within(screen.getByRole("dialog", { name: "生图任务队列" })).getByText("暂无生图任务")).toBeInTheDocument();
  });

  it("onSetCurrentVersion / onSelectImage 都不给时，「设为当前版本」落到 onSelectHistoryImage，实参是 V2", () => {
    const next = image({ id: "image-new", prompt: "新版本图片" });
    const onSelectHistoryImage = vi.fn();
    mount({
      workspaceMode: "comparing",
      compareImageIds: [current.id, next.id],
      images: [current, next],
      onSelectHistoryImage,
    });

    fireEvent.click(screen.getByRole("button", { name: "设为当前版本" }));

    expect(onSelectHistoryImage).toHaveBeenCalledWith(next);
    // onContinueModify / onEditImage 都不给，「继续修改」落到空函数上，点了不炸
    expect(() => fireEvent.click(screen.getByRole("button", { name: "继续修改" }))).not.toThrow();
    expect(onSelectHistoryImage).toHaveBeenCalledTimes(1);
  });
});
