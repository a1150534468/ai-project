/**
 * 账号概览:Agent 列表,以及它的刷新入口。
 *
 * 从 `App.tsx` 原样搬出。一条不能动的规则:
 *  - **Agent 拉取失败保持现有列表**。列表清空会让侧栏的 Agent 一瞬间全消失。
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
    if (!token) {
      setAgents({ presets: [], custom: [] });
      return;
    }
    try {
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
