// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Workflow from "./Workflow";
import { ToastProvider } from "../motion";

describe("Workflow image hub", () => {
  it("生图 Hub 只剩通用生图一个 tab：不渲染 tab 栏，studio 直接铺开", () => {
    const html = renderToStaticMarkup(<ToastProvider><Workflow token="token" activeModuleId="image" /></ToastProvider>);
    // 只有一个 tab 时 tab 栏整体不渲染，所以「通用生图」这个标签不该出现
    expect(html).not.toContain("通用生图");
    expect(html).toContain("生成图片");
    expect(html).not.toContain("生图模块暂未开放");
  });

  it("后台关掉通用生图后整页给出「暂未开放」而不是空白", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <Workflow
          token="token"
          activeModuleId="image"
          menuVisibility={{ "workflow.image.general": false }}
        />
      </ToastProvider>,
    );
    expect(html).toContain("生图模块暂未开放");
    expect(html).not.toContain("生成图片");
  });
});

const PRICING_PATH = "/api/workflow/images/pricing";

function pricingBody(rate: number) {
  return {
    data: {
      "1K": { resourceKey: "image_generation_1k", displayName: "1K", pricingType: "PER_CALL", rate, perUnits: 1, enabled: true },
      "2K": { resourceKey: "image_generation_2k", displayName: "2K", pricingType: "PER_CALL", rate: rate * 2, perUnits: 1, enabled: true },
      "4K": { resourceKey: "image_generation_4k", displayName: "4K", pricingType: "PER_CALL", rate: rate * 4, perUnits: 1, enabled: true },
    },
  };
}

function failedTask() {
  return {
    id: "db-1",
    requestId: "img-failed-1",
    prompt: "失败任务提示词",
    model: "qwen-image-2.0-pro-2026-04-22",
    size: "1024x1024",
    referenceAssetIds: [],
    sourceImageAssetId: null,
    generationIntent: "new" as const,
    count: 1,
    status: "failed" as const,
    completedCount: 0,
    error: "上游超时",
    createdAt: "2026-07-22T08:00:00Z",
    updatedAt: "2026-07-22T08:01:00Z",
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mountHub() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ToastProvider><Workflow token="token" activeModuleId="image" /></ToastProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (!container) throw new Error("container missing");
  return container;
}

function buttons(scope: HTMLElement) {
  return Array.from(scope.querySelectorAll("button"));
}

function generalStudio(scope: HTMLElement): HTMLElement {
  const studio = scope.querySelector<HTMLElement>('[data-testid="image-studio"]')
    ?? scope.querySelector<HTMLElement>("section");
  if (!studio) throw new Error("general image studio missing");
  return studio;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Workflow 通用生图计价与重试", () => {
  it("切换模型后按新模型重新拉取计价，预估随模型价格变化", async () => {
    const pricingCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(PRICING_PATH)) {
        pricingCalls.push(url);
        return jsonResponse(pricingBody(url.includes("gpt-image-2") ? 45 : 20));
      }
      if (url.startsWith("/api/workflow/images/state")) return jsonResponse({ data: { images: [], tasks: [] } });
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = await mountHub();
    const studio = generalStudio(scope);
    await waitFor(() => expect(pricingCalls.length).toBeGreaterThan(0));
    expect(pricingCalls[0]).toBe(`${PRICING_PATH}?model=qwen-image-2.0-pro-2026-04-22`);
    await waitFor(() => expect(studio.textContent).toContain("20 算力点"));

    const modelTrigger = buttons(studio).find((button) => button.textContent?.includes("Qwen Image 2.0 Pro"));
    if (!modelTrigger) throw new Error("model select trigger missing");
    await act(async () => { modelTrigger.click(); });
    const gptOption = buttons(studio).find((button) => button.getAttribute("role") === "option" && button.textContent?.includes("GPT Image 2"));
    if (!gptOption) throw new Error("gpt model option missing");
    await act(async () => { gptOption.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    await waitFor(() => expect(pricingCalls).toContain(`${PRICING_PATH}?model=gpt-image-2`));
    await waitFor(() => expect(studio.textContent).toContain("45 算力点"));
  });

  it("乱序返回的旧计价响应被丢弃，只认最后一次模型切换的价格", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(PRICING_PATH)) {
        if (url.includes("qwen-image-2.0-pro")) {
          await firstGate;
          return jsonResponse(pricingBody(20));
        }
        return jsonResponse(pricingBody(45));
      }
      if (url.startsWith("/api/workflow/images/state")) return jsonResponse({ data: { images: [], tasks: [] } });
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = await mountHub();
    const studio = generalStudio(scope);
    const modelTrigger = buttons(studio).find((button) => button.textContent?.includes("Qwen Image 2.0 Pro"));
    if (!modelTrigger) throw new Error("model select trigger missing");
    await act(async () => { modelTrigger.click(); });
    const gptOption = buttons(studio).find((button) => button.getAttribute("role") === "option" && button.textContent?.includes("GPT Image 2"));
    if (!gptOption) throw new Error("gpt model option missing");
    await act(async () => { gptOption.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await waitFor(() => expect(studio.textContent).toContain("45 算力点"));

    // 旧模型的响应此刻才回来，不能盖掉新模型的价格
    await act(async () => { releaseFirst?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(studio.textContent).toContain("45 算力点");
    expect(studio.textContent).not.toContain("20 算力点");
  });

  it("连点重新提交只预扣费一次：同一原任务的重试在飞行中被忽略", async () => {
    let releaseGenerate: (() => void) | null = null;
    const generateGate = new Promise<void>((resolve) => { releaseGenerate = resolve; });
    const generateCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(PRICING_PATH)) return jsonResponse(pricingBody(20));
      if (url.startsWith("/api/workflow/images/state")) return jsonResponse({ data: { images: [], tasks: [failedTask()] } });
      if (url === "/api/workflow/images/generate") {
        generateCalls.push(String(init?.body ?? ""));
        await generateGate;
        return jsonResponse({ data: { task: { ...failedTask(), requestId: "img-retry-1", status: "running", error: null }, recent: [] } });
      }
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = await mountHub();
    await waitFor(() => expect(scope.textContent).toContain("失败任务提示词"));

    const studio = generalStudio(scope);
    const drawerTrigger = buttons(studio).find((button) => button.textContent?.includes("任务列表"));
    if (!drawerTrigger) throw new Error("task drawer trigger missing");
    await act(async () => { drawerTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    const retry = buttons(scope).find((button) => button.textContent?.includes("重新提交"));
    if (!retry) throw new Error("retry button missing");
    await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(generateCalls).toHaveLength(1);

    await act(async () => { releaseGenerate?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  });
});
