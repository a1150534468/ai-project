// @vitest-environment jsdom

/**
 * 设置页的用例。盯着重写时收掉的这几处：
 * 1. 勾选状态只认 `preferredModel` 这个 prop —— 记住的模型不在列表里时要把兜底那个**报上去**，
 *    上一版只在本页勾上，于是「设置页显示 A、对话页发 B」；
 * 2. 模型列表拉挂了 / 服务端给空列表，两种各有各的话说，上一版都永远转圈；
 * 3. `preferredModel` 变了不重新拉列表（上一版把它写进了 effect 依赖）；
 * 4. 换模型与登出都不再等 `setTimeout`，点完当场就发生；
 * 5. 「跟随系统」是 `components/ui/Switch`，偏好只经 THEME_CHANGE_EVENT / storage 这一条路回来。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../api";
import { THEME_STORAGE_KEY } from "../theme";
import SettingsPage from "./Settings";

const apiMocks = vi.hoisted(() => ({ listModels: vi.fn() }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...apiMocks,
}));

const toastMocks = vi.hoisted(() => ({ show: vi.fn() }));

// 只换掉 toast：RippleButton 还要用真的
vi.mock("../motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../motion")>()),
  useToast: () => ({ show: toastMocks.show }),
}));

const MODELS: ModelOption[] = [
  { model: "qwen-max", displayName: "通义千问 Max" },
  { model: "gpt-4o", displayName: "GPT-4o" },
];

type Props = ComponentProps<typeof SettingsPage>;

function mount(props: Partial<Props> = {}) {
  const onPreferredModelChange = vi.fn();
  const onLogout = vi.fn();
  const all: Props = { onPreferredModelChange, onLogout, ...props };
  const view = render(<SettingsPage {...all} />);

  return {
    ...view,
    onPreferredModelChange,
    onLogout,
    /** 换 prop 重渲染：其余 prop 保持这一次挂载时的样子 */
    update: (next: Partial<Props>) => view.rerender(<SettingsPage {...all} {...next} />),
  };
}

/** 模型列表拉回来之后才算渲染完 —— 三个用例之外都不该在「加载中」上做断言 */
function loaded() {
  return screen.findByRole("radio", { name: "通义千问 Max" });
}

beforeEach(() => {
  apiMocks.listModels.mockResolvedValue(MODELS);
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("账号信息", () => {
  it("标签与值成对念出来，用户 ID 用等宽字体", async () => {
    mount({ uid: "10086", userName: "阿七" });
    await loaded();

    expect(screen.getByText("用户 ID").tagName).toBe("DT");
    expect(screen.getByText("10086")).toHaveClass("font-mono");
    expect(screen.getByText("阿七").tagName).toBe("DD");
  });

  it("上层还没拿到账号时给缺省文案", async () => {
    mount();
    await loaded();

    expect(screen.getByText("未知用户")).toBeInTheDocument();
    expect(screen.getByText("用户")).toBeInTheDocument();
  });
});

describe("模型列表的三档", () => {
  it("加载中只有一句「加载模型列表中…」，没有可选项", async () => {
    let settle: (models: ModelOption[]) => void = () => {};
    apiMocks.listModels.mockReturnValue(
      new Promise<ModelOption[]>((resolve) => {
        settle = resolve;
      }),
    );
    mount();

    expect(screen.getByText("加载模型列表中…")).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);

    settle(MODELS);
    await loaded();
    expect(screen.queryByText("加载模型列表中…")).not.toBeInTheDocument();
  });

  it("断网抛出来：说清是哪一步挂了，不再转圈", async () => {
    apiMocks.listModels.mockRejectedValue(new Error("网络连不上"));
    const { onPreferredModelChange } = mount();

    expect(await screen.findByText("模型列表加载失败：网络连不上")).toBeInTheDocument();
    expect(screen.queryByText("加载模型列表中…")).not.toBeInTheDocument();
    expect(onPreferredModelChange).not.toHaveBeenCalled();
  });

  it("服务端给了空列表：说明会走后端默认模型，也不往上报", async () => {
    apiMocks.listModels.mockResolvedValue([]);
    const { onPreferredModelChange } = mount();

    expect(await screen.findByText("服务端没有给出可选模型，新对话会用它自己的默认模型")).toBeInTheDocument();
    expect(onPreferredModelChange).not.toHaveBeenCalled();
  });
});

describe("默认模型的勾选", () => {
  it("勾着的就是 prop 说的那个", async () => {
    const { onPreferredModelChange } = mount({ preferredModel: "gpt-4o" });
    await loaded();

    expect(screen.getByRole("radio", { name: "GPT-4o" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "通义千问 Max" })).not.toBeChecked();
    // 记住的那个还在列表里，就没什么要报的
    expect(onPreferredModelChange).not.toHaveBeenCalled();
  });

  it("记住的模型下线了：把兜底那个报上去，不是自己在本页勾上", async () => {
    const { onPreferredModelChange } = mount({ preferredModel: "已下线的模型" });
    await loaded();

    expect(onPreferredModelChange).toHaveBeenCalledTimes(1);
    expect(onPreferredModelChange).toHaveBeenCalledWith("qwen-max");
    // 上层还没把新值传回来，这一帧就谁都不勾 —— 假的选中态比空着更糟
    expect(screen.getByRole("radio", { name: "通义千问 Max" })).not.toBeChecked();
  });

  it("从来没记住过也一样：报第一个", async () => {
    const { onPreferredModelChange } = mount();
    await loaded();

    expect(onPreferredModelChange).toHaveBeenCalledWith("qwen-max");
  });

  it("点另一条：当场报上去并给一句提示，不等 200ms", async () => {
    const { onPreferredModelChange } = mount({ preferredModel: "qwen-max" });
    await loaded();

    fireEvent.click(screen.getByRole("radio", { name: "GPT-4o" }));

    expect(onPreferredModelChange).toHaveBeenCalledTimes(1);
    expect(onPreferredModelChange).toHaveBeenCalledWith("gpt-4o");
    expect(toastMocks.show).toHaveBeenCalledWith("ok", "默认模型已保存");
  });

  it("换了首选模型不会再拉一次列表 —— 上一版把它写进了 effect 依赖", async () => {
    const { update } = mount({ preferredModel: "qwen-max" });
    await loaded();

    update({ preferredModel: "gpt-4o" });
    await loaded();

    expect(apiMocks.listModels).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: "GPT-4o" })).toBeChecked();
  });
});

describe("外观", () => {
  function themeSwitch() {
    return screen.getByRole("switch", { name: "跟随系统 使用设备或浏览器的显示模式" });
  }

  it("没存过偏好就是「跟随系统」", async () => {
    mount();
    await loaded();

    expect(themeSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("关掉「跟随系统」把当下这个模式钉住，再打开回到跟随", async () => {
    mount();
    await loaded();

    // jsdom 的 matchMedia 一律不匹配 dark，所以钉住的是浅色
    fireEvent.click(themeSwitch());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(themeSwitch()).toHaveAttribute("aria-checked", "false");

    fireEvent.click(themeSwitch());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(themeSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("别的标签页改了偏好，这边的开关跟着动", async () => {
    mount();
    await loaded();

    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    fireEvent(window, new StorageEvent("storage", { key: THEME_STORAGE_KEY }));

    expect(themeSwitch()).toHaveAttribute("aria-checked", "false");
  });
});

describe("登出", () => {
  it("点完当场就登出，不等 400ms", async () => {
    const { onLogout } = mount();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(toastMocks.show).toHaveBeenCalledWith("ok", "已登出");
  });
});
