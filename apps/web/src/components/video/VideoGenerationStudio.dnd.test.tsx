// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoGenerationStudio } from "./VideoGenerationStudio";
import type { MaterialKind } from "../../videoApi";

const noCounts: Record<MaterialKind, number> = { image: 0, video: 0, audio: 0 };

function baseProps(overrides: Partial<ComponentProps<typeof VideoGenerationStudio>> = {}): ComponentProps<typeof VideoGenerationStudio> {
  return {
    prompt: "",
    model: "seedance-2",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSec: 8,
    generateAudio: true,
    materials: [],
    materialCounts: noCounts,
    inputVideoDurationSec: 0,
    materialNotice: "",
    error: "",
    isSubmitting: false,
    pricingRows: [],
    tasks: [],
    videos: [],
    onPromptChange: vi.fn(),
    onModelChange: vi.fn(),
    onAspectRatioChange: vi.fn(),
    onResolutionChange: vi.fn(),
    onDurationChange: vi.fn(),
    onGenerateAudioChange: vi.fn(),
    onRemoveMaterial: vi.fn(),
    onUploadMaterial: vi.fn(),
    onHelpWrite: vi.fn(),
    onNewTask: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

function fireDrop(target: Element, files: File[]): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  target.dispatchEvent(event);
}

describe("VideoGenerationStudio 拖放上传", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("拖入文件时对每个文件调用 onUploadMaterial", async () => {
    const onUploadMaterial = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<VideoGenerationStudio {...baseProps({ onUploadMaterial })} />);
    });

    const dropZone = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.includes("拖入或点击上传"));
    expect(dropZone).toBeTruthy();

    const fileA = new File(["a"], "a.png", { type: "image/png" });
    const fileB = new File(["b"], "b.mp4", { type: "video/mp4" });
    await act(async () => {
      fireDrop(dropZone as Element, [fileA, fileB]);
    });

    expect(onUploadMaterial).toHaveBeenCalledTimes(2);
    expect(onUploadMaterial).toHaveBeenNthCalledWith(1, fileA);
    expect(onUploadMaterial).toHaveBeenNthCalledWith(2, fileB);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("空拖放不触发上传", async () => {
    const onUploadMaterial = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<VideoGenerationStudio {...baseProps({ onUploadMaterial })} />);
    });
    const dropZone = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.includes("拖入或点击上传"));
    await act(async () => {
      fireDrop(dropZone as Element, []);
    });
    expect(onUploadMaterial).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
