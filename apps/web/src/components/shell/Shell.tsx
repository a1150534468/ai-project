import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@iconify/react";
import type { AgentOption, Session } from "../../api";
import { isClientMenuVisible, isWorkflowSubVisible, type ClientMenuVisibility } from "../../clientMenu";
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
 * 这几个视图自己管滚动（对话流要吸底、记忆星系是整屏画布、小说编辑器分栏各自滚），
 * 外层再套一层滚动条就会出现双滚动条。其余页面交给外层滚。
 */
function ownsScrolling(view: ViewType, workflowModule?: WorkflowModuleId): boolean {
  if (view === "chat" || view === "memory") return true;
  return view === "workflow" && workflowModule === "novel";
}

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
  agentPanelCollapsed?: boolean;
  onRequestCollapseAgentPanel?: () => void;
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
  agentPanelCollapsed = false,
  onRequestCollapseAgentPanel,
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

  const pickSub = (id: WorkflowSubId) => {
    const sub = WORKFLOW_SUB_ITEMS.find((candidate) => candidate.id === id);
    if (!sub?.developing) onSelectWorkflowSub?.(id);
  };

  const items = NAV_ITEMS.filter((item) => isClientMenuVisible(menuVisibility, `nav.${item.id}`));
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
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          menuVisibility={menuVisibility}
        />
      </motion.aside>

      {currentView === "chat" && !agentPanelCollapsed && (
        <AgentRail
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
          onRequestCollapse={onRequestCollapseAgentPanel}
        />
      )}

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

        <div className={cx("min-h-0 flex-1", ownsScrolling(currentView, workflowModule) ? "overflow-hidden" : "overflow-y-auto")}>
          {children}
        </div>
      </main>
    </div>
  );
}

