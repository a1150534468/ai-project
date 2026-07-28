import { useState, useEffect, useRef, useCallback } from "react";
import {
  ApiError,
  getBalance,
  getMe,
  listSessions,
  getSessionMessages,
  deleteSession,
  streamChat,
  listAgents,
  type AgentOption,
  type ChatAttachmentPayload,
  type MeResponse,
  type Session,
} from "./api";
import Shell, { type ViewType, type WorkflowSubId } from "./components/shell/Shell";
import { saveSelectedAgentId } from "./shellState";
import type { WorkflowModuleId } from "./workflowState";
import Login from "./components/Login";
import Register from "./components/Register";
import Chat from "./pages/Chat";
import Knowledge from "./pages/Knowledge";
import ToolMarket from "./pages/ToolMarket";
import Workflow from "./pages/Workflow";
import Video from "./pages/Video";
import DigitalHuman from "./pages/DigitalHuman";
import Report from "./pages/Report";
import AgentTeams from "./pages/AgentTeams";
import Billing from "./pages/Billing";
import Memory from "./pages/Memory";
import Settings from "./pages/Settings";
import ModelMarketplace from "./pages/ModelMarketplace";
import WechatBind from "./pages/WechatBind";
import { useConfirm } from "./components/ConfirmDialog";
import { AgentPicker } from "./components/AgentPicker";
import { Modal } from "./motion";
import { toChatMessages, type ChatMessage, type ToolActivity } from "./chatState";
import { attachmentLabels } from "./chatAttachments";
import { novelProjectIdFromHash } from "./novelRoute";
import {
  DEFAULT_CLIENT_MENU_VISIBILITY,
  clientMenuKeyForView,
  firstVisibleClientView,
  getClientMenuVisibility,
  isClientMenuVisible,
  isWorkflowSubVisible,
  type ClientMenuVisibility,
} from "./clientMenu";

interface Citation {
  docs: Array<{ docName: string; ordinal: number }>;
}

const newDraftKey = () => `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`;

function sessionAgentOption(session?: Session): AgentOption | null {
  if (!session?.agentId || !session.agentName) return null;
  return {
    id: session.agentId,
    name: session.agentName,
    description: "",
    icon: session.agentIcon ?? "mdi:robot-outline",
    type: session.agentId.startsWith("preset-") ? "preset" : "custom",
  };
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("ai_assistant_token") ?? "");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [authView, setAuthView] = useState<"login" | "register">("login");
  const [view, setView] = useState<ViewType>(() => novelProjectIdFromHash(window.location.hash) ? "workflow" : "chat");
  const [workflowModule, setWorkflowModule] = useState<WorkflowModuleId>(() => novelProjectIdFromHash(window.location.hash) ? "novel" : "image");
  const [codexPetProjectTarget, setCodexPetProjectTarget] = useState<string | null>(null);
  const [knowledgeDocumentTarget, setKnowledgeDocumentTarget] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [draftSessionKey, setDraftSessionKey] = useState(newDraftKey);
  const [balance, setBalance] = useState<number | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<{ presets: AgentOption[]; custom: AgentOption[] }>({ presets: [], custom: [] });
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [errorsBySession, setErrorsBySession] = useState<Record<string, string>>({});
  const [citationsBySession, setCitationsBySession] = useState<Record<string, Citation[]>>({});
  const [toolActivitiesBySession, setToolActivitiesBySession] = useState<Record<string, ToolActivity[]>>({});
  const [activeAgent, setActiveAgent] = useState<AgentOption | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [rechargePromptOpen, setRechargePromptOpen] = useState(false);
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
  const [preferredModel, setPreferredModel] = useState(() => localStorage.getItem("preferredModel") ?? "");
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("preferredModel") ?? "");
  const [menuVisibility, setMenuVisibility] = useState<ClientMenuVisibility>(DEFAULT_CLIENT_MENU_VISIBILITY);
  const selectSessionRequestRef = useRef(0);
  const activeSessionKey = sessionId ?? draftSessionKey;
  const activeSessionKeyRef = useRef(activeSessionKey);
  const { confirm, Dialog } = useConfirm();

  useEffect(() => {
    activeSessionKeyRef.current = activeSessionKey;
  }, [activeSessionKey]);

  // 持久化 token：刷新不丢登录态
  useEffect(() => {
    if (token) localStorage.setItem("ai_assistant_token", token);
    else localStorage.removeItem("ai_assistant_token");
  }, [token]);

  // 拉取当前账号信息（设置页展示 uid/用户名）；token 失效时清除登录态
  useEffect(() => {
    if (!token) {
      setMe(null);
      return;
    }
    let cancelled = false;
    getMe(token)
      .then((profile) => {
        if (!cancelled) setMe(profile);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMe(null);
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setToken("");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 加载会话（须在任何条件 return 之前调用，保证 hook 顺序稳定）
  useEffect(() => {
    if (!token || view !== "chat") return;
    listSessions(token).then(setSessions).catch(() => {});
  }, [view, token]);

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

  const handleAgentsChanged = useCallback(async () => {
    await refreshAgents();
    await refreshSessions();
  }, [refreshAgents, refreshSessions]);

  useEffect(() => {
    void refreshBalance().catch(() => setBalance(null));
  }, [refreshBalance]);

  useEffect(() => {
    void refreshAgents().catch(() => {});
  }, [refreshAgents]);

  useEffect(() => {
    if (!token) {
      setMenuVisibility(DEFAULT_CLIENT_MENU_VISIBILITY);
      // Do not carry another user's deep-link targets across logout/login.
      setCodexPetProjectTarget(null);
      setKnowledgeDocumentTarget(null);
      return;
    }
    const refresh = () => {
      void getClientMenuVisibility(token).then(setMenuVisibility).catch(() => {
        setMenuVisibility(DEFAULT_CLIENT_MENU_VISIBILITY);
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [token]);

  // Cross-page jumps (Knowledge ↔ Codex pet) are one-shot navigation
  // intents.  Keeping an old target around would make a later, ordinary visit
  // to either page unexpectedly reopen a stale project/document.  Clear the
  // opposite intent as soon as its destination is left; the destination
  // itself keeps the intent alive for the first render that consumes it.
  useEffect(() => {
    if (view !== "workflow") setCodexPetProjectTarget(null);
    if (view !== "kb") setKnowledgeDocumentTarget(null);
  }, [view]);

  useEffect(() => {
    const mainKey = clientMenuKeyForView(view);
    const mainVisible = mainKey === null || isClientMenuVisible(menuVisibility, mainKey);
    const workflowVisible = isClientMenuVisible(menuVisibility, "nav.workflow");
    const subVisible = view === "report"
      ? isClientMenuVisible(menuVisibility, "workflow.report")
      : view === "workflow"
        ? isWorkflowSubVisible(menuVisibility, workflowModule)
        : true;
    if (!mainVisible || ((view === "workflow" || view === "report") && (!workflowVisible || !subVisible))) {
      setView(firstVisibleClientView(menuVisibility));
    }
  }, [menuVisibility, view, workflowModule]);

  useEffect(() => {
    if (!token) return;
    const refresh = () => {
      void refreshBalance().catch(() => setBalance(null));
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
  }, [refreshBalance, token]);

  const handlePreferredModelChange = useCallback((model: string) => {
    setPreferredModel(model);
    setSelectedModel(model);
    localStorage.setItem("preferredModel", model);
  }, []);

  if (!token) {
    if (authView === "register") {
      return (
        <Register
          onAuthed={setToken}
          onSwitchToLogin={() => setAuthView("login")}
        />
      );
    }
    return (
      <Login
        onLogin={setToken}
        onSwitchToRegister={() => setAuthView("register")}
      />
    );
  }

  const handleOpenAgentPicker = () => {
    setView("chat");
    setAgentPickerOpen(true);
  };

  const handleNewSessionForAgent = (agentId: string) => {
    const agent = [...agents.custom, ...agents.presets].find((a) => a.id === agentId);
    if (agent) startAgentSession(agent);
  };

  // 工作流二级菜单：AI 智能报告切到 report 页，其余切到对应工作流模块
  const handleSelectWorkflowSub = (id: WorkflowSubId) => {
    if (id === "report") {
      setView("report");
      return;
    }
    // Selecting a module from the menu is a fresh navigation intent, not a
    // continuation of a previous Knowledge → Codex deep link.
    setCodexPetProjectTarget(null);
    setWorkflowModule(id);
    setView("workflow");
  };

  const startAgentSession = (agent: AgentOption) => {
    selectSessionRequestRef.current += 1;
    const key = newDraftKey();
    setSessionId(undefined);
    setDraftSessionKey(key);
    setMessagesBySession((prev) => ({ ...prev, [key]: [] }));
    setErrorsBySession((prev) => ({ ...prev, [key]: "" }));
    setCitationsBySession((prev) => ({ ...prev, [key]: [] }));
    setToolActivitiesBySession((prev) => ({ ...prev, [key]: [] }));
    setActiveAgent(agent);
    setAgentPickerOpen(false);
    // 选完 Agent（无论从弹窗还是列表）默认开启新对话并收起 Agent 栏；
    // 记住选中的 Agent，展开该栏时能看到它的历史对话
    saveSelectedAgentId(agent.id);
    setAgentPanelCollapsed(true);
  };

  const handleSelectSession = async (id: string) => {
    const requestId = selectSessionRequestRef.current + 1;
    selectSessionRequestRef.current = requestId;
    const selected = sessions.find((session) => session.id === id);
    setView("chat");
    setSessionId(id);
    setActiveAgent(sessionAgentOption(selected));

    if (messagesBySession[id]) return;

    try {
      const msgs = await getSessionMessages(token, id);
      if (selectSessionRequestRef.current !== requestId) return;
      setMessagesBySession((prev) => ({ ...prev, [id]: toChatMessages(msgs) }));
      setErrorsBySession((prev) => ({ ...prev, [id]: "" }));
      setCitationsBySession((prev) => ({ ...prev, [id]: [] }));
      setToolActivitiesBySession((prev) => ({ ...prev, [id]: [] }));
    } catch (err) {
      if (selectSessionRequestRef.current !== requestId) return;
      setErrorsBySession((prev) => ({
        ...prev,
        [id]: `加载会话失败: ${err instanceof Error ? err.message : "未知错误"}`,
      }));
    }
  };

  const handleDeleteSession = async (id: string) => {
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
      setToolActivitiesBySession((prev) => {
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });
      if (sessionId === id) {
        handleOpenAgentPicker();
      }
    }
  };

  const handleChatSend = (payload: {
    message: string;
    model?: string;
    kbIds?: string[];
    attachAllOwn?: boolean;
    toolIds?: string[];
    attachments?: ChatAttachmentPayload[];
  }) => {
    const startedWithSessionId = sessionId;
    const startKey = activeSessionKey;
    let streamKey = startKey;
    let currentSessionId = startedWithSessionId;
    let effectiveModel = payload.model;
    const agent = activeAgent;

    if (runningSessionIds.has(startKey)) return;

    const userMessage: ChatMessage = {
      role: "user",
      content: `${payload.message.trim()}${attachmentLabels(payload.attachments ?? [])}`.trim() || "[附件]",
      createdAt: new Date().toISOString(),
    };

    setMessagesBySession((prev) => ({ ...prev, [startKey]: [...(prev[startKey] ?? []), userMessage] }));
    setErrorsBySession((prev) => ({ ...prev, [startKey]: "" }));
    setCitationsBySession((prev) => ({ ...prev, [startKey]: [] }));
    setToolActivitiesBySession((prev) => ({ ...prev, [startKey]: [] }));
    setRunningSessionIds((prev) => new Set(prev).add(startKey));

    void (async () => {
      try {
        await streamChat(
          token,
          payload.message,
          currentSessionId,
          (event, data) => {
            if (event === "session") {
              const meta = data as {
                sessionId: string;
                agentId?: string;
                agentName?: string;
                agentIcon?: string;
                model?: string;
              };
              effectiveModel = meta.model ?? effectiveModel;
              if (!currentSessionId) {
                const previousKey = streamKey;
                currentSessionId = meta.sessionId;
                streamKey = meta.sessionId;

                setMessagesBySession((prev) => {
                  const { [previousKey]: draftMessages = [], ...rest } = prev;
                  return { ...rest, [meta.sessionId]: draftMessages };
                });
                setErrorsBySession((prev) => {
                  const { [previousKey]: draftError = "", ...rest } = prev;
                  return { ...rest, [meta.sessionId]: draftError };
                });
                setCitationsBySession((prev) => {
                  const { [previousKey]: draftCitations = [], ...rest } = prev;
                  return { ...rest, [meta.sessionId]: draftCitations };
                });
                setToolActivitiesBySession((prev) => {
                  const { [previousKey]: draftTools = [], ...rest } = prev;
                  return { ...rest, [meta.sessionId]: draftTools };
                });
                setRunningSessionIds((prev) => {
                  const next = new Set(prev);
                  if (next.delete(previousKey)) next.add(meta.sessionId);
                  return next;
                });
                if (activeSessionKeyRef.current === previousKey) {
                  setSessionId(meta.sessionId);
                }
                setSessions((prev) => {
                  if (prev.some((session) => session.id === meta.sessionId)) return prev;
                  return [{
                    id: meta.sessionId,
                    title: payload.message.slice(0, 30) || "新对话",
                    agentId: meta.agentId ?? agent?.id ?? null,
                    agentName: meta.agentName ?? agent?.name ?? null,
                    agentIcon: meta.agentIcon ?? agent?.icon ?? null,
                    updatedAt: new Date().toISOString(),
                  }, ...prev];
                });
              }
              return;
            }

            if (event === "ping") {
              return;
            }

            if (event === "tool") {
              const tool = data as Omit<ToolActivity, "updatedAt">;
              setToolActivitiesBySession((prev) => {
                const list = prev[streamKey] ?? [];
                const nextTool: ToolActivity = { ...tool, updatedAt: new Date().toISOString() };
                const existingIndex = list.findIndex((item) => item.id === nextTool.id);
                const nextList = existingIndex >= 0
                  ? [...list.slice(0, existingIndex), nextTool, ...list.slice(existingIndex + 1)]
                  : [...list, nextTool];
                return { ...prev, [streamKey]: nextList.slice(-12) };
              });
              return;
            }

            if (event === "reset") {
              // 后端通知：作废当前这轮已流式的助手文本（工具调用前的说明 / 重试的半截）
              setMessagesBySession((prev) => {
                const list = prev[streamKey] ?? [];
                const last = list[list.length - 1];
                if (last?.role === "assistant") {
                  return { ...prev, [streamKey]: list.slice(0, -1) };
                }
                return prev;
              });
              return;
            }

            if (event === "text") {
              const text = (data as { text?: string }).text ?? "";
              if (!text) return;
              setMessagesBySession((prev) => {
                const list = prev[streamKey] ?? [];
                const last = list[list.length - 1];
                if (last?.role === "assistant") {
                  return {
                    ...prev,
                    [streamKey]: [...list.slice(0, -1), { ...last, content: `${last.content}${text}` }],
                  };
                }
                return {
                  ...prev,
                  [streamKey]: [
                    ...list,
                    { role: "assistant", content: text, model: effectiveModel, createdAt: new Date().toISOString() },
                  ],
                };
              });
              return;
            }

            if (event === "citation") {
              const citation = data as { kb?: Array<{ docName: string; ordinal: number }> };
              if (citation.kb?.length) {
                setCitationsBySession((prev) => ({
                  ...prev,
                  [streamKey]: [...(prev[streamKey] ?? []), { docs: citation.kb ?? [] }],
                }));
              }
              return;
            }

            if (event === "error") {
              const errData = data as { message?: string; code?: string };
              setErrorsBySession((prev) => ({
                ...prev,
                [streamKey]: errData.message || "生成失败，请重试",
              }));
              if (errData.code === "INSUFFICIENT_BALANCE") {
                setRechargePromptOpen(true);
              }
            }
          },
          payload.model,
          currentSessionId ? undefined : agent?.id,
          payload.kbIds,
          payload.attachAllOwn,
          payload.attachments,
          payload.toolIds,
        );
      } catch (err) {
        setErrorsBySession((prev) => ({
          ...prev,
          [streamKey]: `发送失败: ${err instanceof Error ? err.message : "未知错误"}`,
        }));
      } finally {
        setRunningSessionIds((prev) => {
          const next = new Set(prev);
          next.delete(streamKey);
          return next;
        });
        if (currentSessionId) {
          setSessions((prev) =>
            prev.map((session) =>
              session.id === currentSessionId ? { ...session, updatedAt: new Date().toISOString() } : session
            )
          );
        }
        void refreshBalance().catch(() => setBalance(null));
      }
    })();
  };

  const renderContent = () => {
    if (view === "wechat") {
      return <WechatBind token={token} />;
    }

    if (view === "memory") {
      return <Memory token={token} />;
    }

    if (view === "settings") {
      return (
        <Settings
          token={token}
          uid={me?.uid}
          userName={me?.username}
          preferredModel={preferredModel}
          onPreferredModelChange={handlePreferredModelChange}
          onLogout={() => setToken("")}
        />
      );
    }

    if (view === "models") {
      return <ModelMarketplace token={token} />;
    }

    if (view === "billing") {
      return <Billing token={token} onBalanceChange={setBalance} />;
    }

    if (view === "kb") {
      return (
        <Knowledge
          token={token}
          initialDocumentId={knowledgeDocumentTarget}
          onViewChange={(v: string) => setView(v as ViewType)}
          onOpenCodexPetProject={(projectId) => {
            setKnowledgeDocumentTarget(null);
            setCodexPetProjectTarget(projectId);
            setWorkflowModule("codex-pet");
            setView("workflow");
          }}
        />
      );
    }

    if (view === "tool-market") {
      return <ToolMarket token={token} />;
    }

    if (view === "workflow") {
      return (
        <Workflow
          token={token}
          activeModuleId={workflowModule}
          menuVisibility={menuVisibility}
          onBalanceRefresh={refreshBalance}
          initialCodexPetProjectId={codexPetProjectTarget}
          onOpenKnowledgeDocument={(documentId) => {
            setCodexPetProjectTarget(null);
            setKnowledgeDocumentTarget(documentId);
            setView("kb");
          }}
        />
      );
    }

    if (view === "video") {
      return <Video token={token} onBalanceRefresh={refreshBalance} />;
    }

    if (view === "digital-human") {
      return <DigitalHuman token={token} onBalanceRefresh={refreshBalance} />;
    }

    if (view === "report") {
      return <Report token={token} onBalanceRefresh={refreshBalance} />;
    }

    if (view === "agent-teams") {
      return (
        <AgentTeams
          token={token}
          selectedModel={selectedModel}
          preferredModel={preferredModel}
          onModelChange={handlePreferredModelChange}
          onBalanceRefresh={refreshBalance}
        />
      );
    }

    return (
      <Chat
        key={activeSessionKey}
        token={token}
        sessionId={sessionId}
        sessionTitle={sessions.find((s) => s.id === sessionId)?.title}
        agentName={activeAgent?.name ?? "默认助手"}
        agentIcon={activeAgent?.icon}
        agentAvatarSvg={activeAgent?.avatarSvg ?? null}
        agentAvatarUrl={activeAgent?.avatarUrl ?? null}
        messages={messagesBySession[activeSessionKey] ?? []}
        isLoading={runningSessionIds.has(activeSessionKey)}
        error={errorsBySession[activeSessionKey] ?? ""}
        citations={citationsBySession[activeSessionKey] ?? []}
        toolActivities={toolActivitiesBySession[activeSessionKey] ?? []}
        selectedModel={selectedModel}
        preferredModel={preferredModel}
        onModelChange={handlePreferredModelChange}
        onOpenToolMarket={() => setView("tool-market")}
        onSend={handleChatSend}
        agentPanelCollapsed={agentPanelCollapsed}
        onToggleAgentPanel={() => setAgentPanelCollapsed((v) => !v)}
      />
    );
  };

  return (
    <>
      <Shell
        currentView={view}
        onViewChange={setView}
        workflowModule={workflowModule}
        onSelectWorkflowSub={handleSelectWorkflowSub}
        balance={balance}
        onLogout={() => setToken("")}
        token={token}
        agents={agents}
        sessions={sessions}
        runningSessionIds={runningSessionIds}
        currentSessionId={sessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSessionForAgent}
        onDeleteSession={handleDeleteSession}
        onOpenAgentPicker={handleOpenAgentPicker}
        onAgentsChanged={handleAgentsChanged}
        agentPanelCollapsed={agentPanelCollapsed}
        onRequestCollapseAgentPanel={() => setAgentPanelCollapsed(true)}
        menuVisibility={menuVisibility}
      >
        {renderContent()}
      </Shell>
      <Dialog />
      <AgentPicker
        token={token}
        open={agentPickerOpen}
        onClose={() => setAgentPickerOpen(false)}
        onSelect={(agent) => {
          startAgentSession(agent);
          void refreshAgents().catch(() => {});
        }}
      />
      <Modal
        open={rechargePromptOpen}
        onClose={() => setRechargePromptOpen(false)}
        className="w-[90vw] max-w-sm rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-2xl text-brand">
            ⚡
          </div>
          <h3 className="text-lg font-bold text-gray-900">余额不足</h3>
          <p className="mt-2 text-sm text-gray-500">当前算力点余额不足以发起本次对话，请充值算力点后重试。</p>
          <div className="mt-6 flex w-full gap-3">
            <button
              onClick={() => setRechargePromptOpen(false)}
              className="flex-1 rounded-full border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition-colors "
            >
              稍后再说
            </button>
            <button
              onClick={() => {
                setRechargePromptOpen(false);
                setView("billing");
              }}
              className="flex-1 rounded-full bg-brand py-2.5 text-sm font-medium text-white transition-opacity "
            >
              去充值
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
