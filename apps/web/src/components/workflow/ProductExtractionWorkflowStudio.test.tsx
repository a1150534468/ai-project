// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateWorkflowImagesPayload, WorkflowImageAsset, WorkflowImageTask } from "../../api";
import { ToastProvider } from "../../motion";
import { ProductExtractionWorkflowStudio } from "./ProductExtractionWorkflowStudio";

const apiMocks = vi.hoisted(() => ({
  cancelWorkflowImageTask: vi.fn(),
  generateWorkflowImages: vi.fn(),
  getImageWorkflowPricing: vi.fn(),
  getWorkflowImageState: vi.fn(),
  optimizeWorkflowPrompt: vi.fn(),
  uploadWorkflowImageReference: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...apiMocks,
}));

function asset(overrides: Partial<WorkflowImageAsset> = {}): WorkflowImageAsset {
  return {
    id: "product-ref-1",
    requestId: "ecom-reference:ref-1",
    requestIndex: 0,
    prompt: "image_reference_upload",
    model: "image_reference_upload",
    size: "reference",
    originalUrl: "https://example.test/product.png",
    thumbnailUrl: "https://example.test/product-thumb.png",
    mime: "image/png",
    createdAt: "2026-08-31T08:00:00Z",
    ...overrides,
  };
}

function task(payload: GenerateWorkflowImagesPayload): WorkflowImageTask {
  return {
    id: "db-task-1",
    requestId: payload.requestId,
    prompt: payload.prompt,
    model: payload.model,
    size: payload.size,
    referenceAssetIds: payload.referenceAssetIds ?? [],
    sourceImageAssetId: payload.sourceImageAssetId ?? null,
    generationIntent: payload.generationIntent ?? "new",
    count: payload.count,
    status: "running",
    completedCount: 0,
    error: null,
    createdAt: "2026-08-31T08:01:00Z",
    updatedAt: "2026-08-31T08:01:00Z",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mountStudio(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <ProductExtractionWorkflowStudio token="token" />
      </ToastProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  apiMocks.getWorkflowImageState.mockResolvedValue({
    images: [asset({ id: "general-image", requestId: "img-general-1" })],
    tasks: [],
  });
  apiMocks.getImageWorkflowPricing.mockResolvedValue({
    "1K": {
      resourceKey: "image_generation_1k",
      displayName: "1K",
      pricingType: "PER_CALL",
      rate: 20,
      perUnits: 1,
      enabled: true,
    },
    "2K": {
      resourceKey: "image_generation_2k",
      displayName: "2K",
      pricingType: "PER_CALL",
      rate: 40,
      perUnits: 1,
      enabled: true,
    },
    "4K": {
      resourceKey: "image_generation_4k",
      displayName: "4K",
      pricingType: "PER_CALL",
      rate: 80,
      perUnits: 1,
      enabled: true,
    },
  });
  apiMocks.uploadWorkflowImageReference.mockResolvedValue(asset());
  apiMocks.generateWorkflowImages.mockImplementation(
    async (_token: string, payload: GenerateWorkflowImagesPayload) => ({
      task: task(payload),
      recent: [
        asset({
          id: "product-output-1",
          requestId: payload.requestId,
          prompt: payload.prompt,
          model: payload.model,
          size: payload.size,
        }),
      ],
    }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("ProductExtractionWorkflowStudio", () => {
  it("uploads one source image and submits a single scoped image-edit task", async () => {
    const scope = await mountStudio();
    expect(scope.textContent).not.toContain("image_reference_upload");

    const fileInput = scope.querySelector<HTMLInputElement>('[data-testid="product-extraction-file-input"]');
    if (!fileInput) throw new Error("product extraction file input missing");
    const file = new File(["png"], "product.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(apiMocks.uploadWorkflowImageReference).toHaveBeenCalledOnce());
    await waitFor(() => expect(scope.querySelector('img[alt="商品原图"]')).toBeTruthy());

    const description = scope.querySelector<HTMLTextAreaElement>('[aria-label="商品描述"]');
    if (!description) throw new Error("product description missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(description, "黑色皮质单肩包，保留金色搭扣");
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submit = Array.from(scope.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("提取商品"),
    );
    if (!submit) throw new Error("product extraction submit button missing");
    await act(async () => {
      submit.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(apiMocks.generateWorkflowImages).toHaveBeenCalledOnce());
    const payload = apiMocks.generateWorkflowImages.mock.calls[0]?.[1] as GenerateWorkflowImagesPayload;
    expect(payload.requestId).toMatch(/^product-extract-/);
    expect(payload.referenceAssetIds).toEqual(["product-ref-1"]);
    expect(payload.generationIntent).toBe("new");
    expect(payload.count).toBe(1);
    expect(payload.size).toBe("1024x1024");
    expect(payload.prompt).toContain("商品描述：黑色皮质单肩包，保留金色搭扣");
    expect(payload.prompt).toContain("正上方俯拍的平铺陈列视角");
    expect(payload.prompt).toContain("纯白色（#FFFFFF）");
  });
});
