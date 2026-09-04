// @vitest-environment jsdom

/**
 * `Chat.tsx`(1077 行)拆分前的行为护栏。P2.4 批次二 Step 1 要求的四类路径各有覆盖:
 * 渲染(空态 / 消息列表)、切换(模型 / 知识库 / 工具选择器)、提交(按钮 / Enter / 各种不该提交的情况)、
 * 错误态(error / attachmentError / 工具加载失败)。
 *
 * **这些断言是为了在拆子组件时钉住 props 契约**,不是为了覆盖率。所以断言尽量落在
 * "用户看得见的文案"与"`onSend` / `onModelChange` 收到的载荷"上,不碰内部 state 形状 ——
 * 抽子组件必然会重排 state 的归属,但这两端必须逐字不变。
 *
 * 与同目录 `Chat.test.tsx` 分工:那个文件只管消息面板的自动滚动,本文件不重复。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chatState";
import Chat from "./Chat";

const apiMocks = vi.hoisted(() => ({
  listInstalledTools: vi.fn(),
  listKb: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock("../api", () => ({
  listInstalledTools: apiMocks.listInstalledTools,
  listKb: apiMocks.listKb,
  listModels: apiMocks.listModels,
}));

vi.mock("../components/AssistantMessageActions", () => ({
  AssistantMessageActions: () => null,
}));

vi.mock("../components/MarkdownMessage", () => ({
  MarkdownMessage: ({ content }: { readonly content: string }) => <p>{content}</p>,
}));

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content, createdAt: "2026-08-29T00:00:00.000Z" };
}

function kb(id: string, name: string, ownerType = "USER") {
  return { id, name, ownerType, description: `${name} 描述` };
}

function tool(toolName: string, name: string, availableOnCurrentDevice = true) {
  return {
    id: `id-${toolName}`,
    name,
    toolName,
    description: `${name} 描述`,
    builtin: false,
    installed: true,
    availableOnCurrentDevice,
  };
}

type ChatOverrides = Partial<Parameters<typeof Chat>[0]>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onSend: ReturnType<typeof vi.fn>;
let onModelChange: ReturnType<typeof vi.fn>;

function element(overrides: ChatOverrides = {}) {
  return (
    <Chat
      token="token"
      messages={[]}
      isLoading={false}
      selectedModel="model-a"
      onModelChange={onModelChange}
      onSend={onSend}
      {...overrides}
    />
  );
}

/** 挂载并把两个 init 请求(listModels → listKb)的 microtask 抽干,否则首帧还没有模型列表。 */
async function mountChat(overrides: ChatOverrides = {}): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element(overrides));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (!container) throw new Error("container missing");
  return container;
}

async function rerender(overrides: ChatOverrides = {}): Promise<void> {
  await act(async () => {
    root?.render(element(overrides));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttons(scope: HTMLElement): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button"));
}

function buttonByLabel(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = buttons(scope).find((button) => button.getAttribute("aria-label") === label);
  if (!found) throw new Error(`button[aria-label="${label}"] missing`);
  return found;
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = buttons(scope).find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error(`button "${text}" missing`);
  return found;
}

/** 弹层里的行按钮文案由多个 span 拼出来，精确匹配太脆，只按可辨识片段找。 */
function rowButton(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = buttons(scope).find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`row button containing "${text}" missing`);
  return found;
}

function textarea(scope: HTMLElement): HTMLTextAreaElement {
  const found = scope.querySelector("textarea");
  if (!found) throw new Error("composer textarea missing");
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 走原生 input 事件，让 React 的受控 textarea 真的收到 onChange。 */
async function type(field: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pressEnter(field: HTMLTextAreaElement, shiftKey = false): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  onSend = vi.fn();
  onModelChange = vi.fn();
  apiMocks.listModels.mockResolvedValue([
    { model: "model-a", displayName: "模型甲" },
    { model: "model-b", displayName: "模型乙" },
  ]);
  apiMocks.listKb.mockResolvedValue([]);
  apiMocks.listInstalledTools.mockResolvedValue({ currentDeviceOnline: true, builtin: [], installed: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("Chat 渲染", () => {
  it("零消息时渲染空态标题与输入框，且不渲染底部输入区", async () => {
    const scope = await mountChat({ agentName: "小助手" });

    expect(scope.textContent).toContain("需要 小助手 为您做什么？");
    // 空态与底部输入区共用 composerCard，同一时刻只能存在一份
    expect(scope.querySelectorAll("textarea")).toHaveLength(1);
    expect(textarea(scope).placeholder).toBe("输入问题...");
    expect(scope.textContent).toContain("新对话");
  });

  it("有消息时渲染消息列表与底部输入区，标题取 sessionTitle", async () => {
    const scope = await mountChat({
      sessionId: "s-1",
      sessionTitle: "  周报草稿  ",
      messages: [makeMessage("user", "你好"), makeMessage("assistant", "你也好")],
    });

    expect(scope.textContent).toContain("周报草稿");
    expect(scope.textContent).toContain("你好");
    expect(scope.textContent).toContain("你也好");
    expect(scope.textContent).not.toContain("需要 默认助手 为您做什么？");
    expect(scope.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("sessionId 存在但标题空白时回落到「对话」", async () => {
    const scope = await mountChat({ sessionId: "s-1", sessionTitle: "   ", messages: [makeMessage("user", "嗨")] });
    expect(scope.querySelector("h3")?.textContent).toBe("对话");
  });

  it("头部模型标签显示 displayName 而不是模型 id", async () => {
    const scope = await mountChat();
    expect(scope.textContent).toContain("模型甲");
    expect(scope.textContent).not.toContain("model-a");
  });
});

describe("Chat 模型切换", () => {
  it("打开模型选择器后点另一个模型，回调收到模型 id 且弹层关闭", async () => {
    const scope = await mountChat();

    await click(buttonByLabel(scope, "选择模型"));
    expect(scope.textContent).toContain("切换后下一条消息生效");
    expect(scope.textContent).toContain("模型乙");

    await click(buttonByText(scope, "模型乙"));
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith("model-b");
    expect(scope.textContent).not.toContain("切换后下一条消息生效");
  });

  it("模型列表为空时弹层给出空态而不是空白", async () => {
    apiMocks.listModels.mockResolvedValue([]);
    const scope = await mountChat({ selectedModel: "model-a" });

    await click(buttonByLabel(scope, "选择模型"));
    expect(scope.textContent).toContain("暂无可用模型");
  });

  it("当前模型不在可用列表里时自动改选：无 preferredModel 落到首个", async () => {
    await mountChat({ selectedModel: "已下线模型" });
    expect(onModelChange).toHaveBeenCalledWith("model-a");
  });

  it("当前模型不在可用列表里且 preferredModel 可用时优先用 preferredModel", async () => {
    await mountChat({ selectedModel: "", preferredModel: "model-b" });
    expect(onModelChange).toHaveBeenCalledWith("model-b");
  });

  it("当前模型有效时不会自动改选", async () => {
    await mountChat({ selectedModel: "model-b" });
    expect(onModelChange).not.toHaveBeenCalled();
  });
});

describe("Chat 提交", () => {
  it("点发送按钮提交完整载荷并清空输入框", async () => {
    const scope = await mountChat();
    const field = textarea(scope);

    expect(buttonByLabel(scope, "发送").disabled).toBe(true);
    await type(field, "帮我写周报");
    expect(buttonByLabel(scope, "发送").disabled).toBe(false);

    await click(buttonByLabel(scope, "发送"));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({
      message: "帮我写周报",
      model: "model-a",
      kbIds: [],
      attachAllOwn: undefined,
      toolIds: [],
      attachments: [],
    });
    expect(textarea(scope).value).toBe("");
  });

  it("Enter 提交，Shift+Enter 不提交", async () => {
    const scope = await mountChat();
    const field = textarea(scope);

    await type(field, "第一行");
    await pressEnter(field, true);
    expect(onSend).not.toHaveBeenCalled();

    await pressEnter(field);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].message).toBe("第一行");
  });

  it("提交前 trim：只有空白时既不启用按钮也不响应 Enter", async () => {
    const scope = await mountChat();
    const field = textarea(scope);

    await type(field, "   \n  ");
    expect(buttonByLabel(scope, "发送").disabled).toBe(true);
    await pressEnter(field);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("isLoading 期间按钮禁用且 Enter 也不提交", async () => {
    const scope = await mountChat({ isLoading: true });
    const field = textarea(scope);

    await type(field, "别重复发");
    expect(buttonByLabel(scope, "发送").disabled).toBe(true);
    await pressEnter(field);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("Chat 错误态", () => {
  it("空态下把 error 渲染成横幅", async () => {
    const scope = await mountChat({ error: "上游模型不可用" });
    expect(scope.textContent).toContain("上游模型不可用");
  });

  it("有消息时错误横幅出现在底部输入区上方", async () => {
    const scope = await mountChat({ messages: [makeMessage("user", "在吗")], error: "上游超时" });
    const banner = scope.querySelector(".bg-danger\\/10");
    expect(banner?.textContent).toBe("上游超时");
  });

  it("error 为空时不渲染横幅", async () => {
    const scope = await mountChat({ error: "" });
    expect(scope.querySelector(".bg-danger\\/10")).toBeNull();
  });

  it("init 请求失败只 warn，不影响输入框渲染", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiMocks.listModels.mockRejectedValue(new Error("模型服务不可用"));

    const scope = await mountChat();

    expect(warn).toHaveBeenCalledWith("chat init failed", expect.any(Error));
    expect(textarea(scope).placeholder).toBe("输入问题...");
    warn.mockRestore();
  });

  it("工具列表加载失败时弹层展示错误而不是一直转圈", async () => {
    apiMocks.listInstalledTools.mockRejectedValue(new Error("设备离线"));
    const scope = await mountChat();

    await click(buttonByText(scope, "工具"));
    expect(scope.textContent).toContain("设备离线");
    expect(scope.textContent).not.toContain("正在加载已安装工具");
  });
});

describe("Chat 知识库挂载", () => {
  beforeEach(() => {
    apiMocks.listKb.mockResolvedValue([kb("kb-1", "产品手册"), kb("kb-2", "行业报告", "OFFICIAL")]);
  });

  it("勾选后点确定：按钮文案变库名、头部出现挂载数、提交带上 kbIds", async () => {
    const scope = await mountChat();

    await click(buttonByText(scope, "知识库"));
    await click(rowButton(scope, "产品手册"));
    await click(buttonByText(scope, "确定"));

    expect(buttonByText(scope, "产品手册")).toBeTruthy();
    expect(scope.textContent).toContain("已挂载 1 库");

    await type(textarea(scope), "查一下");
    await click(buttonByLabel(scope, "发送"));
    expect(onSend.mock.calls[0][0]).toMatchObject({ kbIds: ["kb-1"], attachAllOwn: undefined });
  });

  it("全库智能搜索与指定库互斥：选全库后 kbIds 让位给 attachAllOwn", async () => {
    const scope = await mountChat();

    await click(buttonByText(scope, "知识库"));
    await click(rowButton(scope, "产品手册"));
    await click(rowButton(scope, "全库智能搜索"));
    await click(buttonByText(scope, "确定"));

    expect(scope.textContent).toContain("我的全库搜索");
    expect(scope.textContent).toContain("已挂载 全部库");

    await type(textarea(scope), "查一下");
    await click(buttonByLabel(scope, "发送"));
    expect(onSend.mock.calls[0][0]).toMatchObject({ kbIds: undefined, attachAllOwn: true });
  });

  it("取消不落库：草稿丢弃，按钮回到「知识库」", async () => {
    const scope = await mountChat();

    await click(buttonByText(scope, "知识库"));
    await click(rowButton(scope, "产品手册"));
    await click(buttonByText(scope, "取消"));

    expect(buttonByText(scope, "知识库")).toBeTruthy();
    expect(scope.textContent).not.toContain("已挂载");
  });

  it("关闭知识库把已生效的选择一起清掉", async () => {
    const scope = await mountChat();

    await click(buttonByText(scope, "知识库"));
    await click(rowButton(scope, "产品手册"));
    await click(buttonByText(scope, "确定"));
    expect(scope.textContent).toContain("已挂载 1 库");

    await click(buttonByText(scope, "产品手册"));
    await click(buttonByText(scope, "关闭知识库"));
    expect(buttonByText(scope, "知识库")).toBeTruthy();
    expect(scope.textContent).not.toContain("已挂载");
  });

  it("选两个库时按钮显示计数而不是拼接库名", async () => {
    const scope = await mountChat();

    await click(buttonByText(scope, "知识库"));
    await click(rowButton(scope, "产品手册"));
    await click(rowButton(scope, "行业报告"));
    await click(buttonByText(scope, "确定"));

    expect(buttonByText(scope, "2 个知识库")).toBeTruthy();
    expect(scope.textContent).toContain("已挂载 2 库");
  });

  /**
   * P4.2 的护栏：「你自己创建的 N 个知识库」里的 N 是**自己的库数**，不是列表长度。
   *
   * 这个数字必须和服务端「全库搜索」的取值范围同口径：`resolveEffectiveKbIds` 的 own 集是
   * `ownerType='USER' AND userId=本人`（`kb/retrieve.ts`）。所以官方库要列得出来、能单独勾，
   * 但绝不能计进 N —— 否则文案承诺的库数里混着全库搜索根本不碰的官方库。
   *
   * 也顺手钉住 P2 的成果：产物系统库（`systemKey='AI_ARTIFACTS'`、`ownerType='USER'`、
   * userId 是本人）当年就躺在这份列表里，带着「我的」角标可勾选、计进 N、还真被全库搜索检索到。
   * 两个选择器从来没有过 `systemKey` 过滤，也不需要加 —— 那些行已经删掉了，
   * 列表里出现的「我的」库就该真是用户自己建的。
   */
  it("「你自己创建的 N 个」只数自己的库：官方库列得出来但不计数", async () => {
    apiMocks.listKb.mockResolvedValue([
      kb("kb-1", "产品手册"),
      kb("kb-2", "行业报告", "OFFICIAL"),
      kb("kb-3", "会议记录"),
    ]);
    const scope = await mountChat();

    await click(buttonByText(scope, "知识库"));

    expect(scope.textContent).toContain("你自己创建的 2 个知识库");
    expect(rowButton(scope, "产品手册").textContent).toContain("我的");
    expect(rowButton(scope, "会议记录").textContent).toContain("我的");
    expect(rowButton(scope, "行业报告").textContent).toContain("官方");
  });
});

describe("Chat 工具挂载", () => {
  beforeEach(() => {
    apiMocks.listInstalledTools.mockResolvedValue({
      currentDeviceOnline: true,
      builtin: [],
      installed: [tool("terminal_exec", "执行命令"), tool("远端工具", "远端工具", false)],
    });
  });

  it("只列出当前设备可用的工具，勾选后提交带上 toolIds", async () => {
    const scope = await mountChat();

    await click(buttonByText(scope, "工具"));
    expect(scope.textContent).toContain("执行命令");
    expect(scope.textContent).not.toContain("远端工具");
    expect(scope.textContent).toContain("0 个已选择，1 个可挂载");

    await click(rowButton(scope, "执行命令 描述"));
    await click(buttonByText(scope, "确定"));

    expect(buttonByText(scope, "执行命令")).toBeTruthy();
    expect(scope.textContent).toContain("已挂载 1 工具");

    await type(textarea(scope), "跑一下");
    await click(buttonByLabel(scope, "发送"));
    expect(onSend.mock.calls[0][0]).toMatchObject({ toolIds: ["terminal_exec"] });
  });

  it("一个都没装时给出引导而不是空列表", async () => {
    apiMocks.listInstalledTools.mockResolvedValue({ currentDeviceOnline: true, builtin: [], installed: [] });
    const scope = await mountChat();

    await click(buttonByText(scope, "工具"));
    expect(scope.textContent).toContain("暂无已安装工具");
  });

  it("关闭工具把已生效的选择一起清掉", async () => {
    const scope = await mountChat();

    await click(buttonByText(scope, "工具"));
    await click(rowButton(scope, "执行命令 描述"));
    await click(buttonByText(scope, "确定"));
    expect(scope.textContent).toContain("已挂载 1 工具");

    await click(buttonByText(scope, "执行命令"));
    await click(buttonByText(scope, "关闭工具"));
    expect(buttonByText(scope, "工具")).toBeTruthy();
    expect(scope.textContent).not.toContain("已挂载");
  });
});

describe("Chat 侧栏折叠回调", () => {
  it("不给 onToggleAgentPanel 时不渲染折叠按钮", async () => {
    const scope = await mountChat();
    expect(buttons(scope).some((button) => button.getAttribute("aria-label")?.includes("对话列表"))).toBe(false);
  });

  it("给了回调则按折叠状态切换 aria-label 并透传点击", async () => {
    const onToggleAgentPanel = vi.fn();
    const scope = await mountChat({ onToggleAgentPanel });

    await click(buttonByLabel(scope, "收起对话列表"));
    expect(onToggleAgentPanel).toHaveBeenCalledTimes(1);

    await rerender({ onToggleAgentPanel, agentPanelCollapsed: true });
    expect(buttonByLabel(scope, "展开对话列表")).toBeTruthy();
  });
});
