/**
 * 对话会话层:四份按会话分桶的记录(消息/错误/引用/运行中)、会话列表、当前选中与当前 Agent,
 * 以及切换 / 删除 / 开新对话这三个入口。
 *
 * 从 `App.tsx` 原样搬出。四条不能动的规则:
 *  - **四份记录都按会话键分桶**,键是「真实 sessionId 或草稿键」。新对话还没有 sessionId,
 *    先挂在草稿键上,后端回 `session` 事件时整体搬到真实 id 上(见 `promoteDraftSession`)。
 *    少搬一份,页面就会出现「消息还在草稿键上、看的却是真实 id」的空白对话。
 *  - **切会话要认请求序号**。连点两个会话时,先发的请求可能后回;`selectSessionRequestRef`
 *    保证只有最后一次点击的结果能写回。
 *  - **已经载入过的会话不重复拉**(`messagesBySession[id]` 有值就直接返回),否则每次点回去
 *    都会把正在流式的内容冲掉。
 *  - **删除只在确认成功后落地**,四份记录都要按 id 摘掉;删掉的正是当前会话时要让上层重开
 *    Agent 选择,不能留在一个已经不存在的会话上。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteSession, getSessionMessages, listSessions, type AgentOption, type Session } from "../api";
import { toChatMessages, type ChatMessage } from "../chatState";
import { saveSelectedAgentId } from "../shellState";

export interface Citation {
  docs: Array<{ docName: string; ordinal: number }>;
}

export const newDraftKey = () => `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`;

export function sessionAgentOption(session?: Session): AgentOption | null {
  if (!session?.agentId || !session.agentName) return null;
  return {
    id: session.agentId,
    name: session.agentName,
    description: "",
    icon: session.agentIcon ?? "mdi:robot-outline",
    type: session.agentId.startsWith("preset-") ? "preset" : "custom",
  };
}

export interface PromotedSession {
  readonly previousKey: string;
  readonly sessionId: string;
  readonly title: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly agentIcon: string | null;
}

export function useChatSessions(args: {
  readonly token: string;
  /** 只有对话页会拉会话列表 */
  readonly chatViewActive: boolean;
  readonly confirm: (options: {
    title: string;
    message: string;
    onConfirm: () => Promise<void>;
    confirmText?: string;
    cancelText?: string;
    isDangerous?: boolean;
  }) => Promise<boolean>;
  /** 选中某个会话时要回到对话页 */
  readonly onEnterChat: () => void;
  /** 开了新对话:关掉 Agent 选择弹窗、收起 Agent 栏 */
  readonly onAgentSessionStarted: () => void;
  /** 删掉的正是当前会话:让上层重新弹 Agent 选择 */
  readonly onActiveSessionDeleted: () => void;
}) {
  const { token, chatViewActive, confirm, onEnterChat, onAgentSessionStarted, onActiveSessionDeleted } = args;
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [draftSessionKey, setDraftSessionKey] = useState(newDraftKey);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [errorsBySession, setErrorsBySession] = useState<Record<string, string>>({});
  const [citationsBySession, setCitationsBySession] = useState<Record<string, Citation[]>>({});
  const [activeAgent, setActiveAgent] = useState<AgentOption | null>(null);
  const selectSessionRequestRef = useRef(0);
  const activeSessionKey = sessionId ?? draftSessionKey;
  /** 流式回调里要判断「当前看的还是不是这条会话」,用 ref 取最新值 */
  const activeSessionKeyRef = useRef(activeSessionKey);

  useEffect(() => {
    activeSessionKeyRef.current = activeSessionKey;
  }, [activeSessionKey]);

  // 加载会话（须在任何条件 return 之前调用，保证 hook 顺序稳定）
  useEffect(() => {
    if (!token || !chatViewActive) return;
    listSessions(token).then(setSessions).catch(() => {});
  }, [chatViewActive, token]);

  const refreshSessions = useCallback(async () => {
    if (!token) {
      setSessions([]);
      return;
    }
    try {
      setSessions(await listSessions(token));
    } catch {
      // 忽略错误，保持现有 sessions
    }
  }, [token]);

  const startAgentSession = useCallback(
    (agent: AgentOption) => {
      selectSessionRequestRef.current += 1;
      const key = newDraftKey();
      setSessionId(undefined);
      setDraftSessionKey(key);
      setMessagesBySession((prev) => ({ ...prev, [key]: [] }));
      setErrorsBySession((prev) => ({ ...prev, [key]: "" }));
      setCitationsBySession((prev) => ({ ...prev, [key]: [] }));
      setActiveAgent(agent);
      // 选完 Agent（无论从弹窗还是列表）默认开启新对话并收起 Agent 栏；
      // 记住选中的 Agent，展开该栏时能看到它的历史对话
      saveSelectedAgentId(agent.id);
      onAgentSessionStarted();
    },
    [onAgentSessionStarted],
  );

  const handleSelectSession = useCallback(
    async (id: string) => {
      const requestId = selectSessionRequestRef.current + 1;
      selectSessionRequestRef.current = requestId;
      const selected = sessions.find((session) => session.id === id);
      onEnterChat();
      setSessionId(id);
      setActiveAgent(sessionAgentOption(selected));

      if (messagesBySession[id]) return;

      try {
        const msgs = await getSessionMessages(token, id);
        if (selectSessionRequestRef.current !== requestId) return;
        setMessagesBySession((prev) => ({ ...prev, [id]: toChatMessages(msgs) }));
        setErrorsBySession((prev) => ({ ...prev, [id]: "" }));
        setCitationsBySession((prev) => ({ ...prev, [id]: [] }));
      } catch (err) {
        if (selectSessionRequestRef.current !== requestId) return;
        setErrorsBySession((prev) => ({
          ...prev,
          [id]: `加载会话失败: ${err instanceof Error ? err.message : "未知错误"}`,
        }));
      }
    },
    [messagesBySession, onEnterChat, sessions, token],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      const confirmed = await confirm({
        title: "删除会话",
        message: "确定要删除该会话吗？此操作不可恢复。",
        onConfirm: async () => {
          await deleteSession(token, id);
        },
        confirmText: "删除",
        cancelText: "取消",
        isDangerous: true,
      });

      if (confirmed) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setMessagesBySession((prev) => {
          const { [id]: _removed, ...rest } = prev;
          return rest;
        });
        setErrorsBySession((prev) => {
          const { [id]: _removed, ...rest } = prev;
          return rest;
        });
        setCitationsBySession((prev) => {
          const { [id]: _removed, ...rest } = prev;
          return rest;
        });
        if (sessionId === id) {
          onActiveSessionDeleted();
        }
      }
    },
    [confirm, onActiveSessionDeleted, sessionId, token],
  );

  /** 发车:用户消息入列,清掉上一轮的错误/引用,并打上运行标记。 */
  const beginTurn = useCallback((key: string, userMessage: ChatMessage) => {
    setMessagesBySession((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), userMessage] }));
    setErrorsBySession((prev) => ({ ...prev, [key]: "" }));
    setCitationsBySession((prev) => ({ ...prev, [key]: [] }));
    setRunningSessionIds((prev) => new Set(prev).add(key));
  }, []);

  /**
   * 草稿键 → 真实 sessionId。四份记录、运行标记、当前选中、会话列表都要一起搬:
   * 少搬一份就会出现「消息挂在草稿键上、页面看的却是真实 id」的空白对话。
   *
   * 当前选中只在「用户还停在这条会话上」时才改 —— 期间他可能已经点去别的会话了。
   */
  const promoteDraftSession = useCallback((next: PromotedSession) => {
    const { previousKey, sessionId: nextId } = next;
    setMessagesBySession((prev) => {
      const { [previousKey]: draftMessages = [], ...rest } = prev;
      return { ...rest, [nextId]: draftMessages };
    });
    setErrorsBySession((prev) => {
      const { [previousKey]: draftError = "", ...rest } = prev;
      return { ...rest, [nextId]: draftError };
    });
    setCitationsBySession((prev) => {
      const { [previousKey]: draftCitations = [], ...rest } = prev;
      return { ...rest, [nextId]: draftCitations };
    });
    setRunningSessionIds((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.delete(previousKey)) nextSet.add(nextId);
      return nextSet;
    });
    if (activeSessionKeyRef.current === previousKey) {
      setSessionId(nextId);
    }
    setSessions((prev) => {
      if (prev.some((session) => session.id === nextId)) return prev;
      return [{
        id: nextId,
        title: next.title,
        agentId: next.agentId,
        agentName: next.agentName,
        agentIcon: next.agentIcon,
        updatedAt: new Date().toISOString(),
      }, ...prev];
    });
  }, []);

  /** 后端通知：作废当前这轮已流式的助手文本（工具调用前的说明 / 重试的半截） */
  const dropTrailingAssistant = useCallback((key: string) => {
    setMessagesBySession((prev) => {
      const list = prev[key] ?? [];
      const last = list[list.length - 1];
      if (last?.role === "assistant") {
        return { ...prev, [key]: list.slice(0, -1) };
      }
      return prev;
    });
  }, []);

  /** 流式文本:尾部已经是助手消息就续在同一条上,否则新开一条。 */
  const appendAssistantText = useCallback((key: string, text: string, model?: string) => {
    setMessagesBySession((prev) => {
      const list = prev[key] ?? [];
      const last = list[list.length - 1];
      if (last?.role === "assistant") {
        return {
          ...prev,
          [key]: [...list.slice(0, -1), { ...last, content: `${last.content}${text}` }],
        };
      }
      return {
        ...prev,
        [key]: [
          ...list,
          { role: "assistant", content: text, model, createdAt: new Date().toISOString() },
        ],
      };
    });
  }, []);

  const appendCitation = useCallback((key: string, docs: Array<{ docName: string; ordinal: number }>) => {
    setCitationsBySession((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), { docs }] }));
  }, []);

  const setSessionError = useCallback((key: string, message: string) => {
    setErrorsBySession((prev) => ({ ...prev, [key]: message }));
  }, []);

  /** 收车:摘掉运行标记,并把这条会话的更新时间顶到最前(会话列表按它排序)。 */
  const endTurn = useCallback((key: string, settledSessionId: string | undefined) => {
    setRunningSessionIds((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (settledSessionId) {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === settledSessionId ? { ...session, updatedAt: new Date().toISOString() } : session
        )
      );
    }
  }, []);

  return {
    sessionId,
    draftSessionKey,
    activeSessionKey,
    sessions,
    messagesBySession,
    runningSessionIds,
    errorsBySession,
    citationsBySession,
    activeAgent,
    refreshSessions,
    startAgentSession,
    handleSelectSession,
    handleDeleteSession,
    /** 流式回调专用的写入口,`useChatStream` 是唯一调用方。 */
    turn: {
      begin: beginTurn,
      promote: promoteDraftSession,
      dropTrailingAssistant,
      appendText: appendAssistantText,
      appendCitation,
      fail: setSessionError,
      end: endTurn,
    },
  };
}

export type ChatSessionsController = ReturnType<typeof useChatSessions>;
