import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ImageWorkflowStudio } from "./ImageWorkflowStudio";
import type { WorkflowImageAsset } from "../../api";
import type { ImageAspectRatio, ImageResolution, ImageTask } from "../../workflowState";

const runningTask: ImageTask = {
  id: "task-running",
  prompt: "商业美食摄影",
  size: "1024x1024",
  count: 1,
  status: "running",
  completedCount: 0,
  error: "image relay 503 busy",
  createdAt: "2026-06-30T05:34:37.103Z",
  updatedAt: "2026-06-30T05:34:40.103Z",
};

const currentImage: WorkflowImageAsset = {
  id: "image-current",
  requestId: "task-running",
  requestIndex: 0,
  prompt: "当前任务图片",
  model: "gpt-image-2",
  size: "1024x1024",
  originalUrl: "https://example.test/current.png",
  thumbnailUrl: "https://example.test/current-thumb.png",
  mime: "image/png",
  createdAt: "2026-06-30T05:35:37.103Z",
};

const historyImage: WorkflowImageAsset = {
  id: "image-history",
  requestId: "task-history",
  requestIndex: 0,
  prompt: "历史任务图片",
  model: "gpt-image-2",
  size: "1024x1024",
  originalUrl: "https://example.test/history.png",
  thumbnailUrl: "https://example.test/history-thumb.png",
  mime: "image/png",
  createdAt: "2026-06-30T05:20:37.103Z",
};

function makeHistoryImage(index: number): WorkflowImageAsset {
  return {
    id: `image-history-${index}`,
    requestId: `task-history-${index}`,
    requestIndex: 0,
    prompt: `历史图片 ${String(index).padStart(2, "0")}`,
    model: "gpt-image-2",
    size: "1024x1024",
    originalUrl: `https://example.test/history-${index}.png`,
    thumbnailUrl: `https://example.test/history-${index}-thumb.png`,
    mime: "image/png",
    createdAt: "2026-06-30T05:20:37.103Z",
  };
}

function renderStudio({
  images = [],
  previewImages = [],
  estimatedPointCost = null,
}: {
  readonly images?: readonly WorkflowImageAsset[];
  readonly previewImages?: readonly WorkflowImageAsset[];
  readonly estimatedPointCost?: number | null;
} = {}) {
  return renderToStaticMarkup(
    <ImageWorkflowStudio
      prompt="新的生成任务"
      model="qwen-image-2.0-pro-2026-04-22"
      size="1024x1024"
      aspectRatio={"1:1" satisfies ImageAspectRatio}
      resolution={"1K" satisfies ImageResolution}
      countInput="1"
      selectedQuickCount={1}
      error=""
      notice=""
      tasks={[runningTask]}
      images={images}
      previewImages={previewImages}
      isGenerating={true}
      generatingCount={1}
      isOptimizingPrompt={false}
      estimatedPointCost={estimatedPointCost}
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
    />,
  );
}

describe("ImageWorkflowStudio", () => {
  it("keeps the generate button enabled while another task is already running", () => {
    const html = renderStudio();

    expect(html).toContain("image relay 503 busy");
    expect(html).toContain("正在重试");
    expect(html).toContain("取消");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*class="[^"]*bg-brand[^"]*"[^>]*>生成图片<\/button>/);
  });

  it("renders aspect ratio and resolution selectors as in-app dropdowns", () => {
    const html = renderStudio();

    expect(html).toContain("比例");
    expect(html).toContain("分辨率");
    // 非浏览器原生下拉：不应出现 <option>，而是 InAppSelect 的 listbox 触发器
    expect(html).not.toContain("<option");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain("1:1");
    expect(html).toContain("1K");
    expect(html).toContain("Qwen Image 2.0 Pro");
  });

  it("renders estimated point cost hint when pricing is available", () => {
    expect(renderStudio({ estimatedPointCost: 40 })).toContain("算力点");
    expect(renderStudio({ estimatedPointCost: null })).not.toContain("算力点");
  });

  it("keeps historical images out of the preview until selected", () => {
    const html = renderStudio({ images: [currentImage, historyImage], previewImages: [currentImage] });
    const previewHtml = html.slice(html.indexOf("生成预览"));

    expect(html).toContain("最近生成（2 / 50）");
    expect(html).toContain("已完成 1");
    expect(previewHtml).toContain("alt=\"当前任务图片\"");
    expect(previewHtml).not.toContain("alt=\"历史任务图片\"");
  });

  it("renders the full recent image history inside a scrollable list", () => {
    const images = Array.from({ length: 8 }, (_value, index) => makeHistoryImage(index + 1));
    const html = renderStudio({ images });

    expect(html).toContain("最近生成（8 / 50）");
    expect(html).toContain("历史图片 08");
    expect(html).toMatch(/aria-label="最近生成历史记录" class="[^"]*overflow-y-auto[^"]*"/);
  });

  it("renders recent history as thumbnail cards instead of compact prompt pills", () => {
    const html = renderStudio({ images: [historyImage] });

    expect(html).toContain("src=\"https://example.test/history-thumb.png\"");
    expect(html).toContain("alt=\"历史任务图片\"");
    expect(html).toContain("1024x1024 · 第 1 张 ·");
  });
});
