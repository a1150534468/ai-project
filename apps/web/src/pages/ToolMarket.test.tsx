// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../motion";
import ToolMarket from "./ToolMarket";

const apiMocks = vi.hoisted(() => ({
  installMarketTool: vi.fn(),
  listInstalledTools: vi.fn(),
  listToolMarketCategories: vi.fn(),
  listToolMarketSkills: vi.fn(),
}));

vi.mock("../api", () => ({
  installMarketTool: apiMocks.installMarketTool,
  listInstalledTools: apiMocks.listInstalledTools,
  listToolMarketCategories: apiMocks.listToolMarketCategories,
  listToolMarketSkills: apiMocks.listToolMarketSkills,
}));

vi.mock("@iconify/react", () => ({
  Icon: ({ icon }: { readonly icon: string }) => <span data-icon={icon} />,
}));

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderToolMarket(container: Element) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <ToastProvider>
        <ToolMarket token="token" />
      </ToastProvider>,
    );
  });
  return root;
}

function findButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${text}`);
  }
  return button;
}

describe("ToolMarket local availability", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    apiMocks.listToolMarketCategories.mockResolvedValue([{ key: "office", label: "办公效率", total: 1 }]);
    apiMocks.listToolMarketSkills.mockResolvedValue({
      key: "office",
      label: "办公效率",
      total: 1,
      skills: [{ id: "913", name: "专案 Claude 配置初始化" }],
    });
    apiMocks.listInstalledTools.mockResolvedValue({
      currentDeviceOnline: true,
      builtin: [],
      installed: [
        {
          id: "install-913",
          categoryKey: "office",
          marketId: "913",
          name: "专案 Claude 配置初始化",
          toolName: "skill_913",
          description: "本地 skill",
          builtin: false,
          installed: true,
          availableOnCurrentDevice: false,
        },
      ],
    });
    apiMocks.installMarketTool.mockResolvedValue({
      id: "install-913",
      categoryKey: "office",
      marketId: "913",
      name: "专案 Claude 配置初始化",
      toolName: "skill_913",
      description: "本地 skill",
      builtin: false,
      installed: true,
      availableOnCurrentDevice: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("区分账号已安装和当前电脑缺包，并允许本机同步", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = renderToolMarket(container);
    await flushEffects();
    await flushEffects();

    expect(container.textContent).toContain("1 个账号已安装 · 0 个当前电脑可用");
    expect(container.textContent).toContain("账号已安装");
    expect(container.textContent).toContain("当前电脑缺包");

    const syncButton = findButtonByText(container, "在本机安装/同步");
    expect(syncButton.disabled).toBe(false);

    await act(async () => {
      syncButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.installMarketTool).toHaveBeenCalledWith("token", { categoryKey: "office", marketId: "913" });

    await flushEffects();
    expect(container.textContent).toContain("1 个账号已安装 · 1 个当前电脑可用");
    expect(container.textContent).toContain("当前电脑可用");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
