// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TryOnWorkflowStudio } from "./TryOnWorkflowStudio";

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
}));

vi.mock("../../tryOnApi", () => ({
  getTryOnOptions: mocks.getOptions,
  getTryOnState: mocks.getState,
  uploadTryOnReference: mocks.upload,
  deleteTryOnReference: mocks.deleteRef,
  createTryOnTask: mocks.create,
  cancelTryOnTask: mocks.cancel,
  deleteTryOnTask: mocks.deleteTask,
}));

function options() {
  return {
    model: "doubao-seedream-5-0-260128",
    models: [
      { value: "doubao-seedream-5-0-260128", label: "豆包 Seedream 5.0", supports1K: false, supports4K: true },
      { value: "gpt-image-2", label: "GPT Image 2", supports1K: true, supports4K: false },
    ],
    consentVersion: "try-on-consent-v1",
    aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["1K", "2K", "4K"],
    pricing: {
      "1K": { resourceKey: "image_generation_1k", displayName: "1K", rate: 10, enabled: true },
      "2K": { resourceKey: "image_generation_2k", displayName: "2K", rate: 20, enabled: true },
      "4K": { resourceKey: "image_generation_4k", displayName: "4K", rate: 40, enabled: true },
    },
    pricingByModel: {
      "doubao-seedream-5-0-260128": { "2K": 20, "4K": 40 },
      "gpt-image-2": { "1K": 15, "2K": 25 },
    },
  };
}

function reference(kind: string, id = `${kind}-1`) {
  return {
    id,
    kind,
    mime: "image/jpeg",
    width: 800,
    height: 1000,
    sizeBytes: 1000,
    previewUrl: `https://example.test/${id}.jpg`,
    createdAt: "2026-08-14T08:00:00Z",
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    requestId: "try-on-task-1",
    model: "doubao-seedream-5-0-260128",
    aspectRatio: "3:4",
    resolution: "2K",
    count: 1,
    description: "明亮影棚",
    garmentFrontAssetId: "front-1",
    garmentDetailAssetId: null,
    modelAssetId: null,
    status: "completed",
    completedCount: 1,
    error: null,
    billingStatus: "settled",
    outputs: [
      {
        id: "out-1",
        index: 0,
        mime: "image/png",
        width: 1728,
        height: 2304,
        sizeBytes: 2000,
        originalUrl: "https://example.test/try-on.png",
        createdAt: "2026-08-14T08:01:00Z",
      },
    ],
    createdAt: "2026-08-14T08:00:00Z",
    updatedAt: "2026-08-14T08:01:00Z",
    completedAt: "2026-08-14T08:01:00Z",
    ...overrides,
  };
}

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
  act(() => root?.render(<TryOnWorkflowStudio token="token" />));
  await flush();
  return container;
}

async function upload(scope: HTMLElement, kind: string, name: string) {
  const input = scope.querySelector<HTMLInputElement>(`[data-testid="try-on-file-${kind}"]`);
  if (!input) throw new Error(`missing ${kind} input`);
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([name], name, { type: "image/jpeg" })],
  });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  await waitFor(() =>
    expect(mocks.upload).toHaveBeenCalledWith("token", kind, expect.objectContaining({ mime: "image/jpeg" })),
  );
}

function button(scope: HTMLElement, label: string) {
  return Array.from(scope.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.references.splice(0);
  mocks.tasks.splice(0);
  mocks.getOptions.mockResolvedValue(options());
  mocks.getState.mockImplementation(async () => ({ references: [...mocks.references], tasks: [...mocks.tasks] }));
  mocks.upload.mockImplementation(async (_token: string, kind: string) => {
    const asset = reference(kind, `${kind}-${mocks.references.length + 1}`);
    mocks.references.push(asset);
    return { asset };
  });
  mocks.deleteRef.mockResolvedValue({ success: true });
  mocks.create.mockResolvedValue({ task: task({ status: "running", completedCount: 0, outputs: [] }) });
  mocks.cancel.mockResolvedValue({ task: task({ status: "cancelled", completedCount: 0, outputs: [] }) });
  mocks.deleteTask.mockResolvedValue({ success: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("TryOnWorkflowStudio", () => {
  it("requires a garment front image but allows submission without a model", async () => {
    const scope = await mount();
    const submit = button(scope, "生成试穿图");
    expect(submit?.disabled).toBe(true);

    await upload(scope, "garment_front", "front.jpg");
    await waitFor(() => expect(button(scope, "生成试穿图")?.disabled).toBe(false));
    const description = scope.querySelector<HTMLTextAreaElement>('textarea[aria-label="试穿补充描述"]');
    if (!description) throw new Error("description missing");
    act(() => {
      fireEvent.change(description, { target: { value: "短发模特，城市街景" } });
    });
    await act(async () => {
      button(scope, "生成试穿图")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.create).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        garmentFrontAssetId: "garment_front-1",
        description: "短发模特，城市街景",
        model: "doubao-seedream-5-0-260128",
        resolution: "2K",
      }),
    );
    const payload = mocks.create.mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty("modelAssetId");
    expect(payload).not.toHaveProperty("authorizationAccepted");
  });

  it("shows and enforces authorization only after a model image is uploaded", async () => {
    const scope = await mount();
    await upload(scope, "garment_front", "front.jpg");
    vi.clearAllMocks();
    mocks.upload.mockImplementation(async (_token: string, kind: string) => {
      const asset = reference(kind, "model-1");
      mocks.references.push(asset);
      return { asset };
    });
    await upload(scope, "model", "model.jpg");
    const consent = scope.querySelector<HTMLInputElement>('input[aria-label="试穿模特授权确认"]');
    expect(consent).toBeTruthy();
    expect(button(scope, "生成试穿图")?.disabled).toBe(true);
    act(() => {
      consent?.click();
    });
    expect(button(scope, "生成试穿图")?.disabled).toBe(false);
    await act(async () => {
      button(scope, "生成试穿图")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.create).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        modelAssetId: "model-1",
        authorizationAccepted: true,
        consentVersion: "try-on-consent-v1",
      }),
    );
  });

  it("switches models, pricing, and supported resolution options together", async () => {
    mocks.references.push(reference("garment_front", "front-1"));
    const scope = await mount();
    expect(scope.textContent).toContain("20 算力点");
    act(() => {
      button(scope, "2K · 标准")?.click();
    });
    act(() => {
      button(scope, "4K · 高清")?.click();
    });
    expect(scope.textContent).toContain("40 算力点");
    act(() => {
      button(scope, "豆包 Seedream 5.0")?.click();
    });
    act(() => {
      button(scope, "GPT Image 2")?.click();
    });
    expect(scope.textContent).toContain("25 算力点");
    act(() => {
      button(scope, "2K · 标准")?.click();
    });
    expect(button(scope, "4K · 高清")).toBeUndefined();
    expect(button(scope, "1K · 快速")).toBeTruthy();
  });

  it("renders completed outputs, history, and the task drawer", async () => {
    mocks.references.push(reference("garment_front", "front-1"));
    mocks.tasks.push(task());
    const scope = await mount();
    expect(scope.querySelector('[data-testid="try-on-preview"]')?.getAttribute("src")).toBe(
      "https://example.test/try-on.png",
    );
    expect(scope.querySelector('[aria-label="服装试穿生成历史"]')).toBeTruthy();
    act(() => {
      button(scope, "任务 0")?.click();
    });
    expect(scope.querySelector('[aria-label="服装试穿任务队列"]')).toBeTruthy();
    expect(scope.textContent).toContain("明亮影棚");
  });
});
