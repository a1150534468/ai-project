// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortraitWorkflowStudio } from "./PortraitWorkflowStudio";

const mocks = vi.hoisted(() => {
  const refs: any[] = [];
  const tasks: any[] = [];
  return { refs, tasks, create: vi.fn(), upload: vi.fn(), getState: vi.fn(), getOptions: vi.fn(), deleteRef: vi.fn(), deleteTask: vi.fn(), cancel: vi.fn() };
});

vi.mock("../../portraitApi", () => ({
  getPortraitOptions: mocks.getOptions,
  getPortraitState: mocks.getState,
  uploadPortraitReference: mocks.upload,
  createPortraitTask: mocks.create,
  deletePortraitReference: mocks.deleteRef,
  deletePortraitTask: mocks.deleteTask,
  cancelPortraitTask: mocks.cancel,
}));

function options() {
  return {
    model: "doubao-seedream-5-0-260128",
    consentVersion: "portrait-consent-v1",
    presets: [{ id: "business", name: "商务头像", description: "专业" }, { id: "custom", name: "自定义", description: "自定义" }],
    aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["2K", "4K"],
    pricing: { "2K": { resourceKey: "image_generation_2k", displayName: "2K", rate: 20, enabled: true }, "4K": { resourceKey: "image_generation_4k", displayName: "4K", rate: 40, enabled: true } },
  };
}

function reference(id = "ref-1") {
  return { id, mime: "image/jpeg", width: 800, height: 1000, sizeBytes: 1000, previewUrl: `https://example.test/${id}.jpg`, createdAt: "2026-07-22T08:00:00Z" };
}

function task(overrides: Record<string, unknown> = {}) {
  return { id: "task-1", requestId: "portrait-task-1", model: "doubao-seedream-5-0-260128", presetId: "business", aspectRatio: "3:4", resolution: "2K", count: 1, prompt: "", referenceAssetIds: ["ref-1"], status: "completed", completedCount: 1, error: null, billingStatus: "settled", outputs: [{ id: "out-1", index: 0, mime: "image/png", width: 1728, height: 2304, sizeBytes: 2000, originalUrl: "https://example.test/out.png", createdAt: "2026-07-22T08:01:00Z" }], createdAt: "2026-07-22T08:00:00Z", updatedAt: "2026-07-22T08:01:00Z", completedAt: "2026-07-22T08:01:00Z", ...overrides };
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.refs.splice(0, mocks.refs.length);
  mocks.tasks.splice(0, mocks.tasks.length);
  mocks.getOptions.mockResolvedValue(options());
  mocks.getState.mockImplementation(async () => ({ references: [...mocks.refs], tasks: [...mocks.tasks] }));
  mocks.upload.mockImplementation(async (_token: string, _image: unknown) => {
    const asset = reference(`ref-${mocks.refs.length + 1}`);
    mocks.refs.push(asset);
    return { asset };
  });
  mocks.create.mockResolvedValue({ task: task({ status: "running", completedCount: 0, outputs: [] }) });
  mocks.deleteRef.mockResolvedValue({ success: true });
  mocks.deleteTask.mockResolvedValue({ success: true });
  mocks.cancel.mockResolvedValue({ task: task({ status: "cancelled", completedCount: 0, outputs: [] }) });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("PortraitWorkflowStudio", () => {
  it("uploads up to three references and keeps generation gated by consent", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<PortraitWorkflowStudio token="token" />));
    await flush();

    const input = container.querySelector<HTMLInputElement>('[data-testid="portrait-file-input"]');
    expect(input).toBeTruthy();
    if (!input) throw new Error("portrait file input missing");
    const files = [1, 2, 3].map((n) => new File([`image-${n}`], `portrait-${n}.jpg`, { type: "image/jpeg" }));
    Object.defineProperty(input, "files", { configurable: true, value: files });
    act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(3));
    expect(container.textContent).toContain("参考人物 (3/3)");

    const consent = container.querySelector<HTMLInputElement>('input[aria-label="人物授权确认"]');
    const submit = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("生成形象照"));
    expect(consent?.checked).toBe(false);
    expect(submit?.disabled).toBe(true);
    if (!consent || !submit) throw new Error("consent controls missing");
    act(() => { consent.click(); });
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mocks.create).toHaveBeenCalledWith("token", expect.objectContaining({ referenceAssetIds: ["ref-1", "ref-2", "ref-3"], authorizationAccepted: true, consentVersion: "portrait-consent-v1" }));
  });

  it("renders a completed result with a download action and history", async () => {
    mocks.refs.push(reference());
    mocks.tasks.push(task());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<PortraitWorkflowStudio token="token" />));
    await flush();
    expect(container.querySelector('[data-testid="portrait-preview"]')?.getAttribute("src")).toBe("https://example.test/out.png");
    const download = container.querySelector<HTMLAnchorElement>('a[download="portrait-1.png"]');
    expect(download?.getAttribute("href")).toBe("https://example.test/out.png");
    expect(container.textContent).toContain("商务头像");
    expect(container.textContent).toContain("已完成");
    expect(container.querySelector('[aria-label="形象照生成历史"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="形象照任务队列"]')).toBeNull();

    const taskButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("任务 0"));
    expect(taskButton?.getAttribute("aria-expanded")).toBe("false");
    act(() => { taskButton?.click(); });
    expect(container.querySelector('[aria-label="形象照任务队列"]')).toBeTruthy();
  });
});
