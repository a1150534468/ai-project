// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Workflow from "./Workflow";
import { ToastProvider } from "../motion";

describe("Workflow image hub", () => {
  it("keeps general, e-commerce, and portrait studios mounted under separate tabs", () => {
    const html = renderToStaticMarkup(<ToastProvider><Workflow token="token" activeModuleId="image" /></ToastProvider>);
    expect(html).toContain("通用生图");
    expect(html).toContain("电商生图");
    expect(html).toContain("形象照");
    expect(html).toContain('data-testid="portrait-studio"');
    expect(html).toContain("产品资料");
    expect(html).toContain("商品主图");
    expect(html).toContain("生成图片");
    expect(html).toContain('aria-label="电商图生成历史"');
    expect(html).toContain('aria-label="形象照生成历史"');
    expect(html).toContain("生成概览");
    expect(html).toMatch(/class="hidden"[^>]*><section data-testid="portrait-studio"/);
  });

  it("后台关掉页内 tab 后不渲染对应 studio，只剩一个 tab 时隐藏 tab 栏", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <Workflow
          token="token"
          activeModuleId="image"
          menuVisibility={{ "workflow.image.ecom": false, "workflow.image.portrait": false }}
        />
      </ToastProvider>,
    );
    expect(html).not.toContain("电商生图");
    expect(html).not.toContain("形象照");
    expect(html).not.toContain('data-testid="portrait-studio"');
    expect(html).not.toContain("商品主图");
    expect(html).toContain("生成图片");
  });

  it("当前 tab 被后台关掉时回落到第一个仍开启的 tab", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <Workflow
          token="token"
          activeModuleId="commerce-long-image"
          menuVisibility={{ "workflow.image.ecom": false }}
        />
      </ToastProvider>,
    );
    // 请求的是电商 tab，但它已关闭，落到通用生图
    expect(html).not.toContain("商品主图");
    expect(html).toMatch(/class="hidden"[^>]*><section data-testid="portrait-studio"/);
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
    await waitFor(() => expect(pricingCalls.length).toBeGreaterThan(0));
    expect(pricingCalls[0]).toBe(`${PRICING_PATH}?model=qwen-image-2.0-pro-2026-04-22`);
    await waitFor(() => expect(scope.textContent).toContain("20 算力点"));

    const studio = generalStudio(scope);
    const modelTrigger = buttons(studio).find((button) => button.textContent?.includes("Qwen Image 2.0 Pro"));
    if (!modelTrigger) throw new Error("model select trigger missing");
    await act(async () => { modelTrigger.click(); });
    const gptOption = buttons(studio).find((button) => button.getAttribute("role") === "option" && button.textContent?.includes("GPT Image 2"));
    if (!gptOption) throw new Error("gpt model option missing");
    await act(async () => { gptOption.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    await waitFor(() => expect(pricingCalls).toContain(`${PRICING_PATH}?model=gpt-image-2`));
    await waitFor(() => expect(scope.textContent).toContain("45 算力点"));
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
    await waitFor(() => expect(scope.textContent).toContain("45 算力点"));

    // 旧模型的响应此刻才回来，不能盖掉新模型的价格
    await act(async () => { releaseFirst?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(scope.textContent).toContain("45 算力点");
    expect(scope.textContent).not.toContain("20 算力点");
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

const MAIN_PRICING_PATH = "/api/workflow/ecom/main/pricing";

function mainPricingBody(rate: number) {
  return {
    data: {
      "1K": { resourceKey: "ecom_main_1k", displayName: "1K", rate },
      "2K": { resourceKey: "ecom_main_2k", displayName: "2K", rate: rate * 2 },
      "4K": { resourceKey: "ecom_main_4k", displayName: "4K", rate: rate * 4 },
    },
  };
}

/** 电商 tab 外壳依赖的只读接口：只需要空数据，测试关注的是尺寸门禁与计价。 */
function ecomShellResponse(url: string) {
  if (url.startsWith("/api/workflow/ecom/main/history")) return jsonResponse({ data: { jobs: [] } });
  if (url.startsWith("/api/workflow/ecom/main/current")) return jsonResponse({ data: { job: null } });
  if (url.startsWith("/api/workflow/ecom/history")) return jsonResponse({ data: { workflows: [] } });
  if (url.startsWith("/api/workflow/ecom/current")) return jsonResponse({ data: { workflow: null } });
  if (url.startsWith("/api/workflow/ecom/options")) return jsonResponse({ data: { platforms: [], templates: [] } });
  if (url.startsWith("/api/workflow/ecom/pricing")) return jsonResponse({ data: {} });
  if (url.startsWith("/api/workflow/images/references")) return jsonResponse({ data: { assets: [] } });
  return new Response("{}", { status: 500 });
}

/** 三套 studio 常驻 DOM，模型/清晰度下拉重名，必须限定在主图设置的侧栏里查询。 */
function mainStudioAside(scope: HTMLElement): HTMLElement {
  const aside = Array.from(scope.querySelectorAll("aside")).find((element) => element.textContent?.includes("主图设置"));
  if (!aside) throw new Error("ecom main studio aside missing");
  return aside;
}

async function openEcomMainTab(scope: HTMLElement): Promise<HTMLElement> {
  const ecomTab = buttons(scope).find((button) => button.textContent === "电商生图");
  if (!ecomTab) throw new Error("ecom tab missing");
  await act(async () => { ecomTab.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const mainTab = buttons(scope).find((button) => button.textContent?.includes("商品主图"));
  if (!mainTab) throw new Error("main image tab missing");
  await act(async () => { mainTab.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  return mainStudioAside(scope);
}

async function pickOption(scope: HTMLElement, triggerText: string, optionText: string) {
  const trigger = buttons(scope).find((button) => button.getAttribute("aria-haspopup") === "listbox" && button.textContent?.includes(triggerText));
  if (!trigger) throw new Error(`select trigger missing: ${triggerText}`);
  await act(async () => { trigger.click(); });
  const option = buttons(scope).find((button) => button.getAttribute("role") === "option" && button.textContent?.includes(optionText));
  if (!option) throw new Error(`select option missing: ${optionText}`);
  await act(async () => { option.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function resolutionOptionLabels(scope: HTMLElement): string[] {
  const trigger = buttons(scope).find((button) => button.getAttribute("aria-haspopup") === "listbox" && /^\s*(1K|2K)/.test(button.textContent ?? ""));
  if (!trigger) throw new Error("resolution trigger missing");
  act(() => { trigger.click(); });
  const labels = buttons(scope)
    .filter((button) => button.getAttribute("role") === "option" && /(1K|2K)/.test(button.textContent ?? ""))
    .map((button) => button.textContent ?? "");
  act(() => { trigger.click(); });
  return labels;
}

describe("Workflow 电商主图尺寸门禁与计价", () => {
  it("gpt-image-2 + 16:9 时 2K 档位从下拉里消失，且已选的 2K 自动回落到 1K", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(PRICING_PATH)) return jsonResponse(pricingBody(20));
      if (url.startsWith("/api/workflow/images/state")) return jsonResponse({ data: { images: [], tasks: [] } });
      if (url.startsWith(MAIN_PRICING_PATH)) return jsonResponse(mainPricingBody(url.includes("gpt-image-2") ? 30 : 15));
      return ecomShellResponse(url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = await mountHub();
    const aside = await openEcomMainTab(scope);

    expect(resolutionOptionLabels(aside)).toEqual(["1K 标清", "2K 高清"]);
    await pickOption(aside, "1K 标清", "2K 高清");
    await pickOption(aside, "Qwen Image 2.0 Pro", "GPT Image 2");
    await pickOption(aside, "1:1 方图", "16:9 横图");

    expect(resolutionOptionLabels(aside)).toEqual(["1K 标清"]);
    // 2K 被服务端拒绝的组合下，已选档位回落到 1K：4 张 × 30 点
    await waitFor(() => expect(aside.textContent).toContain("120 算力点"));
  });

  it("电商主图切模型后按新模型计价，乱序旧响应被丢弃", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(PRICING_PATH)) return jsonResponse(pricingBody(20));
      if (url.startsWith("/api/workflow/images/state")) return jsonResponse({ data: { images: [], tasks: [] } });
      if (url.startsWith(MAIN_PRICING_PATH)) {
        if (url.includes("qwen-image-2.0-pro")) {
          await firstGate;
          return jsonResponse(mainPricingBody(15));
        }
        return jsonResponse(mainPricingBody(30));
      }
      return ecomShellResponse(url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = await mountHub();
    const aside = await openEcomMainTab(scope);
    await pickOption(aside, "Qwen Image 2.0 Pro", "GPT Image 2");
    // 默认 4 张 × 1K 30 点
    await waitFor(() => expect(aside.textContent).toContain("120 算力点"));

    await act(async () => { releaseFirst?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(aside.textContent).toContain("120 算力点");
    expect(aside.textContent).not.toContain("60 算力点");
  });
});
