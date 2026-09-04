// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentOption, Session } from "./api";
import {
  DEFAULT_AGENT_ID,
  buildAgentRail,
  filterAgents,
  loadNavCollapsed,
  loadSelectedAgentId,
  saveNavCollapsed,
  saveSelectedAgentId,
} from "./shellState";

beforeEach(() => localStorage.clear());

describe("侧栏折叠状态", () => {
  it("没存过就是收起", () => {
    expect(loadNavCollapsed()).toBe(true);
  });

  it("存过 true / false 都能原样读回来", () => {
    for (const collapsed of [true, false, true]) {
      saveNavCollapsed(collapsed);

      expect(loadNavCollapsed()).toBe(collapsed);
    }
  });

  // 只有 "false" 一个字面量算展开，其余（历史遗留值、手改的、别的版本写的）一律回落到收起
  for (const stored of ["maybe", "0", "", "FALSE", "true"]) {
    it(`键里是 ${JSON.stringify(stored)} → 收起`, () => {
      localStorage.setItem("ai-assistant:nav:collapsed", stored);

      expect(loadNavCollapsed()).toBe(true);
    });
  }
});

describe("选中的 Agent", () => {
  it("没存过是 null", () => {
    expect(loadSelectedAgentId()).toBeNull();
  });

  it("存取往返", () => {
    saveSelectedAgentId("preset-1");

    expect(loadSelectedAgentId()).toBe("preset-1");
  });

  it("存 null 就是清掉，键本身也不留", () => {
    saveSelectedAgentId("c1");
    saveSelectedAgentId(null);

    expect(loadSelectedAgentId()).toBeNull();
    expect(localStorage.getItem("ai-assistant:agent:selected")).toBeNull();
  });
});

/** 预设助手：头像两个字段都不给，走 `?? null` 那条路。 */
function preset(id: string, name: string): AgentOption {
  return { id, name, description: `${name}的描述`, icon: "mdi:x", type: "preset" };
}

function custom(id: string, name: string): AgentOption {
  return { id, name, description: "", icon: "mdi:y", type: "custom", avatarSvg: "<g/>", avatarUrl: null };
}

function session(id: string, agentId: string | null): Session {
  return { id, title: id, agentId, updatedAt: "2026-07-08T00:00:00Z" };
}

const AGENTS = {
  presets: [preset("preset-1", "默认助手"), preset("preset-7", "Code Review"), preset("preset-9", "没人用过")],
  custom: [custom("c1", "我的法务"), custom("c2", "我的文案")],
};

describe("buildAgentRail", () => {
  it("自建 Agent 全部进栏、顺序不变，没有对话就是 0 段", () => {
    const { mine } = buildAgentRail(AGENTS, []);

    expect(mine.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(mine.map((item) => item.sessionCount)).toEqual([0, 0]);
  });

  it("预设助手只有开过对话的才进栏", () => {
    const { used } = buildAgentRail(AGENTS, [session("s1", "preset-7")]);

    expect(used.map((item) => item.id)).toEqual(["preset-7"]);
  });

  it("agentId 为 null 的历史对话记到默认助手名下", () => {
    const { used } = buildAgentRail(AGENTS, [session("s1", null), session("s2", null)]);

    expect(used.map((item) => item.id)).toEqual([DEFAULT_AGENT_ID]);
    expect(used[0].sessionCount).toBe(2);
  });

  it("两组各自数自己的对话", () => {
    const sessions = [session("s1", "c1"), session("s2", "c1"), session("s3", "preset-7"), session("s4", "c2")];
    const { mine, used } = buildAgentRail(AGENTS, sessions);

    expect(mine.map((item) => item.sessionCount)).toEqual([2, 1]);
    expect(used.map((item) => item.sessionCount)).toEqual([1]);
  });

  it("指向已删除 Agent 的对话谁都不算，不留幽灵条目", () => {
    const { mine, used } = buildAgentRail(AGENTS, [session("s1", "已删掉的-id")]);

    expect(mine.map((item) => item.sessionCount)).toEqual([0, 0]);
    expect(used).toEqual([]);
  });

  it("头像字段拍平：自建的带出来，预设的缺省成 null", () => {
    const { mine, used } = buildAgentRail(AGENTS, [session("s1", null)]);

    expect(mine[0]).toMatchObject({ avatarSvg: "<g/>", avatarUrl: null });
    expect(used[0]).toMatchObject({ avatarSvg: null, avatarUrl: null });
  });
});

describe("filterAgents", () => {
  const rail = buildAgentRail(AGENTS, [session("s", null), session("s2", "preset-7")]);

  it("空 query 原样返回", () => {
    expect(filterAgents(rail.mine, "")).toHaveLength(2);
    expect(filterAgents(rail.mine, "   ")).toHaveLength(2);
  });

  it("按名称匹配，前后空白不计", () => {
    expect(filterAgents(rail.mine, "法务").map((item) => item.id)).toEqual(["c1"]);
    expect(filterAgents(rail.mine, "  法务  ").map((item) => item.id)).toEqual(["c1"]);
  });

  it("大小写不计", () => {
    expect(filterAgents(rail.used, "code review").map((item) => item.id)).toEqual(["preset-7"]);
    expect(filterAgents(rail.used, "CODE").map((item) => item.id)).toEqual(["preset-7"]);
  });

  it("按描述匹配", () => {
    expect(filterAgents(rail.used, "默认助手的描述").map((item) => item.id)).toEqual([DEFAULT_AGENT_ID]);
  });

  it("名称与描述是拼成一串再找的，跨过中间那个空格的串也算命中", () => {
    // 记一笔现有行为：想改成两个字段各自独立匹配的话，这条会红
    expect(filterAgents(rail.used, "默认助手 默认助手的").map((item) => item.id)).toEqual([DEFAULT_AGENT_ID]);
  });

  it("谁都不匹配就是空", () => {
    expect(filterAgents(rail.mine, "不存在")).toEqual([]);
  });
});
