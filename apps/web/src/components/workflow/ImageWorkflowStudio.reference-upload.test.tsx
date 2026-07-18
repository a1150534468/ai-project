// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageWorkflowStudio } from "./ImageWorkflowStudio";

function props(overrides: Partial<ComponentProps<typeof ImageWorkflowStudio>> = {}): ComponentProps<typeof ImageWorkflowStudio> {
  return {
    prompt: "产品摄影",
    model: "qwen-image-2.0-pro-2026-04-22",
    size: "1024x1024",
    aspectRatio: "1:1",
    resolution: "1K",
    countInput: "1",
    selectedQuickCount: 1,
    error: "",
    notice: "",
    tasks: [],
    images: [],
    previewImages: [],
    isGenerating: false,
    generatingCount: 0,
    isOptimizingPrompt: false,
    estimatedPointCost: 10,
    referenceImages: [],
    isUploadingReference: false,
    onPromptChange: vi.fn(),
    onModelChange: vi.fn(),
    onAspectRatioChange: vi.fn(),
    onResolutionChange: vi.fn(),
    onCountInputChange: vi.fn(),
    onQuickCountChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancelTask: vi.fn(),
    onSelectTask: vi.fn(),
    onSelectHistoryImage: vi.fn(),
    onOptimizePrompt: vi.fn(),
    onDownloadOne: vi.fn(),
    onDownloadAll: vi.fn(),
    onReferenceUpload: vi.fn(),
    onRemoveReference: vi.fn(),
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ImageWorkflowStudio reference upload", () => {
  it("opens the hidden file input and forwards the selected image", () => {
    const onReferenceUpload = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<ImageWorkflowStudio {...props({ onReferenceUpload })} />));

    const uploadButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("上传参考图"));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(uploadButton).toBeTruthy();
    expect(input).toBeTruthy();
    if (!uploadButton || !input) throw new Error("reference upload controls missing");
    const inputClick = vi.spyOn(input, "click");

    act(() => uploadButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(inputClick).toHaveBeenCalledOnce();

    const file = new File(["png"], "reference.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onReferenceUpload).toHaveBeenCalledWith(file);
  });

  it("keeps reference uploads available for GPT Image 2 edits", () => {
    const onReferenceUpload = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<ImageWorkflowStudio {...props({ model: "gpt-image-2", onReferenceUpload })} />));

    const uploadButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("上传参考图"));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(uploadButton?.disabled).toBe(false);
    expect(input?.disabled).toBe(false);

    if (!input) throw new Error("reference upload input missing");
    const file = new File(["png"], "gpt-reference.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onReferenceUpload).toHaveBeenCalledWith(file);
  });
});
