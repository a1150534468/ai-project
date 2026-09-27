// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NailTryOnWorkflowStudio } from "./NailTryOnWorkflowStudio";

const mocks = vi.hoisted(() => ({
  references: [] as any[],
  tasks: [] as any[],
  getOptions: vi.fn(),
  getState: vi.fn(),
  upload: vi.fn(),
  deleteRef: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  deleteTask: vi.fn(),
  buildSubmission: vi.fn(),
  loadImage: vi.fn(),
  tierDims: vi.fn(),
}));

vi.mock("../../nailTryOnApi", () => ({
  getNailTryOnOptions: mocks.getOptions,
  getNailTryOnState: mocks.getState,
  uploadNailTryOnReference: mocks.upload,
  deleteNailTryOnReference: mocks.deleteRef,
  createNailTryOnTask: mocks.create,
  cancelNailTryOnTask: mocks.cancel,
  deleteNailTryOnTask: mocks.deleteTask,
}));

// jsdom 无 canvas 2d：把合成/图片加载/档位换算整体 mock 掉，组件只当纯逻辑测。
vi.mock("../../nailMaskCanvas", () => ({
  buildNailSubmission: mocks.buildSubmission,
  loadImageFromFile: mocks.loadImage,
  humanTierDimensions: mocks.tierDims,
}));
function options() {
  return {
    model: "gpt-image-2",
    models: [
      { value: "gpt-image-2", label: "GPT Image 2", supports1K: true, supports4K: false, supportsMask: true },
      { value: "doubao-seedream-5-0-260128", label: "豆包 Seedream 5.0", supports1K: false, supports4K: true, supportsMask: false },
    ],
    consentVersion: "nail-try-on-consent-v1",
    aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["1K", "2K", "4K"],
    pricing: {},
    pricingByModel: {},
  };
}

function nailTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    requestId: "nail-try-on-task-1",
    model: "gpt-image-2",
    aspectRatio: "3:4",
    resolution: "2K",
    count: 1,
    description: "法式冰川",
    handAssetId: "hand-1",
    nailDesignAssetId: null,
    status: "completed",
    completedCount: 1,
    error: null,
    billingStatus: "settled",
    outputs: [
      { id: "out-1", index: 0, mime: "image/png", width: 1728, height: 2304, sizeBytes: 2000, originalUrl: "https://example.test/nail.png", createdAt: "2026-09-24T08:01:00Z" },
    ],
    createdAt: "2026-09-24T08:00:00Z",
    updatedAt: "2026-09-24T08:01:00Z",
    completedAt: "2026-09-24T08:01:00Z",
    ...overrides,
  };
}
const ctx2d = {
  clearRect: () => {}, drawImage: () => {}, save: () => {}, restore: () => {},
  beginPath: () => {}, arc: () => {}, fill: () => {}, fillRect: () => {},
  globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000000",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<NailTryOnWorkflowStudio token="token" />));
  await flush();
  return container;
}

function button(scope: HTMLElement, label: string) {
  return Array.from(scope.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
}

// 模型/比例/清晰度都是站内自绘下拉（InAppSelect）：先点触发器展开，再点目标选项行。
function selectOption(scope: HTMLElement, triggerLabel: string, optionLabel: string) {
  act(() => button(scope, triggerLabel)?.click());
  const option = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((item) =>
    item.textContent?.includes(optionLabel),
  );
  act(() => option?.click());
}
async function uploadHand(scope: HTMLElement) {
  const input = scope.querySelector<HTMLInputElement>('[data-testid="nail-file-hand"]');
  if (!input) throw new Error("missing hand input");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["hand"], "hand.jpg", { type: "image/jpeg" })],
  });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  await flush();
  expect(scope.querySelector('[aria-label="上传手部照片"]')).toBeNull();
}

// jsdom 下画笔无法真的落墨（ctx/rect 被 stub 成非空），只为把 hasMask 翻成 true。
function paintMask(scope: HTMLElement) {
  const canvas = scope.querySelector<HTMLCanvasElement>('[data-testid="nail-mask-canvas"]');
  if (!canvas) throw new Error("missing mask canvas");
  act(() => canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 40 })));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  URL.createObjectURL = vi.fn(() => "blob:hand") as never;
  URL.revokeObjectURL = vi.fn() as never;
  HTMLCanvasElement.prototype.getContext = (() => ctx2d) as never;
  HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({
    width: 200, height: 267, left: 0, top: 0, right: 200, bottom: 267, x: 0, y: 0, toJSON: () => ({}),
  })) as never;
  mocks.references.splice(0);
  mocks.tasks.splice(0);
  mocks.getOptions.mockResolvedValue(options());
  mocks.getState.mockImplementation(async () => ({ references: [...mocks.references], tasks: [...mocks.tasks] }));
  mocks.loadImage.mockResolvedValue({ image: { naturalWidth: 800, naturalHeight: 1000 }, url: "blob:hand" });
  mocks.tierDims.mockReturnValue({ width: 1728, height: 2304 });
  mocks.buildSubmission.mockReturnValue({ handB64: "hand-b64", maskB64: "mask-b64" });
  mocks.upload.mockImplementation(async (_token: string, kind: string) => {
    const asset = { id: `${kind}-1`, kind, mime: "image/jpeg", width: 800, height: 1000, sizeBytes: 1000, previewUrl: `https://example.test/${kind}.jpg`, createdAt: "2026-09-24T08:00:00Z" };
    mocks.references.push(asset);
    return { asset };
  });
  mocks.create.mockResolvedValue({ task: nailTask({ status: "running", completedCount: 0, outputs: [] }) });
  mocks.cancel.mockResolvedValue({ task: nailTask({ status: "cancelled", completedCount: 0, outputs: [] }) });
  mocks.deleteRef.mockResolvedValue({ success: true });
  mocks.deleteTask.mockResolvedValue({ success: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});
describe("NailTryOnWorkflowStudio", () => {
  it("上传手照、标注指甲并授权后，按档位合成手图与蒙版再下单", async () => {
    const scope = await mount();
    expect(scope.textContent).toContain("试甲台设置");
    expect(scope.textContent).toContain("手部照片与指甲标注");
    expect(scope.textContent).toContain("美甲款式");
    expect(button(scope, "生成试甲效果")?.disabled).toBe(true);

    await uploadHand(scope);
    expect(mocks.loadImage).toHaveBeenCalledTimes(1);
    // 已有手照但未标注指甲、未授权：仍不可下单。
    expect(button(scope, "生成试甲效果")?.disabled).toBe(true);

    paintMask(scope);
    const consent = scope.querySelector<HTMLInputElement>('input[aria-label="试甲手部照片授权确认"]');
    expect(consent).toBeTruthy();
    act(() => consent?.click());
    expect(button(scope, "生成试甲效果")?.disabled).toBe(false);

    await act(async () => {
      button(scope, "生成试甲效果")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.tierDims).toHaveBeenCalledWith("2K", "3:4");
    expect(mocks.buildSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ tierWidth: 1728, tierHeight: 2304 }),
    );
    expect(mocks.upload).toHaveBeenCalledWith("token", "hand", { b64: "hand-b64", mime: "image/jpeg" });
    expect(mocks.create).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        handAssetId: "hand-1",
        mask: { b64: "mask-b64" },
        authorizationAccepted: true,
        consentVersion: "nail-try-on-consent-v1",
        model: "gpt-image-2",
        aspectRatio: "3:4",
        resolution: "2K",
      }),
    );
    expect(mocks.create.mock.calls[0]?.[1]).not.toHaveProperty("nailDesignAssetId");
  });
  it("切到不支持蒙版的模型时警示手部锁定不保证", async () => {
    const scope = await mount();
    expect(scope.textContent).not.toContain("所选模型不支持蒙版");
    selectOption(scope, "GPT Image 2", "豆包 Seedream 5.0");
    expect(scope.textContent).toContain("所选模型不支持蒙版");
    selectOption(scope, "豆包 Seedream 5.0", "GPT Image 2");
    expect(scope.textContent).not.toContain("所选模型不支持蒙版");
  });

  it("展示完成结果、历史条与任务抽屉", async () => {
    mocks.tasks.push(nailTask());
    const scope = await mount();
    expect(scope.querySelector('[data-testid="nail-try-on-preview"]')?.getAttribute("src")).toBe(
      "https://example.test/nail.png",
    );
    expect(scope.querySelector('[aria-label="试甲生成历史"]')).toBeTruthy();
    act(() => button(scope, "任务 0")?.click());
    expect(scope.querySelector('[aria-label="试甲任务队列"]')).toBeTruthy();
    expect(scope.textContent).toContain("法式冰川");
  });
});
