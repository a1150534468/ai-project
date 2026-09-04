/**
 * 外壳的纯状态层：侧栏两个 localStorage 键的读写，以及 Agent 栏那两组条目怎么从
 * `/api/agents` + `/api/sessions` 算出来。不碰 React，组件与测试都直接压这一层。
 */
import type { AgentOption, Session } from "./api";

// ── 侧栏偏好（localStorage） ─────────────────────────────────────────────────

const NAV_COLLAPSED_KEY = "ai-assistant:nav:collapsed";
const SELECTED_AGENT_KEY = "ai-assistant:agent:selected";

/**
 * 两个键都走这一对读写。localStorage 不一定在（vitest 的 node 环境、浏览器把存储整个禁掉时
 * 连取属性都会抛），取不到就当没存过 —— 两个键都只是记个偏好，丢了就回默认值，不该带崩侧栏。
 */
function readStored(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` 表示删掉这个键。 */
function writeStored(key: string, value: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 隐私模式下配额是 0，写不进就算了
  }
}

/** 侧栏默认收起：只有用户显式展开过（存下 `"false"`）才展开，垃圾值一律当收起。 */
export function loadNavCollapsed(): boolean {
  return readStored(NAV_COLLAPSED_KEY) !== "false";
}

export function saveNavCollapsed(collapsed: boolean): void {
  writeStored(NAV_COLLAPSED_KEY, String(collapsed));
}

export function loadSelectedAgentId(): string | null {
  return readStored(SELECTED_AGENT_KEY);
}

export function saveSelectedAgentId(id: string | null): void {
  writeStored(SELECTED_AGENT_KEY, id);
}

// ── Agent 栏 ─────────────────────────────────────────────────────────────────

/** agentId 为空的历史 session 归属到默认助手，与后端 resolveAgent 的兜底一致。 */
export const DEFAULT_AGENT_ID = "preset-1";

/** 每条对话归属的 agentId（null → 默认助手）。 */
export function agentIdOfSession(session: Session): string {
  return session.agentId ?? DEFAULT_AGENT_ID;
}

/**
 * 栏里的一条：`AgentOption` 的五个字段 + 三个这一层补上的。
 * 头像那两个在 `AgentOption` 上是可选的，这里拍平成必填可空 —— 组件只判 null，不用再判 undefined。
 */
export interface AgentRailItem extends Readonly<Pick<AgentOption, "id" | "name" | "description" | "type" | "icon">> {
  readonly avatarSvg: string | null;
  readonly avatarUrl: string | null;
  readonly sessionCount: number;
}

export interface AgentRail {
  /** 自建 Agent 全集：一段对话都没有也要在栏里，否则刚建出来的 Agent 找不着。 */
  readonly mine: AgentRailItem[];
  /** 只有真开过对话的预设助手：83 个预设不能全塞进栏。 */
  readonly used: AgentRailItem[];
}

/** 只挑栏里要用的字段，不 `...agent` 摊平 —— `AgentOption` 以后加字段不该跟着漏进这一层。 */
function toItem(agent: AgentOption, sessionCount: number): AgentRailItem {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    type: agent.type,
    icon: agent.icon,
    avatarSvg: agent.avatarSvg ?? null,
    avatarUrl: agent.avatarUrl ?? null,
    sessionCount,
  };
}

/**
 * Agent 栏的数据全在客户端算，不另加聚合接口：对话按 agentId 数一遍，两组各取所需。
 * 指向已删除 Agent 的对话在两组里都匹配不上，于是自动被忽略，不会留下幽灵条目。
 */
export function buildAgentRail(
  agents: { readonly presets: readonly AgentOption[]; readonly custom: readonly AgentOption[] },
  sessions: readonly Session[],
): AgentRail {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const agentId = agentIdOfSession(session);
    counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
  }

  const used: AgentRailItem[] = [];
  for (const preset of agents.presets) {
    const sessionCount = counts.get(preset.id) ?? 0;
    if (sessionCount > 0) used.push(toItem(preset, sessionCount));
  }

  return { mine: agents.custom.map((agent) => toItem(agent, counts.get(agent.id) ?? 0)), used };
}

/** 栏顶搜索：名称或描述任一命中即可，前后空白与大小写都不计。 */
export function filterAgents(items: AgentRailItem[], query: string): AgentRailItem[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return items;

  return items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(keyword));
}
