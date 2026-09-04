import type { ModelOption, Session, SessionMessage } from "./api";

export type { ModelOption };

/** 界面上的一条消息。后端的 role 是自由字符串，这里只认两种。 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  createdAt: string;
}

/**
 * 聊天页按会话 id 分桶存的三样东西。新会话在拿到真 id 之前先挂在草稿 id 下，
 * 所以这三个桶都要能整体改名 —— 见 moveSessionStateKey。
 */
export interface SessionStateMap {
  messagesBySession: Record<string, ChatMessage[]>;
  runningSessionIds: Set<string>;
  errorsBySession: Record<string, string>;
}

/** 记住的模型还在列表里就接着用，否则用列表第一个；列表空着就返回空串（发消息时走后端默认）。 */
export function pickInitialModel(models: ModelOption[], preferredModel?: string | null): string {
  // 空串与 null 都算「没记住过」，别拿它去匹配
  const remembered = preferredModel ? models.find((option) => option.model === preferredModel) : undefined;
  return remembered?.model ?? models[0]?.model ?? "";
}

/** 会话标题和 Agent 名一起搜，跟 Agent 栏那侧的过滤口径一致。 */
export function filterSessions(sessions: Session[], query: string): Session[] {
  const keyword = query.trim().toLowerCase();
  if (keyword === "") return sessions;
  return sessions.filter((session) => `${session.title} ${session.agentName ?? ""}`.toLowerCase().includes(keyword));
}

/**
 * 把记录里的 fromKey 改名成 toKey：from 有值就用 from 的，否则接住 to 的旧值，
 * 两边都没有就连键都不留（别在 state 里留一堆空桶）。
 *
 * 「有没有」按真值判断，两种桶正好各得其所：空数组是真值，所以「读过、确实没消息」
 * 的会话会被保留；空串是假值，所以「没有报错」不会被当成一条错误留下来。
 */
function renameKey<V>(record: Record<string, V>, fromKey: string, toKey: string, blank: V): Record<string, V> {
  const { [fromKey]: incoming, [toKey]: existing, ...rest } = record;
  if (!incoming && !existing) return rest;
  return { ...rest, [toKey]: incoming ?? existing ?? blank };
}

/** 草稿会话拿到真 id 后，三个桶一起改名。fromKey 与 toKey 相同时原样返回，避免白刷一次渲染。 */
export function moveSessionStateKey(state: SessionStateMap, fromKey: string, toKey: string): SessionStateMap {
  if (fromKey === toKey) return state;

  const running = new Set(state.runningSessionIds);
  // 正在跑的那条流也要跟着改名，否则流回来了找不到落点
  if (running.delete(fromKey)) running.add(toKey);

  return {
    messagesBySession: renameKey(state.messagesBySession, fromKey, toKey, []),
    runningSessionIds: running,
    errorsBySession: renameKey(state.errorsBySession, fromKey, toKey, ""),
  };
}

/** 历史消息进界面：role 收敛成两种，其余字段照抄。 */
export function toChatMessages(messages: readonly SessionMessage[]): ChatMessage[] {
  return messages.map(({ role, content, model, createdAt }) => ({
    role: role === "user" ? "user" : "assistant",
    content,
    model,
    createdAt,
  }));
}
