/**
 * 账号概览:Agent 列表,以及它的刷新入口。
 *
 * 两条不能动的规则:
 *  - **Agent 拉取失败保持现有列表**。列表清空会让侧栏的 Agent 一瞬间全消失。
 *  - **未登录也要拉**。`/api/agents` 开放匿名访问:匿名返回内置 presets、custom 为空,
 *    这样未登录浏览时侧栏仍能展示预置 Agent。登录动作在发送处才拦。
 */
import { useCallback, useEffect, useState } from "react";
import { listAgents, type AgentOption } from "../api";

export interface AgentGroups {
  readonly presets: AgentOption[];
  readonly custom: AgentOption[];
}

export function useAccountOverview(token: string) {
  const [agents, setAgents] = useState<AgentGroups>({ presets: [], custom: [] });

  const refreshAgents = useCallback(async () => {
    try {
      // 传空串即匿名(http 不带鉴权头):后端照样给 presets,custom 为空。
      setAgents(await listAgents(token));
    } catch {
      // 忽略错误，保持现有 agents
    }
  }, [token]);

  useEffect(() => {
    void refreshAgents().catch(() => {});
  }, [refreshAgents]);

  return { agents, refreshAgents };
}
