/**
 * 应用外壳：登录闸门 + 视图分派。25 个 `useState` 按关注点拆进 `src/app/` 的五个 hook 之后，
 * 这里只剩三件事 ——「谁在登录」「现在看哪一页」「每一页要哪些 props」：
 *  - 登录态 / 账号信息 → `useAuthSession`
 *  - 视图 + 工作流子模块 + 跨页深链 + 后台菜单可见性 → `useClientNavigation`
 *  - Agent 列表 → `useAccountOverview`
 *  - 会话记录 + 切换/删除/开新对话 → `useChatSessions`
 *  - 发送一轮对话（SSE 事件机）→ `useChatStream`
 *
 * 视图切换仍然是 `ViewType` 字符串（本计划不引入 react-router），`renderContent` 里那个 switch
 * 就是唯一的路由表。
 *
 * 两条顺序约定，动这个文件之前先读：
 *  - **所有 hook 都排在登录闸门之前。** 闸门是提前 return，hook 落到它后面就会随登录态时有时无。
 *  - **`useAuthSession` 必须是第一个 hook。** 它那个把 token 同步进 `http.ts` 的 effect 要先于
 *    所有拉数据的 effect 执行，否则首屏那几个请求全都没有鉴权头。
 *
 * 回调命名：带真逻辑的（异步、要找东西、要收窄类型）叫 `handleXxx`，单纯改一下本地状态的
 * 就用动词本身（`enterChat` / `closeAgentPicker` / `logout`）。
 */
import { useCallback, useState, type ReactNode } from "react";
import type { AgentOption } from "./api";
import Shell, { type ViewType } from "./components/shell/Shell";
import Login from "./components/Login";
import Register from "./components/Register";
import Chat from "./pages/Chat";
import Knowledge from "./pages/Knowledge";
import Assets from "./pages/Assets";
import Workflow from "./pages/Workflow";
import Memory from "./pages/Memory";
import Settings from "./pages/Settings";
import ModelMarketplace from "./pages/ModelMarketplace";
import { useConfirm } from "./components/ConfirmDialog";
import { AgentPicker } from "./components/AgentPicker";
import { useAccountOverview } from "./app/useAccountOverview";
import { useAuthSession } from "./app/useAuthSession";
import { useChatSessions } from "./app/useChatSessions";
import { useChatStream } from "./app/useChatStream";
import { useClientNavigation } from "./app/useClientNavigation";

/** 首选模型存在 localStorage 里。设置页也按这个键自己写了一遍，换键要两边一起改。 */
const PREFERRED_MODEL_KEY = "preferredModel";

export default function App() {
  const { token, setToken, me, authView, setAuthView } = useAuthSession();
  const nav = useClientNavigation(token);
  const account = useAccountOverview(token);
  const { confirm, Dialog } = useConfirm();
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
  /**
   * 「当前选中的模型」与「首选模型」在这里是同一个值 —— Chat 里换模型走的就是写 localStorage
   * 那条路，没有「只这一轮换个模型」的档位。原先用两个 state 存同一个值，任何一处漏改都会变成
   * 「设置页显示 A、对话页发 B」，所以合成一个，两个 prop 都从它出。
   */
  const [model, setModel] = useState(() => localStorage.getItem(PREFERRED_MODEL_KEY) ?? "");
  const { setView } = nav;
  const { refreshAgents } = account;

  const enterChat = useCallback(() => setView("chat"), [setView]);
  const closeAgentPicker = useCallback(() => setAgentPickerOpen(false), []);
  const collapseAgentPanel = useCallback(() => setAgentPanelCollapsed(true), []);
  const toggleAgentPanel = useCallback(() => setAgentPanelCollapsed((collapsed) => !collapsed), []);
  const logout = useCallback(() => setToken(""), [setToken]);

  /** 挑 Agent 得先回对话页：从记忆页点「换 Agent」，挑完人还停在原地就看不到新开的对话。 */
  const openAgentPicker = useCallback(() => {
    setView("chat");
    setAgentPickerOpen(true);
  }, [setView]);

  /** 会话一开就把挑人面板关掉、Agent 栏收起来，宽度让给刚开的对话。 */
  const startedAgentSession = useCallback(() => {
    setAgentPickerOpen(false);
    setAgentPanelCollapsed(true);
  }, []);

  const chat = useChatSessions({
    token,
    chatViewActive: nav.view === "chat",
    confirm,
    onEnterChat: enterChat,
    onAgentSessionStarted: startedAgentSession,
    onActiveSessionDeleted: openAgentPicker,
  });

  const handleChatSend = useChatStream({ token, chat });

  const { refreshSessions, startAgentSession } = chat;

  /** 改过 Agent（新建 / 删除 / 改名）之后两份数据都得重拉：会话卡片上挂着 Agent 的名字和头像。 */
  const handleAgentsChanged = useCallback(async () => {
    await refreshAgents();
    await refreshSessions();
  }, [refreshAgents, refreshSessions]);

  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    localStorage.setItem(PREFERRED_MODEL_KEY, next);
  }, []);

  /** 侧栏「开新对话」只给 agentId。自建的先找 —— 与侧栏的显示顺序一致，同 id 时取上面那个。 */
  const handleNewSessionForAgent = useCallback(
    (agentId: string) => {
      const { custom, presets } = account.agents;
      const agent = custom.find((option) => option.id === agentId) ?? presets.find((option) => option.id === agentId);

      if (agent) startAgentSession(agent);
    },
    [account.agents, startAgentSession],
  );

  const handlePickAgent = useCallback(
    (agent: AgentOption) => {
      startAgentSession(agent);
      // 顺手刷一次列表：预置 Agent 第一次用会在后端落成一条自建记录。刷不动就算了，别挡着开会话
      void refreshAgents().catch(() => {});
    },
    [refreshAgents, startAgentSession],
  );

  /** 知识库那侧的 `onViewChange` 收的是宽 `string`，跨页深链的目标在这里收窄回 `ViewType`。 */
  const handleKnowledgeViewChange = useCallback((view: string) => setView(view as ViewType), [setView]);

  if (!token) {
    return authView === "register" ? (
      <Register onAuthed={setToken} onSwitchToLogin={() => setAuthView("login")} />
    ) : (
      <Login onLogin={setToken} onSwitchToRegister={() => setAuthView("register")} />
    );
  }

  /**
   * 路由表。写在闸门之后有两个原因：`token` 到这里才收窄成非空串，而且它不是 hook，
   * 不受调用顺序约束。`default` 兜住 `chat` 和任何认不出来的值 —— 深链是从 localStorage
   * 读回来的字符串，认不出来时落到对话页，而不是白屏。
   */
  const renderContent = (): ReactNode => {
    switch (nav.view) {
      case "memory":
        return <Memory token={token} />;
      case "models":
        return <ModelMarketplace />;
      case "assets":
        return <Assets token={token} />;
      case "kb":
        return <Knowledge token={token} onViewChange={handleKnowledgeViewChange} />;
      case "workflow":
        return <Workflow token={token} activeModuleId={nav.workflowModule} menuVisibility={nav.menuVisibility} />;
      case "settings":
        return (
          <Settings
            uid={me?.uid}
            userName={me?.username}
            preferredModel={model}
            onPreferredModelChange={handleModelChange}
            onLogout={logout}
          />
        );
      default: {
        // 四份 per-session 映射都按同一个 key 取，且都要兜底：会话刚建出来时映射里还没有它
        const key = chat.activeSessionKey;
        const agent = chat.activeAgent;

        return (
          <Chat
            key={key}
            token={token}
            sessionId={chat.sessionId}
            sessionTitle={chat.sessions.find((session) => session.id === chat.sessionId)?.title}
            agentName={agent?.name ?? "默认助手"}
            agentIcon={agent?.icon}
            agentAvatarSvg={agent?.avatarSvg ?? null}
            agentAvatarUrl={agent?.avatarUrl ?? null}
            messages={chat.messagesBySession[key] ?? []}
            isLoading={chat.runningSessionIds.has(key)}
            error={chat.errorsBySession[key] ?? ""}
            citations={chat.citationsBySession[key] ?? []}
            selectedModel={model}
            preferredModel={model}
            onModelChange={handleModelChange}
            onSend={handleChatSend}
            agentPanelCollapsed={agentPanelCollapsed}
            onToggleAgentPanel={toggleAgentPanel}
          />
        );
      }
    }
  };

  return (
    <>
      <Shell
        currentView={nav.view}
        onViewChange={setView}
        workflowModule={nav.workflowModule}
        onSelectWorkflowSub={nav.selectWorkflowSub}
        onLogout={logout}
        token={token}
        agents={account.agents}
        sessions={chat.sessions}
        runningSessionIds={chat.runningSessionIds}
        currentSessionId={chat.sessionId}
        onSelectSession={chat.handleSelectSession}
        onNewSession={handleNewSessionForAgent}
        onDeleteSession={chat.handleDeleteSession}
        onOpenAgentPicker={openAgentPicker}
        onAgentsChanged={handleAgentsChanged}
        agentPanelCollapsed={agentPanelCollapsed}
        onRequestCollapseAgentPanel={collapseAgentPanel}
        menuVisibility={nav.menuVisibility}
      >
        {renderContent()}
      </Shell>
      <Dialog />
      <AgentPicker token={token} open={agentPickerOpen} onClose={closeAgentPicker} onSelect={handlePickAgent} />
    </>
  );
}
