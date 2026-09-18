// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Workflow from "./Workflow";
import { ToastProvider } from "../motion";

describe("Workflow image hub", () => {
  it("完整生图包含五个场景入口，默认显示通用生图", () => {
    const html = renderToStaticMarkup(<ToastProvider><Workflow token="token" activeModuleId="image" /></ToastProvider>);
    expect((html.match(/role="tab"/g) ?? [])).toHaveLength(5);
    for (const label of ["通用生图", "电商图", "商品提取", "形象照", "万物试穿"]) expect(html).toContain(label);
    expect(html).toContain("生成图片");
    expect(html).not.toContain("生图模块暂未开放");
  });

  it("后台关掉全部场景后整页给出「暂未开放」而不是空白", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <Workflow
          token="token"
          activeModuleId="image"
          menuVisibility={{ "workflow.image.general": false, "workflow.image.ecom": false, "workflow.image.product-extraction": false, "workflow.image.portrait": false, "workflow.image.try-on": false }}
        />
      </ToastProvider>,
    );
    expect(html).toContain("生图模块暂未开放");
    expect(html).not.toContain("生成图片");
  });
});

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

describe("Workflow 通用生图重试", () => {
  it("连点重新提交只发一次请求：同一原任务的重试在飞行中被忽略", async () => {
    let releaseGenerate: (() => void) | null = null;
    const generateGate = new Promise<void>((resolve) => { releaseGenerate = resolve; });
    const generateCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
