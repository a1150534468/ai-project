/**
 * 应用外壳:登录闸门 + 视图分派。25 个 `useState` 按关注点拆进 `src/app/` 的五个 hook 之后,
 * 这里只剩三件事 ——「谁在登录」「现在看哪一页」「每一页要哪些 props」:
 *  - 登录态 / 账号信息 → `useAuthSession`
 *  - 视图 + 工作流子模块 + 跨页深链 + 后台菜单可见性 → `useClientNavigation`
 *  - 余额 + Agent 列表 → `useAccountOverview`
 *  - 会话记录 + 切换/删除/开新对话 → `useChatSessions`
 *  - 发送一轮对话(SSE 事件机) → `useChatStream`
 *
 * 视图切换仍然是 `ViewType` 字符串(本计划不引入 react-router),`renderContent` 的 13 个分支
 * 就是唯一的路由表。
 *
 * **hook 的调用顺序有意义**:`useAuthSession` 必须排第一 —— 它那个把 token 同步进 `http.ts`
 * 的 effect 要先于所有拉数据的 effect 执行,否则首屏那几个请求全都没有鉴权头。
 */
import { useCallback, useState } from "react";
import Shell, { type ViewType } from "./components/shell/Shell";
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
import { RechargePrompt } from "./app/RechargePrompt";
import { useAccountOverview } from "./app/useAccountOverview";
import { useAuthSession } from "./app/useAuthSession";
import { useChatSessions } from "./app/useChatSessions";
import { useChatStream } from "./app/useChatStream";
import { useClientNavigation } from "./app/useClientNavigation";

export default function App() {
  const { token, setToken, me, authView, setAuthView } = useAuthSession();
  const nav = useClientNavigation(token);
  const account = useAccountOverview(token);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [rechargePromptOpen, setRechargePromptOpen] = useState(false);
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
  const [preferredModel, setPreferredModel] = useState(() => localStorage.getItem("preferredModel") ?? "");
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("preferredModel") ?? "");
  const { confirm, Dialog } = useConfirm();
  const { setView } = nav;
  const { refreshAgents, refreshBalance, refreshBalanceQuietly, setBalance } = account;

  const handleOpenAgentPicker = useCallback(() => {
    setView("chat");
    setAgentPickerOpen(true);
  }, [setView]);

  const enterChat = useCallback(() => {
    setView("chat");
  }, [setView]);

  const handleAgentSessionStarted = useCallback(() => {
    setAgentPickerOpen(false);
    setAgentPanelCollapsed(true);
  }, []);

  const chat = useChatSessions({
    token,
    chatViewActive: nav.view === "chat",
    confirm,
    onEnterChat: enterChat,
    onAgentSessionStarted: handleAgentSessionStarted,
    onActiveSessionDeleted: handleOpenAgentPicker,
  });

  const handleChatSend = useChatStream({
    token,
    chat,
    onInsufficientBalance: () => setRechargePromptOpen(true),
    onSettled: refreshBalanceQuietly,
  });

  const { refreshSessions } = chat;
  const handleAgentsChanged = useCallback(async () => {
    await refreshAgents();
    await refreshSessions();
  }, [refreshAgents, refreshSessions]);

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

  const handleNewSessionForAgent = (agentId: string) => {
    const agent = [...account.agents.custom, ...account.agents.presets].find((a) => a.id === agentId);
    if (agent) chat.startAgentSession(agent);
  };

  const renderContent = () => {
    if (nav.view === "wechat") {
      return <WechatBind token={token} />;
    }

    if (nav.view === "memory") {
      return <Memory token={token} />;
    }

    if (nav.view === "settings") {
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

    if (nav.view === "models") {
      return <ModelMarketplace token={token} />;
    }

    if (nav.view === "billing") {
      return <Billing token={token} onBalanceChange={setBalance} />;
    }

    if (nav.view === "kb") {
      return (
        <Knowledge
          token={token}
          onViewChange={(v: string) => setView(v as ViewType)}
        />
      );
    }

    if (nav.view === "tool-market") {
      return <ToolMarket token={token} />;
    }

    if (nav.view === "workflow") {
      return (
        <Workflow
          token={token}
          activeModuleId={nav.workflowModule}
          menuVisibility={nav.menuVisibility}
          onBalanceRefresh={refreshBalance}
        />
      );
    }

    if (nav.view === "video") {
      return <Video token={token} onBalanceRefresh={refreshBalance} />;
    }

    if (nav.view === "digital-human") {
      return <DigitalHuman token={token} onBalanceRefresh={refreshBalance} />;
    }

    if (nav.view === "report") {
      return <Report token={token} onBalanceRefresh={refreshBalance} />;
    }

    if (nav.view === "agent-teams") {
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
        key={chat.activeSessionKey}
        token={token}
        sessionId={chat.sessionId}
        sessionTitle={chat.sessions.find((s) => s.id === chat.sessionId)?.title}
        agentName={chat.activeAgent?.name ?? "默认助手"}
        agentIcon={chat.activeAgent?.icon}
        agentAvatarSvg={chat.activeAgent?.avatarSvg ?? null}
        agentAvatarUrl={chat.activeAgent?.avatarUrl ?? null}
        messages={chat.messagesBySession[chat.activeSessionKey] ?? []}
        isLoading={chat.runningSessionIds.has(chat.activeSessionKey)}
        error={chat.errorsBySession[chat.activeSessionKey] ?? ""}
        citations={chat.citationsBySession[chat.activeSessionKey] ?? []}
        toolActivities={chat.toolActivitiesBySession[chat.activeSessionKey] ?? []}
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
        currentView={nav.view}
        onViewChange={setView}
        workflowModule={nav.workflowModule}
        onSelectWorkflowSub={nav.selectWorkflowSub}
        balance={account.balance}
        onLogout={() => setToken("")}
        token={token}
        agents={account.agents}
        sessions={chat.sessions}
        runningSessionIds={chat.runningSessionIds}
        currentSessionId={chat.sessionId}
        onSelectSession={chat.handleSelectSession}
        onNewSession={handleNewSessionForAgent}
        onDeleteSession={chat.handleDeleteSession}
        onOpenAgentPicker={handleOpenAgentPicker}
        onAgentsChanged={handleAgentsChanged}
        agentPanelCollapsed={agentPanelCollapsed}
        onRequestCollapseAgentPanel={() => setAgentPanelCollapsed(true)}
        menuVisibility={nav.menuVisibility}
      >
        {renderContent()}
      </Shell>
      <Dialog />
      <AgentPicker
        token={token}
        open={agentPickerOpen}
        onClose={() => setAgentPickerOpen(false)}
        onSelect={(agent) => {
          chat.startAgentSession(agent);
          void refreshAgents().catch(() => {});
        }}
      />
      <RechargePrompt
        open={rechargePromptOpen}
        onClose={() => setRechargePromptOpen(false)}
        onRecharge={() => {
          setRechargePromptOpen(false);
          setView("billing");
        }}
      />
    </>
  );
}
