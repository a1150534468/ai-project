import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Icon } from "@iconify/react";
import type { AgentOption, Session } from "../../api";
import { isNavItemVisible, isWorkflowSubVisible, type ClientMenuVisibility } from "../../clientMenu";
import { spring } from "../../motion";
import { loadNavCollapsed, saveNavCollapsed } from "../../shellState";
import type { WorkflowModuleId } from "../../workflowState";
import { cx } from "../ui";
import { ThemeToggle } from "../ThemeToggle";
import { AgentRail } from "./AgentRail";
import { NAV_ITEMS, NavRail, WORKFLOW_SUB_ITEMS, isWorkflowSubActive } from "./NavRail";
import type { ViewType, WorkflowSubId } from "./NavRail";

export type { ViewType, WorkflowSubId } from "./NavRail";

/** 侧边栏两档宽度：折叠到只剩图标 / 展开到能放下文案 */
const RAIL_COLLAPSED_PX = 56;
const RAIL_EXPANDED_PX = 240;

const CHIP =
  "inline-flex flex-none items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";
const CHIP_ON = "border-brand bg-brand text-white";
const CHIP_OFF = "border-hairline bg-surface-subtle text-ink-secondary";

/**
 * 内容区的那一槽由谁滚。三种：
 *   - `page`：整屏自己滚（对话流要吸底、记忆星系是整屏画布、小说工作台分栏各自滚），
 *     外层再套一层滚动条就会出现双滚动条，所以内容是裁掉的；
 *   - `page-wide`：**宽屏自己滚、窄屏整页滚** —— 工作流三区模块（生图 / 图文 / 桌宠）：
 *     三栏各自滚是宽屏才有的形态，窄屏三区纵向堆叠、还得靠整页滚；
 *   - `shell`：页面比视口高就整页滚（其余页面）。
 *
 * ❗前两种的内容槽都必须是 **flex 列**（`flex flex-col`）。页面里那些 `flex-1 / h-full / min-h-0`
 * 只有在父级高度**确定**时才生效；这里曾经只有 `min-h-0 flex-1`（display 仍是 block），
 * 于是工作流三区外壳的 `xl:h-full` 一路解析成 `auto` ⇒ 栅格的行被最高的一栏（设置）撑开
 * ⇒ 三张卡一起长到两千多像素，工作区明明只有一张占位图，底边还被裁掉。
 * 症状是「工作台的高度跟着设置栏走」，根因却在这个外壳槽里 —— 别再从 studio 那边找了。
 */
type ContentScroll = "page" | "page-wide" | "shell";

/** 宽屏要「内容槽给确定高度、页面自己排」的模块：三区模块（生图 / 图文 / 桌宠）+ 单栏的录音转文字。 */
const FULL_HEIGHT_MODULES: ReadonlySet<WorkflowModuleId> = new Set<WorkflowModuleId>([
  "image",
  "article-workflow",
  "codex-pet",
  // 录音转文字不是三区，但它的根元素同样是 `flex min-h-0 flex-1 flex-col`：
  // 父级高度不确定就塌成内容高，页面下半截空着
  "transcription",
]);

function contentScroll(view: ViewType, workflowModule?: WorkflowModuleId): ContentScroll {
  if (view === "chat" || view === "memory") return "page";
  if (view !== "workflow") return "shell";
  if (workflowModule === "novel") return "page";
  return workflowModule !== undefined && FULL_HEIGHT_MODULES.has(workflowModule) ? "page-wide" : "shell";
}

const CONTENT_SCROLL_CLASS: Readonly<Record<ContentScroll, string>> = {
  page: "flex flex-col overflow-hidden",
  "page-wide": "flex flex-col overflow-y-auto xl:overflow-hidden",
  shell: "overflow-y-auto",
};

/** 移动端顶部那排胶囊。一级导航项与工作流子项在这里摊平成同一种东西。 */
interface NavChip {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly active: boolean;
  readonly onPick: () => void;
}
interface ShellProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  workflowModule?: WorkflowModuleId;
  onSelectWorkflowSub?: (id: WorkflowSubId) => void;
  onLogout?: () => void;
  /** 未登录时侧栏/移动端显示「登录」入口，点它弹登录框。 */
  onLogin?: () => void;
  /** 是否已登录：决定页脚显示「登出」还是「登录」。 */
  authed?: boolean;
  token: string;
  agents: { presets: AgentOption[]; custom: AgentOption[] };
  sessions?: Session[];
  currentSessionId?: string;
  onSelectSession?: (id: string) => void;
  onNewSession?: (agentId: string) => void;
  onDeleteSession?: (id: string) => void;
  runningSessionIds?: Set<string>;
  onOpenAgentPicker: () => void;
  onAgentsChanged: () => void;
  /** 对话列表滑入面板是否打开。默认关着 —— 它不占文档流，用完即走 */
  agentPanelOpen?: boolean;
  onRequestCloseAgentPanel?: () => void;
  menuVisibility?: ClientMenuVisibility;
  children: ReactNode;
}

/**
 * 三栏骨架：一级导航（lg 以上）+ 对话页专属的 Agent 栏 + 内容区。
 * 窄屏没有左栏，一级导航改成内容区顶上的一排横向胶囊。
 */
export default function Shell({
  currentView,
  onViewChange,
  workflowModule,
  onSelectWorkflowSub,
  onLogout,
  onLogin,
  authed = true,
  token,
  agents,
  sessions = [],
  currentSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  runningSessionIds = new Set(),
  onOpenAgentPicker,
  onAgentsChanged,
  agentPanelOpen = false,
  onRequestCloseAgentPanel,
  menuVisibility,
  children,
}: ShellProps) {
  const reduce = useReducedMotion() ?? false;
  const [collapsed, setCollapsed] = useState(loadNavCollapsed);

  // 折叠态要跨会话记住：宽屏用户多半一直折叠着用
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      saveNavCollapsed(!prev);
      return !prev;
    });
  };

  /**
   * 滑入面板开着时 Esc 关掉它。遮罩那一层已经能接点击，但键盘用户没有「点遮罩」这个动作 ——
   * 不接 Esc，他们只能靠 Tab 绕回那颗开关。监听挂在 window 上而不是面板上：
   * 焦点此时在面板里的搜索框 / 列表项上，事件会冒泡到 window，照样收得到。
   */
  useEffect(() => {
    if (!agentPanelOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onRequestCloseAgentPanel?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [agentPanelOpen, onRequestCloseAgentPanel]);

  const pickSub = (id: WorkflowSubId) => {
    const sub = WORKFLOW_SUB_ITEMS.find((candidate) => candidate.id === id);
    if (!sub?.developing) onSelectWorkflowSub?.(id);
  };

  // 与 NavRail 同一套可见性规则：后台开关 ∩ 登录态（「设置」未登录时不出现）
  const items = NAV_ITEMS.filter((item) => isNavItemVisible(menuVisibility, item.id, authed));
  const subItems = WORKFLOW_SUB_ITEMS.filter((sub) => isWorkflowSubVisible(menuVisibility, sub.id));

  // 「工作流」在窄屏没有二级菜单可展，所以把可用的子模块直接铺成同级胶囊
  const chips: NavChip[] = items.flatMap((item) =>
    item.id === "workflow"
      ? subItems
          .filter((sub) => !sub.developing)
          .map((sub) => ({
            key: `wf:${sub.id}`,
            label: sub.label,
            icon: sub.icon,
            active: isWorkflowSubActive(currentView, workflowModule, sub),
            onPick: () => pickSub(sub.id),
          }))
      : [
          {
            key: item.id,
            label: item.label,
            icon: item.icon,
            active: currentView === item.id,
            onPick: () => onViewChange(item.id),
          },
        ],
  );
  return (
    <div className="apple-shell flex h-dvh min-h-0 overflow-hidden bg-surface-muted">
      <motion.aside
        animate={{ width: collapsed ? RAIL_COLLAPSED_PX : RAIL_EXPANDED_PX }}
        transition={reduce ? { duration: 0 } : spring.smooth}
        className="apple-sidebar hidden flex-none flex-col overflow-hidden border-r border-hairline-subtle bg-surface lg:flex"
      >
        <NavRail
          currentView={currentView}
          onViewChange={onViewChange}
          workflowModule={workflowModule}
          onSelectWorkflowSub={onSelectWorkflowSub}
          onLogout={onLogout}
          onLogin={onLogin}
          authed={authed}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          menuVisibility={menuVisibility}
        />
      </motion.aside>

      {/* 对话列表是**滑入面板**而不是常驻第二栏（原型 layout1）：不占文档流，宽度全还给对话流。
          遮罩与面板一起进 AnimatePresence —— 少了它，面板退场时遮罩会先一步消失，中间闪一下空背景。 */}
      <AnimatePresence>
        {currentView === "chat" && agentPanelOpen && (
          <>
            <motion.div
              key="agent-panel-scrim"
              aria-hidden
              onClick={onRequestCloseAgentPanel}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.2 }}
              className="fixed inset-0 z-40 bg-scrim/25"
            />
            <AgentRail
              key="agent-panel"
              token={token}
              agents={agents}
              sessions={sessions}
              currentSessionId={currentSessionId}
              runningSessionIds={runningSessionIds}
              onSelectSession={onSelectSession}
              onNewSession={onNewSession}
              onDeleteSession={onDeleteSession}
              onOpenAgentPicker={onOpenAgentPicker}
              onAgentsChanged={onAgentsChanged}
              onRequestClose={onRequestCloseAgentPanel}
            />
          </>
        )}
      </AnimatePresence>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <nav className="apple-mobile-nav border-b border-hairline-subtle bg-surface px-3 py-2.5 lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            {/* 胶囊横向溢出就滑动，滚动条藏掉：这排东西的高度不该被滚动条撑起来 */}
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {chips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onPick}
                  aria-current={chip.active ? "page" : undefined}
                  className={cx(CHIP, chip.active ? CHIP_ON : CHIP_OFF)}
                >
                  <Icon icon={chip.icon} className="text-sm" aria-hidden />
                  <span>{chip.label}</span>
                </button>
              ))}
            </div>
            <ThemeToggle compact className="flex-none" />
          </div>
        </nav>

        <div className={cx("min-h-0 flex-1", CONTENT_SCROLL_CLASS[contentScroll(currentView, workflowModule)])}>
          {children}
        </div>
      </main>
    </div>
  );
}
