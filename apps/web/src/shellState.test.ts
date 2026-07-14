// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { loadNavCollapsed, saveNavCollapsed, loadSelectedAgentId, saveSelectedAgentId } from "./shellState";

beforeEach(() => localStorage.clear());

describe("导航折叠状态持久化", () => {
  it("默认缩进", () => expect(loadNavCollapsed()).toBe(true));
  it("显式存了 false 才展开", () => { saveNavCollapsed(false); expect(loadNavCollapsed()).toBe(false); });
  it("存了 true 就读到 true", () => { saveNavCollapsed(true); expect(loadNavCollapsed()).toBe(true); });
  it("localStorage 里是垃圾 → 回落缩进(true)", () => {
    localStorage.setItem("ai-assistant:nav:collapsed", "maybe");
    expect(loadNavCollapsed()).toBe(true);
  });
});

describe("选中的 Agent 持久化", () => {
  it("默认 null", () => expect(loadSelectedAgentId()).toBeNull());
  it("存取往返", () => { saveSelectedAgentId("preset-1"); expect(loadSelectedAgentId()).toBe("preset-1"); });
  it("存 null 即清除", () => { saveSelectedAgentId("x"); saveSelectedAgentId(null); expect(loadSelectedAgentId()).toBeNull(); });
});

import { buildAgentRail, filterAgents, DEFAULT_AGENT_ID } from "./shellState";
import type { AgentOption, Session } from "./api";

const preset = (id: string, name: string): AgentOption => ({ id, name, description: `${name}的描述`, icon: "mdi:x", type: "preset" });
const custom = (id: string, name: string): AgentOption => ({ id, name, description: "", icon: "mdi:y", type: "custom", avatarSvg: "<g/>", avatarUrl: null });
const session = (id: string, agentId: string | null): Session => ({ id, title: id, agentId, updatedAt: "2026-07-08T00:00:00Z" });

describe("buildAgentRail", () => {
  const agents = { presets: [preset("preset-1", "默认助手"), preset("preset-7", "代码审查员"), preset("preset-9", "没人用过")], custom: [custom("c1", "我的法务")] };

  it("自建 Agent 全部出现，哪怕没有对话", () => {
    const { mine } = buildAgentRail(agents, []);
    expect(mine.map((a) => a.id)).toEqual(["c1"]);
    expect(mine[0].sessionCount).toBe(0);
  });
  it("只有用过的预设才出现", () => {
    const { used } = buildAgentRail(agents, [session("s1", "preset-7")]);
    expect(used.map((a) => a.id)).toEqual(["preset-7"]);
  });
  it("agentId 为 null 的历史对话归到默认助手", () => {
    const { used } = buildAgentRail(agents, [session("s1", null), session("s2", null)]);
    expect(used.map((a) => a.id)).toEqual([DEFAULT_AGENT_ID]);
    expect(used[0].sessionCount).toBe(2);
  });
  it("sessionCount 计数正确", () => {
    const { mine, used } = buildAgentRail(agents, [session("s1", "c1"), session("s2", "c1"), session("s3", "preset-7")]);
    expect(mine[0].sessionCount).toBe(2);
    expect(used[0].sessionCount).toBe(1);
  });
  it("指向已不存在 Agent 的对话被忽略，不产生幽灵条目", () => {
    const { mine, used } = buildAgentRail(agents, [session("s1", "已删掉的-id")]);
    expect(mine[0].sessionCount).toBe(0);
    expect(used).toEqual([]);
  });
  it("自建 Agent 带出头像字段", () => {
    const { mine } = buildAgentRail(agents, []);
    expect(mine[0].avatarSvg).toBe("<g/>");
    expect(mine[0].avatarUrl).toBeNull();
  });
});

describe("filterAgents", () => {
  const items = buildAgentRail({ presets: [preset("preset-1", "默认助手")], custom: [custom("c1", "我的法务")] }, [session("s", null)]);
  it("空 query 返回全部", () => expect(filterAgents(items.mine, "")).toHaveLength(1));
  it("按名称匹配", () => expect(filterAgents(items.mine, "法务")).toHaveLength(1));
  it("按描述匹配", () => expect(filterAgents(items.used, "默认助手的描述")).toHaveLength(1));
  it("不匹配返回空", () => expect(filterAgents(items.mine, "不存在")).toHaveLength(0));
});
