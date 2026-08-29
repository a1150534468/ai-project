/**
 * 账号概览:算力点余额 + Agent 列表,以及它们各自的刷新入口。
 *
 * 从 `App.tsx` 原样搬出。三条不能动的规则:
 *  - **回到前台要重新拉余额**。算力点会被别的端(桌宠、后台充值)改掉,只在挂载时拉一次会一直
 *    显示旧值;所以 focus 与 visibilitychange 都挂监听。
 *  - **`refreshBalance` 会抛**,给页面用的 `onBalanceRefresh` 就是它本人;内部自用一律走
 *    `refreshBalanceQuietly`(失败就把余额置空),不能让一次拉取失败冒成未捕获拒绝。
 *  - **Agent 拉取失败保持现有列表**。列表清空会让侧栏的 Agent 一瞬间全消失。
 */
import { useCallback, useEffect, useState } from "react";
import { getBalance, listAgents, type AgentOption } from "../api";

export interface AgentGroups {
  readonly presets: AgentOption[];
  readonly custom: AgentOption[];
}

export function useAccountOverview(token: string) {
  const [balance, setBalance] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentGroups>({ presets: [], custom: [] });

  const refreshBalance = useCallback(async () => {
    if (!token) {
      setBalance(null);
      return;
    }
    const result = await getBalance(token);
    setBalance(result.balance);
  }, [token]);

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

  /** 内部自用的刷新：拉失败就把余额置空，不往外冒。 */
  const refreshBalanceQuietly = useCallback(() => {
    void refreshBalance().catch(() => setBalance(null));
  }, [refreshBalance]);

  useEffect(() => {
    refreshBalanceQuietly();
  }, [refreshBalanceQuietly]);

  useEffect(() => {
    void refreshAgents().catch(() => {});
  }, [refreshAgents]);

  useEffect(() => {
    if (!token) return;
    const refresh = () => {
      refreshBalanceQuietly();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshBalanceQuietly, token]);

  return { balance, setBalance, agents, refreshBalance, refreshBalanceQuietly, refreshAgents };
}
