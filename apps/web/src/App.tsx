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
 * 几条顺序约定，动这个文件之前先读：
 *  - **所有 hook 都排在登录闸门之前。** 闸门是提前 return，hook 落到它后面就会随登录态时有时无。
 *  - **`useAuthSession` 必须是第一个 hook。** 它那个把 token 同步进 `http.ts` 的 effect 要先于
 *    所有拉数据的 effect 执行，否则首屏那几个请求全都没有鉴权头。
 *
 * 另外 `enteredApp` 这个 state 排在 `useClientNavigation` 之前：地址栏同步要不要生效由它决定
 * （落地页显示时不写 hash，见 useClientNavigation 的 `hashEnabled`）。
 *
 * 回调命名：带真逻辑的（异步、要找东西、要收窄类型）叫 `handleXxx`，单纯改一下本地状态的
 * 就用动词本身（`enterChat` / `closeAgentPicker` / `logout`）。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentOption } from "./api";
import Shell, { type ViewType } from "./components/shell/Shell";
import LoginModal from "./components/LoginModal";
import Landing from "./components/landing/Landing";
// 页面级懒加载：7 个页面各自成 chunk，切到哪页才下哪页。
// 首屏（落地页/对话页外壳）不再为工作流那 51% 的代码买单（见 check-bundle-size.mjs 的预算）。
const Chat = lazy(() => import("./pages/Chat"));
const Knowledge = lazy(() => import("./pages/Knowledge"));
const Assets = lazy(() => import("./pages/Assets"));
const Workflow = lazy(() => import("./pages/Workflow"));
const Memory = lazy(() => import("./pages/Memory"));
const Settings = lazy(() => import("./pages/Settings"));
const ModelMarketplace = lazy(() => import("./pages/ModelMarketplace"));
import { useConfirm } from "./components/ConfirmDialog";
import { AgentPicker } from "./components/AgentPicker";
import { useAccountOverview } from "./app/useAccountOverview";
import { useAuthSession } from "./app/useAuthSession";
import { useChatSessions } from "./app/useChatSessions";
import { useChatStream } from "./app/useChatStream";
import { useClientNavigation } from "./app/useClientNavigation";
import { AuthGateProvider } from "./app/authGate";
import { firstVisibleClientView } from "./clientMenu";
import { AUTH_TOKEN_STORAGE_KEY, setAuthErrorHandler } from "./http";
import { NAV_ITEMS } from "./components/shell/NavRail";
import { PageTransition, canAnimateTransitions } from "./motion/PageTransition";
import { AnimatePresence } from "motion/react";

/** 首选模型存在 localStorage 里。设置页也按这个键自己写了一遍，换键要两边一起改。 */
const PREFERRED_MODEL_KEY = "preferredModel";

/** 懒加载页面的骨架屏：用块面占位而不是转圈，转圈会让首屏看起来卡住。 */
function PageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-6 lg:px-6" aria-busy="true" aria-label="页面加载中">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-ink/10" />
      <div className="h-4 w-96 max-w-full animate-pulse rounded bg-ink/10" />
      <div className="mt-2 grid flex-1 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="animate-pulse rounded-2xl bg-ink/5" />
        <div className="animate-pulse rounded-2xl bg-ink/5" />
        <div className="animate-pulse rounded-2xl bg-ink/5" />
      </div>
    </div>
  );
}

/**
 * 「已进入应用」标记：未登录用户点过落地页「开始使用」后就不再回落地页。
 * **只活在内存里，不写 localStorage** —— token 是唯一能留在应用里的凭证：
 * 匿名进入只管当前这一趟页面会话，刷新/重开新标签页都先回营销落地页，
 * 登出更是直接打回落地页。`enteredApp` 是历史上的持久化键名，登出时清掉残留值。
 */
const ENTERED_APP_KEY = "enteredApp";

export default function App() {
  const { token, setToken, me, authView, setAuthView } = useAuthSession();
  /**
   * 未登录也先进应用外壳：点过「开始使用」后不再回落地页（仅当前页面会话，不持久化）。
   * 声明在 `useClientNavigation` 之前 —— 它要拿这个值判断「应用外壳是否在展示」，
   * 落地页显示时导航不接管地址栏，免得地址栏里挂着 `#chat`。
   */
  const [enteredApp, setEnteredApp] = useState(() => Boolean(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)));
  const nav = useClientNavigation(token, enteredApp || Boolean(token));
  const account = useAccountOverview(token);
  const { confirm, Dialog } = useConfirm();
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  /**
   * 对话列表滑入面板是否打开。默认**关**：它是覆盖层、不占文档流（原型 layout1「用完即走」），
   * 所以「收起」不再需要记状态 —— 关着就是常态，开一下、选完就关。
   */
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  /**
   * 「当前选中的模型」与「首选模型」在这里是同一个值 —— Chat 里换模型走的就是写 localStorage
   * 那条路，没有「只这一轮换个模型」的档位。原先用两个 state 存同一个值，任何一处漏改都会变成
   * 「设置页显示 A、对话页发 B」，所以合成一个，两个 prop 都从它出。
   */
  const [model, setModel] = useState(() => localStorage.getItem(PREFERRED_MODEL_KEY) ?? "");
  const [loginOpen, setLoginOpen] = useState(false);
  const { setView } = nav;
  const { refreshAgents } = account;

  const openLogin = useCallback(() => setLoginOpen(true), []);
  /** 鉴权闸：已登录放行；未登录弹登录框并拦下。动作 handler 顶部 `if (!requireAuth()) return;`。 */
  const requireAuth = useCallback(() => {
    if (token) return true;
    setLoginOpen(true);
    return false;
  }, [token]);
  /** 登录/注册成功：落 token（触发持久化 + 拉 me）并关弹窗。 */
  const handleAuthed = useCallback(
    (next: string) => {
      setToken(next);
      setLoginOpen(false);
    },
    [setToken],
  );
  const enterApp = useCallback(() => setEnteredApp(true), []);

  // token 带着却被判 401/403（过期/失效）：清登录态 + 弹登录框。匿名请求不带 token，不会触发（见 http.ts）。
  useEffect(() => {
    setAuthErrorHandler(() => {
      setToken("");
      setLoginOpen(true);
    });
    return () => setAuthErrorHandler(null);
  }, [setToken]);

  /**
   * 设置页路由守卫：未登录时不该看到设置页。导航入口已按登录态藏掉（clientMenu.isNavItemVisible），
   * 这里兜住手动改地址栏 / 旧 hash 直达的情况 —— 弹登录框说明「为什么要登录」，再跳去第一个可见页。
   * 落点同样排除「设置」，否则会和「当前页被后台隐藏」的回跳互相弹来弹去。
   */
  useEffect(() => {
    if (!token && nav.view === "settings") {
      setView(firstVisibleClientView(nav.menuVisibility, false));
      openLogin();
    }
  }, [token, nav.view, nav.menuVisibility, setView, openLogin]);

  const authGate = useMemo(() => ({ token, requireAuth, openLogin }), [token, requireAuth, openLogin]);

  const enterChat = useCallback(() => setView("chat"), [setView]);
  const closeAgentPicker = useCallback(() => setAgentPickerOpen(false), []);
  const closeAgentPanel = useCallback(() => setAgentPanelOpen(false), []);
  const toggleAgentPanel = useCallback(() => setAgentPanelOpen((open) => !open), []);
  /**
   * 登出 = 回到营销落地页。三件事一起做：
   *  - 清 token（持久化 effect 跟着把它从 localStorage 拿走）；
   *  - 清「已进入应用」标记（内存 + 历史遗留的持久化值），登录闸门重新落回 Landing；
   *  - 视图复位到对话页，下次「开始使用」从首页重新开始，不会把登出前那一页带回来。
   */
  const logout = useCallback(() => {
    setToken("");
    localStorage.removeItem(ENTERED_APP_KEY);
    setEnteredApp(false);
    setLoginOpen(false);
    setView("chat");
  }, [setToken, setView]);

  /** 挑 Agent 得先回对话页：从记忆页点「换 Agent」，挑完人还停在原地就看不到新开的对话。 */
  const openAgentPicker = useCallback(() => {
    // 新建/切换 Agent 要落到后端账号上，未登录先弹登录。
    if (!requireAuth()) return;
    setView("chat");
    setAgentPickerOpen(true);
  }, [requireAuth, setView]);

  /** 会话一开就把挑人面板关掉、对话列表收起来，宽度让给刚开的对话。 */
  const startedAgentSession = useCallback(() => {
    setAgentPickerOpen(false);
    setAgentPanelOpen(false);
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

  /** 发送是消耗型动作：未登录先弹登录框，不发请求（登录后让用户再点一次，草稿还在）。 */
  const guardedChatSend = useCallback(
    (payload: Parameters<typeof handleChatSend>[0]) => {
      if (!requireAuth()) return;
      handleChatSend(payload);
    },
    [requireAuth, handleChatSend],
  );

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

  /**
   * 转场方向：按侧栏顺序比新旧视图，往下切从下方进、往上切从上方进。
   * 用 ref 记「上一次的 view」而不是把方向算进 setView 里 —— 浏览器后退与地址栏直达都会
   * 绕开点击，那时候方向该由新旧两帧自己算出来，而不是由某个 onClick 单方面决定。
   * 首屏（没有上一次）记 0：不分方向，只做一次轻微的原地淡入。
   */
  const previousViewRef = useRef<ViewType | null>(null);
  const transitionDirection = useMemo<1 | -1 | 0>(() => {
    const previous = previousViewRef.current;
    if (previous === null || previous === nav.view) return 0;
    const previousIndex = NAV_ITEMS.findIndex((item) => item.id === previous);
    const nextIndex = NAV_ITEMS.findIndex((item) => item.id === nav.view);
    if (previousIndex < 0 || nextIndex < 0) return 0;
    return nextIndex > previousIndex ? 1 : -1;
  }, [nav.view]);
  useEffect(() => {
    previousViewRef.current = nav.view;
  }, [nav.view]);

  /**
   * 落地页闸门：没有 token 且没点过「开始使用」时，先看营销落地页而不是直接进应用。
   * 必须排在所有 hook 之后（和原来那道登录闸门同一条规则）。
   * 「开始使用」只在内存里放行（见 ENTERED_APP_KEY 注释）：匿名浏览不跨会话，
   * 所以直接访问 / 刷新 / 登出后重新进站，看到的都是这一页。
   */
  if (!enteredApp && !token) {
    return (
      <Landing
        onEnter={enterApp}
        onLogin={() => {
          enterApp();
          openLogin();
        }}
      />
    );
  }

  /**
   * 路由表。`token` 可能是空串（未登录浏览）—— 各页面都容忍空 token：跳过用户态拉取、
   * 渲染空态/预览，真正需要登录的动作处才弹登录框。`settings` 分支有上面的路由守卫兜底，
   * 未登录到不了这里。`default` 兜住 `chat` 和任何认不出来的值 —— 深链是地址栏里读回来的
   * 字符串，认不出来时落到对话页，而不是白屏。
   */
  const renderContent = (): ReactNode => {
    switch (nav.view) {
      case "memory":
        return <Memory token={token} />;
      case "models":
        return <ModelMarketplace />;
      case "assets":
        return <Assets token={token} onCreate={() => setView("workflow")} />;
      case "kb":
        return <Knowledge token={token} onViewChange={handleKnowledgeViewChange} />;
      case "workflow":
        return <Workflow token={token} activeModuleId={nav.workflowModule} menuVisibility={nav.menuVisibility} onSelectModule={nav.selectWorkflowSub} />;
      case "settings":
        return (
          <Settings
            uid={me?.uid}
            userName={me?.username}
            authed={Boolean(token)}
            onLogin={openLogin}
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
            onSend={guardedChatSend}
            agentPanelOpen={agentPanelOpen}
            onToggleAgentPanel={toggleAgentPanel}
          />
        );
      }
    }
  };

  return (
    <AuthGateProvider value={authGate}>
      <Shell
        currentView={nav.view}
        onViewChange={setView}
        workflowModule={nav.workflowModule}
        onSelectWorkflowSub={nav.selectWorkflowSub}
        onLogout={logout}
        onLogin={openLogin}
        authed={Boolean(token)}
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
        agentPanelOpen={agentPanelOpen}
        onRequestCloseAgentPanel={closeAgentPanel}
        menuVisibility={nav.menuVisibility}
      >
        {/* key = 当前视图：换视图就是换子树，旧的才会走 exit、新的才会从 initial 起步。
              少了 key 或少了 AnimatePresence，两者都不播 —— 转场就成了「只改字的硬切」。
              没有帧循环的环境（jsdom）不包：exit 永远等不到完成，旧视图会一直留在 DOM 里，
              于是「切到 B 页」会被断言成「A 和 B 都在」。 */}
        {canAnimateTransitions ? (
          <AnimatePresence mode="wait" initial={false}>
            <PageTransition key={nav.view} direction={transitionDirection} className="flex min-h-0 flex-1 flex-col">
              <Suspense fallback={<PageSkeleton />}>{renderContent()}</Suspense>
            </PageTransition>
          </AnimatePresence>
        ) : (
          <PageTransition key={nav.view} direction={transitionDirection} className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<PageSkeleton />}>{renderContent()}</Suspense>
          </PageTransition>
        )}
      </Shell>
      <Dialog />
      <AgentPicker token={token} open={agentPickerOpen} onClose={closeAgentPicker} onSelect={handlePickAgent} />
      <LoginModal
        open={loginOpen}
        view={authView}
        onViewChange={setAuthView}
        onAuthed={handleAuthed}
        onClose={() => setLoginOpen(false)}
      />
    </AuthGateProvider>
  );
}
