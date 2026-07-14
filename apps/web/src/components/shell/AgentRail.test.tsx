// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReactNode } from "react";

// Mock motion/react to eliminate animation timing issues
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: (props: any) => {
      const { children, onMouseEnter, onMouseLeave, className } = props;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { initial, animate, exit, transition, style, ...restProps } = props;
      return (
        <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} className={className} {...restProps}>
          {children}
        </div>
      );
    },
  },
  useReducedMotion: () => false,
}));

vi.mock("../../motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../motion")>()),
  useToast: () => ({ show: () => {} }),
}));

import { AgentRail } from "./AgentRail";
import type { AgentOption, Session } from "../../api";

const agents: { presets: AgentOption[]; custom: AgentOption[] } = {
  presets: [{ id: "preset-1", name: "默认助手", description: "通用", icon: "mdi:assistant", type: "preset" as const }],
  custom: [
    {
      id: "c1",
      name: "我的法务",
      description: "合同",
      icon: "mdi:y",
      type: "custom" as const,
      avatarSvg: null,
      avatarUrl: null,
    },
  ],
};

const sessions: Session[] = [
  { id: "s1", title: "合同审查", agentId: "c1", updatedAt: "2026-07-08T00:00:00Z" },
  { id: "s2", title: "闲聊", agentId: null, updatedAt: "2026-07-07T00:00:00Z" },
];

const props = {
  token: "t",
  agents,
  sessions,
  currentSessionId: undefined,
  runningSessionIds: new Set<string>(),
  onSelectSession: vi.fn(),
  onNewSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onOpenAgentPicker: vi.fn(),
  onAgentsChanged: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("AgentRail", () => {
  it("默认是 Agent 列表态，显示自建与用过的预设", () => {
    render(<AgentRail {...props} />);
    expect(screen.getByText("我的法务")).toBeTruthy();
    expect(screen.getByText("默认助手")).toBeTruthy();
    expect(screen.getByPlaceholderText("搜索 Agent")).toBeTruthy();
  });

  it("点 Agent → 切到对话列表态，只显示该 Agent 的对话", () => {
    render(<AgentRail {...props} />);
    fireEvent.click(screen.getByText("我的法务"));
    expect(screen.getByText("合同审查")).toBeTruthy();
    expect(screen.queryByText("闲聊")).toBeNull();
    expect(screen.getByPlaceholderText("搜索对话")).toBeTruthy();
  });

  it("点返回 → 回到 Agent 列表态", () => {
    render(<AgentRail {...props} />);
    fireEvent.click(screen.getByText("我的法务"));
    fireEvent.click(screen.getByLabelText("返回 Agent 列表"));
    expect(screen.getByPlaceholderText("搜索 Agent")).toBeTruthy();
  });

  it("切换态时清空搜索", () => {
    render(<AgentRail {...props} />);
    fireEvent.change(screen.getByPlaceholderText("搜索 Agent"), { target: { value: "法务" } });
    fireEvent.click(screen.getByText("我的法务"));
    expect(screen.getByPlaceholderText("搜索对话")).toHaveValue("");
  });

  it("localStorage 有 selectedAgentId → 直接进对话列表态", () => {
    localStorage.setItem("ai-assistant:agent:selected", "c1");
    render(<AgentRail {...props} />);
    expect(screen.getByText("合同审查")).toBeTruthy();
  });

  it("localStorage 里的 Agent 已不存在 → 回落到 Agent 列表态", () => {
    localStorage.setItem("ai-assistant:agent:selected", "已删掉");
    render(<AgentRail {...props} />);
    expect(screen.getByPlaceholderText("搜索 Agent")).toBeTruthy();
  });

  it("agentId 为 null 的对话归到默认助手下", () => {
    render(<AgentRail {...props} />);
    fireEvent.click(screen.getByText("默认助手"));
    expect(screen.getByText("闲聊")).toBeTruthy();
  });

  it("预设助手没有 ⋯ 入口", () => {
    render(<AgentRail {...props} />);
    const presetRow = screen.getByText("默认助手").closest("[data-agent-row]")!;
    expect(presetRow.querySelector("[aria-label='更多操作']")).toBeNull();
  });

  it("自建 Agent 有 ⋯ 入口", () => {
    render(<AgentRail {...props} />);
    const customRow = screen.getByText("我的法务").closest("[data-agent-row]")!;
    expect(customRow.querySelector("[aria-label='更多操作']")).toBeTruthy();
  });
});
