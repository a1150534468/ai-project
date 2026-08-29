// @vitest-environment jsdom

/**
 * `App.tsx`(752 行)拆分前的行为护栏。P2.4 批次二 Step 4 只允许「把 25 个 useState 按关注点
 * 分组进自定义 hook」、不许改路由机制,所以这里断言的全是**编排契约**:
 *  - 登录态:token 进 localStorage、getMe 401 清登录态、登出回登录页
 *  - 视图分派:13 个 view 分支各渲染谁、工作流二级菜单怎么落到 workflow / report
 *  - 深链一次性:知识库 ↔ 桌宠的跳转意图,离开目标页就必须清掉
 *  - 会话流:发送 → session 事件把草稿键迁到真实 id → text / tool / reset / citation / error
 *  - 后台开关顶掉当前页时跳第一个可见页
 *
 * 13 个页面组件全部换成探针,断言的是 **App.tsx 自己算出来、往下传的那份 props**,不进页面
 * 内部找 DOM —— 拆分会把这段编排搬进 hook,探针看到的 props 才是必须逐字不变的契约。
 *
 * `probes.shell` / `probes.chat` 抓的是最后一次渲染的 props,回调直接从这里调用。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError } from "./apiError";
import { DEFAULT_CLIENT_MENU_VISIBILITY } from "./clientMenu";
import { AUTH_TOKEN_STORAGE_KEY } from "./http";

const apiMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  getBalance: vi.fn(),
  getMe: vi.fn(),
  getSessionMessages: vi.fn(),
  listAgents: vi.fn(),
  listSessions: vi.fn(),
  streamChat: vi.fn(),
}));

/** 只替换 App.tsx 真正调用的 7 个接口,其余(类型、工具函数)保持真实实现。 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  ...apiMocks,
}));

const menuMocks = vi.hoisted(() => ({ getClientMenuVisibility: vi.fn() }));

vi.mock("./clientMenu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clientMenu")>()),
  ...menuMocks,
}));

const probes = vi.hoisted(() => ({
  shell: null as Record<string, any> | null,
  chat: null as Record<string, any> | null,
  knowledge: null as Record<string, any> | null,
  workflow: null as Record<string, any> | null,
  settings: null as Record<string, any> | null,
  agentPicker: null as Record<string, any> | null,
  login: null as Record<string, any> | null,
  register: null as Record<string, any> | null,
  confirmOptions: null as Record<string, any> | null,
  confirmAnswer: true,
  streamArgs: [] as any[],
  emit: null as ((event: string, data: unknown) => void) | null,
}));

vi.mock("./components/shell/Shell", () => ({
  default: (props: Record<string, any>) => {
    probes.shell = props;
    return <div data-testid="shell">{props.children}</div>;
  },
}));

/** 真 useConfirm 要等用户点按钮才 resolve;这里由 `confirmAnswer` 直接决定答案。 */
vi.mock("./components/ConfirmDialog", () => ({
  useConfirm: () => ({
    confirm: async (options: Record<string, any>) => {
      probes.confirmOptions = options;
      if (!probes.confirmAnswer) return false;
      await options.onConfirm();
      return true;
    },
    Dialog: () => null,
  }),
}));

vi.mock("./components/AgentPicker", () => ({
  AgentPicker: (props: Record<string, any>) => {
    probes.agentPicker = props;
    return <div data-testid="agent-picker" data-open={String(props.open)} />;
  },
}));

function pageProbe(key: "chat" | "knowledge" | "workflow" | "settings", testId: string) {
  return {
    default: (props: Record<string, any>) => {
      probes[key] = props;
      return <section data-testid={testId} />;
    },
  };
}

function stub(testId: string) {
  return {
    default: (props: Record<string, any>) => <section data-testid={testId} data-token={String(props.token)} />,
  };
}

vi.mock("./components/Login", () => ({
  default: (props: Record<string, any>) => {
    probes.login = props;
    return <div data-testid="login-page" />;
  },
}));

vi.mock("./components/Register", () => ({
  default: (props: Record<string, any>) => {
    probes.register = props;
    return <div data-testid="register-page" />;
  },
}));

vi.mock("./pages/Chat", () => pageProbe("chat", "chat-page"));
vi.mock("./pages/Knowledge", () => pageProbe("knowledge", "kb-page"));
vi.mock("./pages/Workflow", () => pageProbe("workflow", "workflow-page"));
vi.mock("./pages/Settings", () => pageProbe("settings", "settings-page"));
vi.mock("./pages/ToolMarket", () => stub("tool-market-page"));
vi.mock("./pages/Video", () => stub("video-page"));
vi.mock("./pages/DigitalHuman", () => stub("digital-human-page"));
vi.mock("./pages/Report", () => stub("report-page"));
vi.mock("./pages/AgentTeams", () => stub("agent-teams-page"));
vi.mock("./pages/Billing", () => stub("billing-page"));
vi.mock("./pages/Memory", () => stub("memory-page"));
vi.mock("./pages/ModelMarketplace", () => stub("models-page"));
vi.mock("./pages/WechatBind", () => stub("wechat-page"));

let container: HTMLDivElement;
let root: Root;
let resolveStream: (() => void) | null = null;

/** 默认放开三个灰度入口,否则可见性 effect 会立刻把 report / 桌宠页顶掉。 */
function visibility(overrides: Record<string, boolean> = {}) {
  return {
    ...DEFAULT_CLIENT_MENU_VISIBILITY,
    "workflow.report": true,
    "workflow.codex-pet": true,
    "workflow.article-workflow": true,
    ...overrides,
  };
}

function sessionRow(id: string) {
  return {
    id,
    title: `会话 ${id}`,
    agentId: null,
    agentName: null,
    agentIcon: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function toolEvent(id: string, status: "started" | "completed" | "failed") {
  return { id, name: "search", label: "搜索", status, detail: "" };
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
}

function find(testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function emit(event: string, data: unknown = {}) {
  await act(async () => {
    probes.emit?.(event, data);
  });
}

async function send(message = "你好") {
  await act(async () => {
    probes.chat?.onSend({ message });
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, "t-1");
  vi.clearAllMocks();
  probes.shell = null;
  probes.chat = null;
  probes.knowledge = null;
  probes.workflow = null;
  probes.settings = null;
  probes.agentPicker = null;
  probes.login = null;
  probes.register = null;
  probes.confirmOptions = null;
  probes.confirmAnswer = true;
  probes.streamArgs = [];
  probes.emit = null;
  resolveStream = null;
  apiMocks.getBalance.mockResolvedValue({ balance: 120 });
  apiMocks.getMe.mockResolvedValue({ uid: "u-1", username: "alice" });
  apiMocks.listAgents.mockResolvedValue({
    presets: [{ id: "preset-1", name: "写作助手", description: "", icon: "mdi:pen", type: "preset" }],
    custom: [],
  });
  apiMocks.listSessions.mockResolvedValue([]);
  apiMocks.getSessionMessages.mockResolvedValue([]);
  apiMocks.deleteSession.mockResolvedValue(undefined);
  menuMocks.getClientMenuVisibility.mockResolvedValue(visibility());
  apiMocks.streamChat.mockImplementation((...args: any[]) => {
    probes.streamArgs = args;
    probes.emit = args[3] as (event: string, data: unknown) => void;
    return new Promise<void>((resolve) => {
      resolveStream = () => resolve();
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("App 登录态", () => {
  it("没有 token 时渲染登录页,可切到注册页", async () => {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    await mount();
    expect(find("login-page")).not.toBeNull();
    expect(find("shell")).toBeNull();
    await act(async () => {
      probes.login?.onSwitchToRegister();
    });
    expect(find("register-page")).not.toBeNull();
  });

  it("登录成功后 token 落 localStorage 并进入 Shell", async () => {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    await mount();
    await act(async () => {
      probes.login?.onLogin("t-new");
    });
    await flush();
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe("t-new");
    expect(find("shell")).not.toBeNull();
    expect(apiMocks.getBalance).toHaveBeenCalledWith("t-new");
    expect(probes.shell?.balance).toBe(120);
  });

  it("登出清掉 token 与 localStorage", async () => {
    await mount();
    await act(async () => {
      probes.shell?.onLogout();
    });
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(find("login-page")).not.toBeNull();
  });

  it("getMe 返回 401 时清掉登录态", async () => {
    apiMocks.getMe.mockRejectedValue(new ApiError("token 失效", 401));
    await mount();
    await flush();
    expect(find("login-page")).not.toBeNull();
  });

  it("设置页拿到当前账号信息", async () => {
    await mount();
    await act(async () => {
      probes.shell?.onViewChange("settings");
    });
    expect(probes.settings?.uid).toBe("u-1");
    expect(probes.settings?.userName).toBe("alice");
  });
});

describe("App 视图分派", () => {
  it("默认渲染对话页,助手名与消息列表都是空态", async () => {
    await mount();
    expect(find("chat-page")).not.toBeNull();
    expect(probes.chat?.agentName).toBe("默认助手");
    expect(probes.chat?.messages).toEqual([]);
    expect(probes.chat?.sessionId).toBeUndefined();
    expect(probes.chat?.isLoading).toBe(false);
    expect(probes.chat?.error).toBe("");
  });

  it("工作流二级菜单:报告走 report 页,模块走 workflow 页", async () => {
    await mount();
    await act(async () => {
      probes.shell?.onSelectWorkflowSub("report");
    });
    expect(find("report-page")).not.toBeNull();
    await act(async () => {
      probes.shell?.onSelectWorkflowSub("article-workflow");
    });
    expect(find("workflow-page")).not.toBeNull();
    expect(probes.workflow?.activeModuleId).toBe("article-workflow");
    expect(probes.shell?.workflowModule).toBe("article-workflow");
  });

  it("对话页可以跳到工具市场", async () => {
    await mount();
    await act(async () => {
      probes.chat?.onOpenToolMarket();
    });
    expect(find("tool-market-page")).not.toBeNull();
  });

  it("当前页被后台隐藏时跳到第一个可见的主菜单", async () => {
    menuMocks.getClientMenuVisibility.mockResolvedValue(visibility({ "nav.chat": false }));
    await mount();
    await flush();
    expect(find("chat-page")).toBeNull();
    expect(find("models-page")).not.toBeNull();
  });

  it("偏好模型变更同时写入 localStorage 与当前选中模型", async () => {
    await mount();
    await act(async () => {
      probes.chat?.onModelChange("gpt-x");
    });
    expect(localStorage.getItem("preferredModel")).toBe("gpt-x");
    expect(probes.chat?.selectedModel).toBe("gpt-x");
    expect(probes.chat?.preferredModel).toBe("gpt-x");
  });
});

describe("App 跨页深链", () => {
  it("知识库跳桌宠项目是一次性意图,离开工作流页后清掉", async () => {
    await mount();
    await act(async () => {
      probes.shell?.onViewChange("kb");
    });
    await act(async () => {
      probes.knowledge?.onOpenCodexPetProject("p-1");
    });
    expect(find("workflow-page")).not.toBeNull();
    expect(probes.workflow?.activeModuleId).toBe("codex-pet");
    expect(probes.workflow?.initialCodexPetProjectId).toBe("p-1");
    await act(async () => {
      probes.shell?.onViewChange("kb");
    });
    await act(async () => {
      probes.shell?.onViewChange("workflow");
    });
    expect(probes.workflow?.initialCodexPetProjectId).toBeNull();
  });

  it("工作流跳知识库文档也是一次性意图", async () => {
    await mount();
    await act(async () => {
      probes.shell?.onSelectWorkflowSub("codex-pet");
    });
    await act(async () => {
      probes.workflow?.onOpenKnowledgeDocument("doc-1");
    });
    expect(find("kb-page")).not.toBeNull();
    expect(probes.knowledge?.initialDocumentId).toBe("doc-1");
    await act(async () => {
      probes.shell?.onViewChange("chat");
    });
    await act(async () => {
      probes.shell?.onViewChange("kb");
    });
    expect(probes.knowledge?.initialDocumentId).toBeNull();
  });

  it("从菜单选工作流模块会丢掉上一次的桌宠深链意图", async () => {
    await mount();
    await act(async () => {
      probes.shell?.onViewChange("kb");
    });
    await act(async () => {
      probes.knowledge?.onOpenCodexPetProject("p-1");
    });
    await act(async () => {
      probes.shell?.onSelectWorkflowSub("codex-pet");
    });
    expect(probes.workflow?.initialCodexPetProjectId).toBeNull();
  });
});

describe("App 会话流", () => {
  it("发送后用户消息立即入列并进入加载态", async () => {
    await mount();
    await send("写一首诗");
    expect(probes.chat?.messages.map((item: any) => [item.role, item.content])).toEqual([["user", "写一首诗"]]);
    expect(probes.chat?.isLoading).toBe(true);
    expect(probes.shell?.runningSessionIds.size).toBe(1);
  });

  it("同一会话正在生成时再次发送被忽略", async () => {
    await mount();
    await send("第一条");
    await send("第二条");
    expect(apiMocks.streamChat).toHaveBeenCalledTimes(1);
    expect(probes.chat?.messages).toHaveLength(1);
  });

  it("session 事件把草稿键迁到真实会话 id,并在列表插入新会话", async () => {
    await mount();
    await send("写一首诗");
    await emit("session", {
      sessionId: "s-9",
      agentId: "preset-1",
      agentName: "写作助手",
      agentIcon: "mdi:pen",
      model: "gpt-x",
    });
    expect(probes.chat?.sessionId).toBe("s-9");
    // 草稿键上的用户消息与运行标记都要跟着搬过来
    expect(probes.chat?.messages).toHaveLength(1);
    expect(probes.chat?.isLoading).toBe(true);
    expect(probes.shell?.currentSessionId).toBe("s-9");
    expect(probes.shell?.sessions[0]).toMatchObject({
      id: "s-9",
      title: "写一首诗",
      agentId: "preset-1",
      agentName: "写作助手",
    });
  });

  it("text 事件累加到同一条助手消息", async () => {
    await mount();
    await send();
    await emit("session", { sessionId: "s-9", model: "gpt-x" });
    await emit("text", { text: "你" });
    await emit("text", { text: "好" });
    await emit("text", { text: "" });
    const messages = probes.chat?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "你好", model: "gpt-x" });
  });
});

describe("App 会话流事件", () => {
  it("reset 事件作废当前这轮已流式的助手文本", async () => {
    await mount();
    await send();
    await emit("text", { text: "半截" });
    await emit("reset", {});
    expect(probes.chat?.messages).toHaveLength(1);
    // 尾部已经是用户消息,再来一次不该继续往前砍
    await emit("reset", {});
    expect(probes.chat?.messages).toHaveLength(1);
  });

  it("tool 事件按 id 覆盖,且只保留最近 12 条", async () => {
    await mount();
    await send();
    await emit("tool", toolEvent("t-1", "started"));
    await emit("tool", toolEvent("t-1", "completed"));
    expect(probes.chat?.toolActivities).toHaveLength(1);
    expect(probes.chat?.toolActivities[0].status).toBe("completed");
    for (let index = 2; index <= 14; index += 1) {
      await emit("tool", toolEvent(`t-${index}`, "started"));
    }
    expect(probes.chat?.toolActivities).toHaveLength(12);
    expect(probes.chat?.toolActivities[0].id).toBe("t-3");
  });

  it("citation 事件累积引用,空引用不入列", async () => {
    await mount();
    await send();
    await emit("citation", { kb: [{ docName: "手册", ordinal: 1 }] });
    await emit("citation", { kb: [] });
    expect(probes.chat?.citations).toEqual([{ docs: [{ docName: "手册", ordinal: 1 }] }]);
  });

  it("ping 事件不产生任何消息", async () => {
    await mount();
    await send();
    await emit("ping", {});
    expect(probes.chat?.messages).toHaveLength(1);
    expect(probes.chat?.error).toBe("");
  });

  it("流结束后清掉运行标记并刷新余额", async () => {
    await mount();
    await send();
    apiMocks.getBalance.mockResolvedValue({ balance: 80 });
    await act(async () => {
      resolveStream?.();
    });
    await flush();
    expect(probes.chat?.isLoading).toBe(false);
    expect(probes.shell?.balance).toBe(80);
  });
});

describe("App 会话流错误", () => {
  it("余额不足的错误弹充值提示,去充值跳计费页", async () => {
    await mount();
    await send();
    await emit("error", { message: "余额不足", code: "INSUFFICIENT_BALANCE" });
    expect(probes.chat?.error).toBe("余额不足");
    expect(container.textContent).toContain("当前算力点余额不足");
    const recharge = [...container.querySelectorAll("button")].find((item) => item.textContent === "去充值");
    await act(async () => {
      recharge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(find("billing-page")).not.toBeNull();
  });

  it("普通错误只写进当前会话,不弹充值提示", async () => {
    await mount();
    await send();
    await emit("error", { message: "模型超时" });
    expect(probes.chat?.error).toBe("模型超时");
    expect(container.textContent).not.toContain("当前算力点余额不足");
  });

  it("streamChat 抛错时给出发送失败提示", async () => {
    apiMocks.streamChat.mockRejectedValue(new Error("网络断了"));
    await mount();
    await send();
    await flush();
    expect(probes.chat?.error).toBe("发送失败: 网络断了");
    expect(probes.chat?.isLoading).toBe(false);
  });
});

describe("App 会话切换与删除", () => {
  it("选 Agent 后开新对话:收起 Agent 栏,新会话才把 agentId 传给后端", async () => {
    await mount();
    await act(async () => {
      probes.agentPicker?.onSelect({
        id: "preset-1",
        name: "写作助手",
        description: "",
        icon: "mdi:pen",
        type: "preset",
      });
    });
    expect(probes.shell?.agentPanelCollapsed).toBe(true);
    expect(probes.agentPicker?.open).toBe(false);
    expect(probes.chat?.agentName).toBe("写作助手");
    await send("你好");
    expect(probes.streamArgs[2]).toBeUndefined();
    expect(probes.streamArgs[5]).toBe("preset-1");
    await emit("session", { sessionId: "s-9" });
    await act(async () => {
      resolveStream?.();
    });
    await flush();
    // 续聊:sessionId 已经有了,不再重复带 agentId
    await send("再来一句");
    expect(probes.streamArgs[2]).toBe("s-9");
    expect(probes.streamArgs[5]).toBeUndefined();
  });

  it("切换会话拉历史消息,落后的旧请求不写回", async () => {
    apiMocks.listSessions.mockResolvedValue([sessionRow("s-1"), sessionRow("s-2")]);
    await mount();
    let resolveStale: ((value: unknown) => void) | null = null;
    apiMocks.getSessionMessages.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveStale = resolve;
      }),
    );
    await act(async () => {
      void probes.shell?.onSelectSession("s-1");
    });
    await act(async () => {
      void probes.shell?.onSelectSession("s-2");
    });
    await flush();
    expect(probes.chat?.sessionId).toBe("s-2");
    await act(async () => {
      resolveStale?.([{ role: "user", content: "旧的", createdAt: "2026-01-01T00:00:00.000Z" }]);
    });
    apiMocks.getSessionMessages.mockResolvedValue([
      { role: "assistant", content: "新的", createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    await act(async () => {
      void probes.shell?.onSelectSession("s-1");
    });
    await flush();
    expect(probes.chat?.messages.map((item: any) => item.content)).toEqual(["新的"]);
  });

  it("拉历史消息失败时把错误写进这一条会话", async () => {
    apiMocks.listSessions.mockResolvedValue([sessionRow("s-1")]);
    apiMocks.getSessionMessages.mockRejectedValue(new Error("服务器 500"));
    await mount();
    await act(async () => {
      await probes.shell?.onSelectSession("s-1");
    });
    expect(probes.chat?.error).toBe("加载会话失败: 服务器 500");
  });

  it("删除当前会话后从列表移除并弹出 Agent 选择", async () => {
    apiMocks.listSessions.mockResolvedValue([sessionRow("s-1"), sessionRow("s-2")]);
    await mount();
    await act(async () => {
      await probes.shell?.onSelectSession("s-1");
    });
    await act(async () => {
      await probes.shell?.onDeleteSession("s-1");
    });
    expect(apiMocks.deleteSession).toHaveBeenCalledWith("t-1", "s-1");
    expect(probes.shell?.sessions.map((item: any) => item.id)).toEqual(["s-2"]);
    expect(probes.agentPicker?.open).toBe(true);
    expect(find("chat-page")).not.toBeNull();
  });

  it("取消删除时会话与接口都保持不动", async () => {
    apiMocks.listSessions.mockResolvedValue([sessionRow("s-1"), sessionRow("s-2")]);
    probes.confirmAnswer = false;
    await mount();
    await act(async () => {
      await probes.shell?.onDeleteSession("s-1");
    });
    expect(apiMocks.deleteSession).not.toHaveBeenCalled();
    expect(probes.shell?.sessions.map((item: any) => item.id)).toEqual(["s-1", "s-2"]);
    expect(probes.agentPicker?.open).toBe(false);
  });

  it("Shell 侧新建会话按 agentId 找到 Agent 再开新对话", async () => {
    await mount();
    await flush();
    await act(async () => {
      probes.shell?.onNewSession("preset-1");
    });
    expect(probes.chat?.agentName).toBe("写作助手");
    expect(probes.shell?.agentPanelCollapsed).toBe(true);
  });

  it("Agent 列表变更后同时刷新 Agent 与会话列表", async () => {
    await mount();
    await flush();
    apiMocks.listSessions.mockResolvedValue([sessionRow("s-7")]);
    await act(async () => {
      await probes.shell?.onAgentsChanged();
    });
    expect(apiMocks.listAgents).toHaveBeenCalledTimes(2);
    expect(probes.shell?.sessions.map((item: any) => item.id)).toEqual(["s-7"]);
  });
});
