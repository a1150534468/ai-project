// @vitest-environment jsdom

/**
 * 素材库页面的编排契约。数据层整体替身，断言的是「什么时候发请求、带什么参数、拿到之后怎么摆」。
 *
 * 重点是三件在真实使用中一定会踩、但看代码看不出来的事：
 *  - 换分区 / 换筛选必须**从第一页重来**（键集游标换了条件就没有意义），
 *  - 换分区要**清掉 module**（筛选项是按分区给的，「参考图」在 AI 区里根本不存在），
 *  - 「加载更多」必须带上游标，并且到底之后按钮消失。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../motion";
import Assets from "./Assets";
import type { AssetItem, AssetPage } from "../assetApi";

const apiMocks = vi.hoisted(() => ({ listAssets: vi.fn() }));

vi.mock("../assetApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../assetApi")>()),
  ...apiMocks,
}));

function item(overrides: Partial<AssetItem> & { readonly id: string }): AssetItem {
  return {
    sourceModule: "image",
    origin: "ai",
    mediaType: "image",
    title: overrides.id,
    url: `https://example.test/${overrides.id}`,
    thumbnailUrl: null,
    mime: "image/png",
    width: 1024,
    height: 1024,
    sizeBytes: 2048,
    durationSec: null,
    createdAt: "2026-08-31T10:00:00.000Z",
    groupKey: null,
    groupLabel: null,
    ...overrides,
  };
}

const pageOf = (ids: readonly string[], nextCursor: string | null = null): AssetPage => ({
  items: ids.map((id) => item({ id })),
  nextCursor,
});

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <Assets token="t-1" />
      </ToastProvider>,
    );
  });
}

function find(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function cardIds(): string[] {
  return Array.from(container.querySelectorAll("[data-testid='asset-card']")).map(
    (node) => node.getAttribute("data-asset-id") ?? "",
  );
}

async function click(testId: string) {
  const node = find(testId);
  if (!(node instanceof HTMLElement)) throw new Error(`找不到 ${testId}`);
  await act(async () => {
    node.click();
  });
}

/** 第 n 次调用传给 `listAssets` 的 query（第二个参数）。 */
function queryOf(call: number): Record<string, unknown> {
  return apiMocks.listAssets.mock.calls[call]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  apiMocks.listAssets.mockResolvedValue(pageOf([]));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("素材库首屏", () => {
  it("默认拉「AI 生成」的第一页：不带游标、不带 module", async () => {
    apiMocks.listAssets.mockResolvedValue(pageOf(["image:a", "portrait:b"]));
    await mount();
    expect(apiMocks.listAssets).toHaveBeenCalledTimes(1);
    expect(apiMocks.listAssets.mock.calls[0]?.[0]).toBe("t-1");
    expect(queryOf(0)).toEqual({ limit: 30, origin: "ai", sourceModule: null });
    expect(cardIds()).toEqual(["image:a", "portrait:b"]);
    expect(find("asset-count")?.textContent).toBe("已加载 2 条");
  });

  it("空结果显示空态，不显示「加载更多」", async () => {
    await mount();
    expect(find("asset-empty")).not.toBeNull();
    expect(find("asset-load-more")).toBeNull();
  });

  it("首屏失败给错误条，点重试重新拉一次", async () => {
    apiMocks.listAssets.mockRejectedValueOnce(new Error("库炸了"));
    await mount();
    expect(find("asset-error")?.textContent).toContain("库炸了");
    apiMocks.listAssets.mockResolvedValue(pageOf(["image:a"]));
    const retry = find("asset-error")?.querySelector("button");
    if (!(retry instanceof HTMLElement)) throw new Error("错误条里没有重试按钮");
    await act(async () => retry.click());
    expect(apiMocks.listAssets).toHaveBeenCalledTimes(2);
    expect(find("asset-error")).toBeNull();
    expect(cardIds()).toEqual(["image:a"]);
  });
});

describe("分区与筛选", () => {
  it("切到「我上传的」重新拉第一页，且筛选项换成上传区那两个", async () => {
    await mount();
    await click("asset-origin-upload");
    expect(queryOf(1)).toEqual({ limit: 30, origin: "upload", sourceModule: null });
    expect(find("asset-module-reference")).not.toBeNull();
    expect(find("asset-module-image")).toBeNull();
  });

  it("点同一个分区不重复请求", async () => {
    await mount();
    await click("asset-origin-ai");
    expect(apiMocks.listAssets).toHaveBeenCalledTimes(1);
  });

  it("选 module 透传给接口，再点一次取消回到全部", async () => {
    await mount();
    await click("asset-module-portrait");
    expect(queryOf(1)).toMatchObject({ sourceModule: "portrait" });
    await click("asset-module-portrait");
    expect(queryOf(2)).toMatchObject({ sourceModule: null });
  });

  it("换分区时清掉 module：否则会带着上一区才有的筛选去查", async () => {
    await mount();
    await click("asset-module-audio");
    expect(queryOf(1)).toMatchObject({ origin: "ai", sourceModule: "audio" });
    await click("asset-origin-upload");
    expect(queryOf(2)).toMatchObject({ origin: "upload", sourceModule: null });
  });
});

describe("翻页", () => {
  it("「加载更多」带上游标，第二页接在后面；到底之后按钮消失", async () => {
    apiMocks.listAssets.mockResolvedValueOnce(pageOf(["image:a", "image:b"], "c-1"));
    await mount();
    expect(find("asset-load-more")).not.toBeNull();
    apiMocks.listAssets.mockResolvedValueOnce(pageOf(["image:b", "image:c"], null));
    await click("asset-load-more");
    expect(queryOf(1)).toEqual({ limit: 30, origin: "ai", sourceModule: null, cursor: "c-1" });
    // 同源游标是 lte，第二页会带回 image:b，去重后它只出现一次。
    expect(cardIds()).toEqual(["image:a", "image:b", "image:c"]);
    expect(find("asset-load-more")).toBeNull();
  });

  it("换筛选之后游标重置：新的第一页不带 cursor", async () => {
    apiMocks.listAssets.mockResolvedValueOnce(pageOf(["image:a"], "c-1"));
    await mount();
    apiMocks.listAssets.mockResolvedValueOnce(pageOf(["portrait:x"], null));
    await click("asset-module-portrait");
    expect(queryOf(1)).toEqual({ limit: 30, origin: "ai", sourceModule: "portrait" });
    expect(cardIds()).toEqual(["portrait:x"]);
  });

  it("翻页失败只报错，已加载的那一页留在原地", async () => {
    apiMocks.listAssets.mockResolvedValueOnce(pageOf(["image:a"], "c-1"));
    await mount();
    apiMocks.listAssets.mockRejectedValueOnce(new Error("下一页没了"));
    await click("asset-load-more");
    expect(find("asset-error")?.textContent).toContain("下一页没了");
    expect(cardIds()).toEqual(["image:a"]);
    // 游标还在，用户可以再试一次。
    expect(find("asset-load-more")).not.toBeNull();
  });
});

describe("取件", () => {
  it("点「获取链接」弹出取件弹窗，链接来自素材自己的 url", async () => {
    apiMocks.listAssets.mockResolvedValue(pageOf(["portrait:o1"]));
    await mount();
    const button = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "获取链接",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("卡片上没有取件按钮");
    await act(async () => button.click());
    const input = container.querySelector("input[readonly]");
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe("https://example.test/portrait:o1");
  });

  it("没有取件链接的素材，按钮是禁用的", async () => {
    apiMocks.listAssets.mockResolvedValue({ items: [item({ id: "image:nokey", url: null })], nextCursor: null });
    await mount();
    const button = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "获取链接",
    );
    expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
  });
});
