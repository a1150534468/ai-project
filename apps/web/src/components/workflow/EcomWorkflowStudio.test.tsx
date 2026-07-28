import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EcomWorkflowStudioView, createEcomMasterPayload, createEcomWorkflowActions } from "./EcomWorkflowStudio";
import { stitchEcomSegments } from "./ecomWorkflowStitch";
import { ECOM_DEFAULT_MODEL_LABEL, ECOM_MAX_REFERENCE_COUNT, ECOM_RESOLUTION_OPTIONS, canSaveEcomStitchedPreview, hasAllSegmentUrls, isEcomWorkflowMutating, seedEcomModelSelection } from "./ecomWorkflowStudioModel";
import type { WorkflowEcomImageAsset, WorkflowEcomPlatform, WorkflowEcomSegment, WorkflowEcomTemplate, WorkflowEcomWorkflow } from "../../workflowEcomApi";

const platforms: readonly WorkflowEcomPlatform[] = [{ id: "taobao", name: "淘宝", market: "domestic" }, { id: "amazon", name: "Amazon", market: "foreign" }];

const templates: readonly WorkflowEcomTemplate[] = [{ id: "general", name: "通用爆款", tag: "General", style: "Clean", master: "master prompt", segments: ["one", "two", "three"] }];

const referenceAsset: WorkflowEcomImageAsset = { id: "ref-1", requestId: "req-1", originalUrl: "https://example.test/ref.png", thumbnailUrl: "https://example.test/ref-thumb.png", mime: "image/png", createdAt: "2026-07-01T08:00:00.000Z" };
const stitchedAsset: WorkflowEcomImageAsset = { id: "stitched-1", requestId: "stitched-req-1", originalUrl: "https://example.test/stitched.png", thumbnailUrl: "https://example.test/stitched-thumb.png", mime: "image/png", createdAt: "2026-07-01T08:20:00.000Z" };

function makeSegment(index: 0 | 1 | 2, url = `https://example.test/segment-${index}.png`): WorkflowEcomSegment {
  return {
    index,
    assetId: `asset-${index}`,
    originalUrl: url,
    thumbnailUrl: `https://example.test/thumb-${index}.png`,
    prompt: `segment ${index}`,
    createdAt: "2026-07-01T08:05:00.000Z",
  };
}

function makeWorkflow(overrides: Partial<WorkflowEcomWorkflow> = {}): WorkflowEcomWorkflow {
  return {
    id: "wf-1",
    platform: "taobao",
    language: "zh-CN",
    template: "general",
    resolution: "1K",
    model: null,
    product: {
      name: "山茶花面霜",
      category: "护肤",
      sellingPoints: ["修护", "轻盈", "送礼"],
      extra: "适合直播间转化",
    },
    referenceAssetIds: ["ref-1"],
    masterAssetId: "master-1",
    masterAsset: { id: "master-1", requestId: "master-req-1", originalUrl: "https://example.test/master.png", thumbnailUrl: "https://example.test/master-thumb.png", mime: "image/png", createdAt: "2026-07-01T08:01:00.000Z" },
    segments: [makeSegment(0), makeSegment(1), makeSegment(2)],
    stitchedAssetId: null,
    stitchedAsset: null,
    stage: "segments_ready",
    error: null,
    billingOperationIds: [],
    segmentCount: 3,
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-07-01T08:10:00.000Z",
    ...overrides,
  };
}

function renderView(workflow: WorkflowEcomWorkflow | null, overrides: Partial<Parameters<typeof EcomWorkflowStudioView>[0]> = {}): string {
  const segmentIndexes = [0, 1, 2] as const;
  const segmentCards = segmentIndexes.map((index) => ({ index, segment: workflow?.segments.find((item) => item.index === index) ?? null }));
  const canStitch = hasAllSegmentUrls(workflow);

  return renderToStaticMarkup(
    <EcomWorkflowStudioView
      platforms={platforms}
      templates={templates}
      selectedPlatformId="taobao"
      selectedTemplateId="general"
      selectedResolution="1K"
      selectedModel="qwen-image-2.0-pro-2026-04-22"
      resolutionOptions={ECOM_RESOLUTION_OPTIONS}
      selectedSegmentCount={3}
      segmentCountOptions={[{ value: "2", label: "2 段" }, { value: "3", label: "3 段" }, { value: "4", label: "4 段" }, { value: "5", label: "5 段" }, { value: "6", label: "6 段" }, { value: "7", label: "7 段" }, { value: "8", label: "8 段" }]}
      masterPointCost={null}
      segmentPointCost={null}
      stitchPointCost={null}
      productName="山茶花面霜"
      category="护肤"
      sellingPointsInput={"修护\n轻盈\n送礼"}
      extra="适合直播间转化"
      referenceAssets={[referenceAsset]}
      remoteReferenceCount={0}
      isForeignPlatform={false}
      stitchedPreviewDataUrl={null}
      isBootstrapping={false}
      isSubmittingMaster={false}
      isRetryingMaster={false}
      isConfirmingSegments={false}
      isUploadingReference={false}
      isStitchingPreview={false}
      isSavingStitched={false}
      isWorkflowMutating={false}
      redrawingIndexes={[]}
      error=""
      notice=""
      workflowError={workflow?.error ?? null}
      stageLabel={workflow?.stage ?? "draft"}
      stageDescription={workflow?.masterAssetId ? "母版已生成，但当前接口未返回预览地址。" : "先生成母版，再确认分段。当前界面只展示接口已知的状态与分段结果。"}
      isServerGenerating={workflow?.stage === "master_running" || workflow?.stage === "segments_running"}
      masterAsset={workflow?.masterAsset ?? null}
      stitchedAsset={workflow?.stitchedAsset ?? null}
      segmentCards={segmentCards}
      canStitch={Boolean(canStitch)}
      canSave={Boolean(canStitch)}
      onPlatformChange={vi.fn()}
      onTemplateChange={vi.fn()}
      onModelChange={vi.fn()}
      onResolutionChange={vi.fn()}
      onSegmentCountChange={vi.fn()}
      onProductNameChange={vi.fn()}
      onCategoryChange={vi.fn()}
      onSellingPointsChange={vi.fn()}
      onExtraChange={vi.fn()}
      onReferenceUpload={vi.fn()}
      onCreateMaster={vi.fn()}
      onRetryMaster={vi.fn()}
      onConfirmSegments={vi.fn()}
      onRedrawSegment={vi.fn()}
      onStitchPreview={vi.fn()}
      onSaveStitched={vi.fn()}
      {...overrides}
    />,
  );
}

describe("EcomWorkflowStudioView", () => {
  it("disables browser stitch and save actions until all three segment original urls exist", () => {
    const workflow = makeWorkflow({ segments: [makeSegment(0), { ...makeSegment(1), originalUrl: "" }], stage: "segment_failed" });

    const html = renderView(workflow);

    expect(html).toContain("第 1 段");
    expect(html).toContain("第 2 段");
    expect(html).toContain("第 3 段");
    expect(html).toMatch(/aria-label="浏览器拼接长图"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="保存拼接长图"[^>]*disabled=""/);
    expect(html).toContain("待生成分段");
    expect(html).toContain("分段失败");
    expect(html).not.toContain("segment_failed");
  });

  it("renders foreign-mode hint and all workflow action controls", () => {
    const html = renderView(makeWorkflow({ stage: "master_failed", segments: [makeSegment(0)] }), { selectedPlatformId: "amazon", isForeignPlatform: true });

    expect(html).toContain("海外平台文案");
    expect(html).toContain("清晰度");
    expect(html).toContain("1K · 768x1024");
    expect(html).toContain("上传参考图");
    expect(html).toContain("生成母版");
    expect(html).toContain("重试主图");
    expect(html).toContain("确认分段");
    expect(html).toContain("重绘第 1 段");
    expect(html).toContain("浏览器拼接长图");
  });

  it("renders the model select with the selected model label", () => {
    const html = renderView(makeWorkflow());

    expect(html).toContain("模型");
    expect(html).toContain("Qwen Image 2.0 Pro");
  });

  it("历史工作流没存模型时显示「默认模型」，不把具体模型显示成已选中", () => {
    const html = renderView(makeWorkflow({ model: null }), { selectedModel: null });

    expect(html).toContain(ECOM_DEFAULT_MODEL_LABEL);
    expect(html).not.toContain("Qwen Image 2.0 Pro");
    expect(html).not.toContain("GPT Image 2");
  });

  it("shows the free-stitch cost row with the combined master + segment estimate in 算力点", () => {
    const html = renderView(makeWorkflow(), { masterPointCost: 20, segmentPointCost: 60 });

    expect(html).toContain("80 算力点");
    expect(html).toContain("母版 20 + 分段 60 · 拼接免费");
    expect(html).not.toContain("约80点");
  });

  it("shows server generation progress and keeps stitch copy user-facing Chinese", () => {
    const html = renderView(makeWorkflow({ stage: "segments_running", segments: [makeSegment(0)] }));

    expect(html).toContain("aria-label=\"生成中\"");
    expect(html).toContain("正在生成");
    expect(html).toContain("三段原图齐全后才可拼接与保存。");
    expect(html).not.toContain("originalUrl");
    expect(html).not.toContain("Canvas");
  });

  it("renders the master preview instead of fallback copy when master asset is available", () => {
    const html = renderView(makeWorkflow(), { stageDescription: "母版已生成" });

    expect(html).toContain("alt=\"母版预览\"");
    expect(html).toContain("src=\"https://example.test/master-thumb.png\"");
    expect(html).not.toContain("当前接口未返回预览地址");
  });

  it("renders saved stitched asset links with the server url instead of only local data urls", () => {
    const html = renderView(makeWorkflow({ stitchedAssetId: "stitched-1", stitchedAsset }), {
      stitchedPreviewDataUrl: "data:image/png;base64,local-preview",
    });

    expect(html).toContain("下载已保存长图");
    expect(html).toContain("打开已保存长图");
    expect(html).toContain("href=\"https://example.test/stitched.png\"");
    expect(html).toContain("href=\"data:image/png;base64,local-preview\"");
  });

  it("disables workflow mutation actions while another workflow mutation is active", () => {
    const html = renderView(makeWorkflow({ stitchedAssetId: "stitched-1", stitchedAsset }), {
      stitchedPreviewDataUrl: "data:image/png;base64,local-preview",
      isWorkflowMutating: true,
    });

    expect(html).toMatch(/>生成母版<\/button>/);
    expect(html).toMatch(/>重试主图<\/button>/);
    expect(html).toMatch(/>确认分段<\/button>/);
    expect(html).toMatch(/>重绘第 1 段<\/button>/);
    expect(html).toMatch(/aria-label="浏览器拼接长图"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="保存拼接长图"[^>]*disabled=""/);
    expect(html).toMatch(/>生成母版<\/button>/);
    expect(html).toMatch(/>重试主图<\/button>/);
    expect(html).toMatch(/>确认分段<\/button>/);
    expect(html).toMatch(/>重绘第 1 段<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>生成母版<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重试主图<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认分段<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重绘第 1 段<\/button>/);
  });
});

describe("createEcomMasterPayload", () => {
  it("keeps ecommerce controls within the reused Qwen image capabilities", () => {
    expect(ECOM_RESOLUTION_OPTIONS.map((option) => option.value)).toEqual(["1K", "2K"]);
    expect(ECOM_MAX_REFERENCE_COUNT).toBe(3);
  });

  it("keeps the selected foreign platform and model in submitted payload", () => {
    expect(createEcomMasterPayload({
      platformId: "amazon",
      templateId: "general",
      resolution: "4K",
      model: "gpt-image-2",
      productName: "  Lamp  ",
      category: "  Home  ",
      sellingPointsInput: "soft light\nfast shipping\n\n",
      extra: "  bundle gift box  ",
      referenceAssetIds: ["ref-1"],
      segmentCount: 3,
    })).toEqual({
      platformId: "amazon",
      templateId: "general",
      resolution: "4K",
      model: "gpt-image-2",
      product: {
        name: "Lamp",
        category: "Home",
        sellingPoints: ["soft light", "fast shipping"],
        extra: "bundle gift box",
      },
      referenceAssetIds: ["ref-1"],
      segmentCount: 3,
    });
  });

  it("model 为 null 时不下发 model 字段，交给服务端默认模型", () => {
    const payload = createEcomMasterPayload({
      platformId: "taobao",
      templateId: "general",
      resolution: "1K",
      model: null,
      productName: "面霜",
      category: "护肤",
      sellingPointsInput: "修护",
      extra: "",
      referenceAssetIds: [],
      segmentCount: 3,
    });

    expect(payload.model).toBeUndefined();
  });
});

describe("seedEcomModelSelection", () => {
  it("历史工作流 model 为空时保留用户当前选择", () => {
    expect(seedEcomModelSelection(null, null)).toBeNull();
    expect(seedEcomModelSelection(null, undefined)).toBeNull();
    expect(seedEcomModelSelection(null, "")).toBeNull();
    expect(seedEcomModelSelection("gpt-image-2", null)).toBe("gpt-image-2");
  });

  it("只有工作流存了合法模型才回填下拉，未知模型不回填", () => {
    expect(seedEcomModelSelection(null, "gpt-image-2")).toBe("gpt-image-2");
    expect(seedEcomModelSelection("gpt-image-2", "qwen-image-2.0-pro-2026-04-22")).toBe("qwen-image-2.0-pro-2026-04-22");
    expect(seedEcomModelSelection(null, "some-removed-model")).toBeNull();
    expect(seedEcomModelSelection("gpt-image-2", "some-removed-model")).toBe("gpt-image-2");
  });
});

describe("createEcomWorkflowActions", () => {
  it("wires master retry, confirm, redraw and stitch requests to the client", async () => {
    const workflow = makeWorkflow();
    const client = {
      createWorkflowEcomMaster: vi.fn(async () => workflow),
      retryWorkflowEcomMaster: vi.fn(async () => workflow),
      confirmWorkflowEcomSegments: vi.fn(async () => workflow),
      redrawWorkflowEcomSegment: vi.fn(async () => workflow),
      stitchWorkflowEcom: vi.fn(async () => workflow),
      adoptWorkflowEcomMaster: vi.fn(async () => workflow),
      listWorkflowEcomHistory: vi.fn(async () => []),
    };

    const actions = createEcomWorkflowActions(client, "token-1");
    await actions.createMaster({ platformId: "amazon", templateId: "general", resolution: "2K", model: "doubao-seedream-4-5-251128", productName: "Lamp", category: "Home", sellingPointsInput: "soft light", extra: "", referenceAssetIds: [], segmentCount: 3 });
    await actions.retryMaster("wf-1");
    await actions.confirmSegments("wf-1");
    await actions.redrawSegment("wf-1", 2);
    await actions.saveStitched("wf-1", "stitched-b64");

    expect(client.createWorkflowEcomMaster).toHaveBeenCalledWith("token-1", expect.objectContaining({ platformId: "amazon", model: "doubao-seedream-4-5-251128" }));
    expect(client.retryWorkflowEcomMaster).toHaveBeenCalledWith("token-1", "wf-1");
    expect(client.confirmWorkflowEcomSegments).toHaveBeenCalledWith("token-1", "wf-1");
    expect(client.redrawWorkflowEcomSegment).toHaveBeenCalledWith("token-1", "wf-1", 2);
    expect(client.stitchWorkflowEcom).toHaveBeenCalledWith("token-1", "wf-1", { b64: "stitched-b64", mime: "image/png" });
  });
});

describe("ecom workflow studio state", () => {
  it("marks workflow as mutating when any workflow mutation is in progress and blocks stale stitched preview saves", () => {
    expect(isEcomWorkflowMutating({
      isSubmittingMaster: false,
      isRetryingMaster: true,
      isConfirmingSegments: false,
      isSavingStitched: false,
      isStitchingPreview: false,
      redrawingCount: 0,
      isServerGenerating: false,
    })).toBe(true);
    expect(canSaveEcomStitchedPreview({
      canStitch: true,
      hasWorkflow: true,
      hasPreview: true,
      isWorkflowMutating: true,
    })).toBe(false);
  });
});

describe("stitchEcomSegments", () => {
  it("scales every segment to the max width before vertical stitching", async () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const fetchBlob = vi.fn(async (url: string) => new Blob([url], { type: "image/png" }));
    let objectUrlIndex = 0;
    const createObjectUrl = vi.fn(() => `blob:${objectUrlIndex++}`);
    const revokeObjectUrl = vi.fn();
    const loadImage = vi.fn(async (src: string) => {
      const map: Record<string, { readonly source: string; readonly width: number; readonly height: number }> = {
        "blob:0": { source: "img-0", width: 800, height: 400 },
        "data:image/png;base64,BBB": { source: "img-1", width: 1200, height: 500 },
        "blob:1": { source: "img-2", width: 600, height: 600 },
      };
      return map[src];
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect,
        drawImage,
      }),
      toDataURL: () => "data:image/png;base64,stitched-base64",
    };

    const result = await stitchEcomSegments({ segments: [{ index: 0, originalUrl: "https://example.test/segment-0.png" }, { index: 1, originalUrl: "data:image/png;base64,BBB" }, { index: 2, originalUrl: "https://example.test/segment-2.png" }], fetchBlob, createObjectUrl, revokeObjectUrl, loadImage, createCanvas: () => canvas });

    expect(result).toEqual({
      b64: "stitched-base64",
      dataUrl: "data:image/png;base64,stitched-base64",
      width: 1200,
      height: 2300,
    });
    expect(fetchBlob).toHaveBeenCalledTimes(2);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1200, 2300);
    expect(drawImage).toHaveBeenNthCalledWith(1, "img-0", 0, 0, 1200, 600);
    expect(drawImage).toHaveBeenNthCalledWith(2, "img-1", 0, 600, 1200, 500);
    expect(drawImage).toHaveBeenNthCalledWith(3, "img-2", 0, 1100, 1200, 1200);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:0");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:1");
  });

  it("rejects zero-sized segment images before drawing", async () => {
    await expect(stitchEcomSegments({
      segments: [{ index: 0, originalUrl: "data:image/png;base64,AAA" }, { index: 1, originalUrl: "data:image/png;base64,BBB" }, { index: 2, originalUrl: "data:image/png;base64,CCC" }],
      loadImage: vi.fn(async () => ({ source: "img", width: 0, height: 600 })),
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
        toDataURL: () => "data:image/png;base64,stitched-base64",
      }),
    })).rejects.toThrow("分段图片尺寸无效");
  });

  it("rejects unexpected canvas output when png data url is missing", async () => {
    await expect(stitchEcomSegments({
      segments: [{ index: 0, originalUrl: "data:image/png;base64,AAA" }, { index: 1, originalUrl: "data:image/png;base64,BBB" }, { index: 2, originalUrl: "data:image/png;base64,CCC" }],
      loadImage: vi.fn(async () => ({ source: "img", width: 600, height: 600 })),
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
        toDataURL: () => "not-a-data-url",
      }),
    })).rejects.toThrow("拼接结果导出失败");
  });
});
