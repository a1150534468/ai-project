import type { Session } from "./api";

export interface ModelOption {
  model: string;
  displayName: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  createdAt: string;
}

export interface SessionStateMap {
  messagesBySession: Record<string, ChatMessage[]>;
  runningSessionIds: Set<string>;
  errorsBySession: Record<string, string>;
}

export function pickInitialModel(models: ModelOption[], preferredModel?: string | null): string {
  if (preferredModel && models.some((m) => m.model === preferredModel)) return preferredModel;
  return models[0]?.model ?? "";
}

export function filterSessions(sessions: Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((session) =>
    `${session.title} ${session.agentName ?? ""}`.toLowerCase().includes(q)
  );
}

export function moveSessionStateKey(
  state: SessionStateMap,
  fromKey: string,
  toKey: string,
): SessionStateMap {
  if (fromKey === toKey) return state;

  const { [fromKey]: fromMessages, [toKey]: toMessages, ...restMessages } = state.messagesBySession;
  const { [fromKey]: fromError, [toKey]: toError, ...restErrors } = state.errorsBySession;
  const running = new Set(state.runningSessionIds);
  if (running.delete(fromKey)) running.add(toKey);

  return {
    messagesBySession: {
      ...restMessages,
      ...(fromMessages || toMessages ? { [toKey]: fromMessages ?? toMessages ?? [] } : {}),
    },
    runningSessionIds: running,
    errorsBySession: {
      ...restErrors,
      ...(fromError || toError ? { [toKey]: fromError ?? toError ?? "" } : {}),
    },
  };
}

export function toChatMessages(messages: Array<{ role: string; content: string; model?: string; createdAt: string }>): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    model: message.model,
    createdAt: message.createdAt,
  }));
}
