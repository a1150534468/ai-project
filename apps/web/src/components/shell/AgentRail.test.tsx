// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";

/** 动画在这里只会带来时序噪声：AnimatePresence 直通，motion.div 摘掉动画描述项。 */
type FakeMotionProps = ComponentProps<"div"> & {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
  layoutId?: string;
};

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => false,
  motion: {
    div: ({ initial, animate, exit, transition, layoutId, ...dom }: FakeMotionProps) => <div {...dom} />,
  },
}));

// 只换掉 toast：Modal / RippleButton 还要用真的
vi.mock("../../motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../motion")>()),
  useToast: () => ({ show: () => {} }),
}));

import { AgentRail } from "./AgentRail";
import type { AgentOption, Session } from "../../api";

const SELECTED_KEY = "ai-assistant:agent:selected";

const preset: AgentOption = { id: "preset-1", name: "默认助手", description: "通用", icon: "mdi:assistant", type: "preset" };
const custom: AgentOption = {
  id: "c1",
  name: "我的法务",
  description: "合同",
  icon: "mdi:y",
  type: "custom",
  avatarSvg: null,
  avatarUrl: null,
};

/** s1 挂在自建 Agent 上，s2 没有 agentId —— 后者该归到默认助手名下 */
const sessions: Session[] = [
  { id: "s1", title: "合同审查", agentId: "c1", updatedAt: "2026-07-08T00:00:00Z" },
  { id: "s2", title: "闲聊", agentId: null, updatedAt: "2026-07-07T00:00:00Z" },
];
type RailProps = Parameters<typeof AgentRail>[0];

/** 挂一份带全套 spy 的 AgentRail，回调都能直接断言。 */
function mount(overrides: Partial<RailProps> = {}) {
  const spies = {
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onOpenAgentPicker: vi.fn(),
    onAgentsChanged: vi.fn(),
  };
  render(
    <AgentRail
      token="test-token"
      agents={{ presets: [preset], custom: [custom] }}
      sessions={sessions}
      runningSessionIds={new Set()}
      {...spies}
      {...overrides}
    />,
  );
  return spies;
}

/** 名字所在的那一行 Agent，用来看这行上挂了什么按钮 */
const agentRow = (name: string) => screen.getByText(name).closest("[data-agent-row]");
const openAgent = (name: string) => fireEvent.click(screen.getByText(name));
const inSessionPane = () => screen.queryByPlaceholderText("搜索对话") !== null;
describe("AgentRail 列表态", () => {
  beforeEach(() => localStorage.clear());

  it("自建 Agent 全列，预设只列真开过对话的那些", () => {
    mount();
    expect(screen.getByText("我的 Agent")).toBeInTheDocument();
    expect(screen.getByText("我的法务")).toBeInTheDocument();
    // preset-1 名下有 s2（agentId 为空的那条），所以它进了「用过的助手」
    expect(screen.getByText("用过的助手")).toBeInTheDocument();
    expect(screen.getByText("默认助手")).toBeInTheDocument();
  });

  it("搜索按名字过滤，两组一起收窄", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("搜索 Agent"), { target: { value: "法务" } });
    expect(screen.getByText("我的法务")).toBeInTheDocument();
    expect(screen.queryByText("默认助手")).not.toBeInTheDocument();
  });

  it("一个 Agent 都没有时给一句空态", () => {
    mount({ agents: { presets: [], custom: [] }, sessions: [] });
    expect(screen.getByText("还没有 Agent")).toBeInTheDocument();
  });

  it("新建 Agent 交给上层开选择器", () => {
    const { onOpenAgentPicker } = mount();
    fireEvent.click(screen.getByText("新建 Agent"));
    expect(onOpenAgentPicker).toHaveBeenCalled();
  });

  it("自建 Agent 那行有 ⋯", () => {
    mount();
    expect(agentRow("我的法务")?.querySelector('[aria-label="更多操作"]')).not.toBeNull();
  });

  it("预设助手那行没有 ⋯：头像和名字是全局资源", () => {
    mount();
    expect(agentRow("默认助手")?.querySelector('[aria-label="更多操作"]')).toBeNull();
  });
});
describe("AgentRail 两个面板互切", () => {
  beforeEach(() => localStorage.clear());

  it("点一个 Agent 就进它的对话面板，并顺手开一个新对话", () => {
    const { onNewSession } = mount();
    openAgent("我的法务");
    expect(inSessionPane()).toBe(true);
    expect(onNewSession).toHaveBeenCalledWith("c1");
  });

  it("对话面板只列这个 Agent 名下的对话", () => {
    mount();
    openAgent("我的法务");
    expect(screen.getByText("合同审查")).toBeInTheDocument();
    expect(screen.queryByText("闲聊")).not.toBeInTheDocument();
  });

  it("agentId 为空的老对话算默认助手的", () => {
    mount();
    openAgent("默认助手");
    expect(screen.getByText("闲聊")).toBeInTheDocument();
    expect(screen.queryByText("合同审查")).not.toBeInTheDocument();
  });

  it("名下没有对话时给一句空态", () => {
    mount({ sessions: [] });
    openAgent("我的法务");
    expect(screen.getByText("暂无对话")).toBeInTheDocument();
  });

  it("返回键退回 Agent 列表", () => {
    mount();
    openAgent("我的法务");
    fireEvent.click(screen.getByLabelText("返回 Agent 列表"));
    expect(inSessionPane()).toBe(false);
    expect(screen.getByText("我的 Agent")).toBeInTheDocument();
  });

  it("切面板清掉上一个面板的关键词", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("搜索 Agent"), { target: { value: "法务" } });
    openAgent("我的法务");
    expect(screen.getByPlaceholderText("搜索对话")).toHaveValue("");
  });
});
describe("AgentRail 记住选中的 Agent", () => {
  beforeEach(() => localStorage.clear());

  it("存过的 Agent 刷新回来还停在它的对话面板上", () => {
    localStorage.setItem(SELECTED_KEY, "c1");
    mount();
    expect(inSessionPane()).toBe(true);
    expect(screen.getByText("合同审查")).toBeInTheDocument();
  });

  it("存的 id 认不出（别的设备删了）就退回列表", () => {
    localStorage.setItem(SELECTED_KEY, "gone");
    mount();
    expect(inSessionPane()).toBe(false);
    expect(screen.getByText("我的 Agent")).toBeInTheDocument();
  });

  it("选中结果写进 localStorage", () => {
    mount();
    openAgent("我的法务");
    expect(localStorage.getItem(SELECTED_KEY)).toBe("c1");
  });
});

describe("AgentRail 对话行", () => {
  beforeEach(() => localStorage.clear());

  it("整行可点，点进这个对话", () => {
    const { onSelectSession } = mount();
    openAgent("我的法务");
    fireEvent.click(screen.getByText("合同审查"));
    expect(onSelectSession).toHaveBeenCalledWith("s1");
  });

  it("行内的删除不会顺手把对话打开", () => {
    const { onSelectSession, onDeleteSession } = mount();
    openAgent("我的法务");
    fireEvent.click(screen.getByText("删除"));
    expect(onDeleteSession).toHaveBeenCalledWith("s1");
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("正在跑的对话挂一个转圈标记", () => {
    mount({ runningSessionIds: new Set(["s1"]) });
    openAgent("我的法务");
    expect(screen.getByLabelText("运行中")).toBeInTheDocument();
  });
});
