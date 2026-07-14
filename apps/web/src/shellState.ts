import type { AgentOption, Session } from "./api";

const NAV_COLLAPSED_KEY = "ai-assistant:nav:collapsed";
const SELECTED_AGENT_KEY = "ai-assistant:agent:selected";

export function loadNavCollapsed(): boolean {
  if (typeof window === "undefined") return true;
  // 默认缩进：仅当用户显式存过 "false"（手动展开）才不缩进
  return localStorage.getItem(NAV_COLLAPSED_KEY) !== "false";
}

export function saveNavCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(NAV_COLLAPSED_KEY, String(collapsed));
}

export function loadSelectedAgentId(): string | null {
  return localStorage.getItem(SELECTED_AGENT_KEY);
}

export function saveSelectedAgentId(id: string | null): void {
  if (id === null) localStorage.removeItem(SELECTED_AGENT_KEY);
  else localStorage.setItem(SELECTED_AGENT_KEY, id);
}

/** agentId 为空的历史 session 归属到默认助手，与后端 resolveAgent 的兜底一致 */
export const DEFAULT_AGENT_ID = "preset-1";

export interface AgentRailItem {
  id: string;
  name: string;
  description: string;
  type: "preset" | "custom";
  icon: string;
  avatarSvg: string | null;
  avatarUrl: string | null;
  sessionCount: number;
}

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

/** 每个对话归属的 agentId（null → 默认助手） */
export function agentIdOfSession(session: Session): string {
  return session.agentId ?? DEFAULT_AGENT_ID;
}

/**
 * Agent 栏数据全部由客户端从已有的 /api/agents + /api/sessions 算出，不需要聚合接口。
 * - mine：自建 Agent 全集（哪怕 sessionCount === 0，否则刚建的 Agent 在栏里找不到）
 * - used：只包含真开过对话的预设助手（83 个预设不能全塞进栏）
 * 指向已删除 Agent 的对话被忽略，不产生幽灵条目。
 */
export function buildAgentRail(
  agents: { presets: AgentOption[]; custom: AgentOption[] },
  sessions: Session[],
): { mine: AgentRailItem[]; used: AgentRailItem[] } {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const id = agentIdOfSession(s);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return {
    mine: agents.custom.map((a) => toItem(a, counts.get(a.id) ?? 0)),
    used: agents.presets.filter((p) => (counts.get(p.id) ?? 0) > 0).map((p) => toItem(p, counts.get(p.id)!)),
  };
}

export function filterAgents(items: AgentRailItem[], query: string): AgentRailItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((a) => `${a.name} ${a.description}`.toLowerCase().includes(q));
}
