import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { AgentOption, Session } from "../../api";
import { NavRail, NAV_ITEMS, WORKFLOW_SUB_ITEMS, isWorkflowSubActive } from "./NavRail";
import type { ViewType, WorkflowSubId } from "./NavRail";
import { AgentRail } from "./AgentRail";
import type { WorkflowModuleId } from "../../workflowState";
import { Icon } from "@iconify/react";
import { loadNavCollapsed, saveNavCollapsed } from "../../shellState";
import { spring } from "../../motion";
import { isClientMenuVisible, isWorkflowSubVisible, type ClientMenuVisibility } from "../../clientMenu";
import { ThemeToggle } from "../ThemeToggle";

export type { ViewType, WorkflowSubId } from "./NavRail";

interface ShellProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  workflowModule?: WorkflowModuleId;
  onSelectWorkflowSub?: (id: WorkflowSubId) => void;
  balance?: number | null;
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
}

export default function Shell({
  currentView,
  onViewChange,
  workflowModule,
  onSelectWorkflowSub,
  balance = null,
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
}: ShellProps & { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(loadNavCollapsed);
  const reduceMotion = useReducedMotion();
  const visibleNavItems = NAV_ITEMS.filter((item) =>
    isClientMenuVisible(menuVisibility, `nav.${item.id}`),
  );
  const visibleWorkflowSubItems = WORKFLOW_SUB_ITEMS.filter((sub) =>
    isWorkflowSubVisible(menuVisibility, sub.id),
  );

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      saveNavCollapsed(!prev);
      return !prev;
    });
  };

  const handleWorkflowSubClick = (id: WorkflowSubId) => {
    const sub = WORKFLOW_SUB_ITEMS.find((s) => s.id === id);
    if (sub && sub.developing) return;
    onSelectWorkflowSub?.(id);
  };

  return (
    <div className="apple-shell flex h-dvh min-h-0 overflow-hidden bg-[#f5f5f7]">
      <motion.aside
        animate={{ width: collapsed ? 56 : 240 }}
        transition={reduceMotion ? { duration: 0 } : spring.smooth}
        className="apple-sidebar hidden flex-none flex-col overflow-hidden border-r border-gray-100 bg-white lg:flex"
      >
        <NavRail
          currentView={currentView}
          onViewChange={onViewChange}
          workflowModule={workflowModule}
          onSelectWorkflowSub={onSelectWorkflowSub}
          balance={balance}
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

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <nav className="apple-mobile-nav border-b border-gray-100 bg-white px-3 py-2.5 lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleNavItems.flatMap((item) =>
              item.id === "workflow"
                ? visibleWorkflowSubItems.filter((sub) => !sub.developing).map((sub) => {
                    const active = isWorkflowSubActive(currentView, workflowModule, sub);
                    return (
                      <button
                        key={`wf:${sub.id}`}
                        type="button"
                        onClick={() => handleWorkflowSubClick(sub.id)}
                        className={`inline-flex flex-none items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                          active
                            ? "border-brand bg-brand text-white"
                            : "border-hairline bg-[#f7faf9] text-ink-secondary "
                        }`}
                      >
                        <Icon icon={sub.icon} className="text-sm" aria-hidden />
                        <span>{sub.label}</span>
                      </button>
                    );
                  })
                : [
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onViewChange(item.id)}
                      className={`inline-flex flex-none items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                        currentView === item.id
                          ? "border-brand bg-brand text-white"
                          : "border-hairline bg-[#f7faf9] text-ink-secondary "
                      }`}
                    >
                      <Icon icon={item.icon} className="text-sm" aria-hidden />
                      <span>{item.label}</span>
                    </button>,
                  ]
            )}
            </div>
            <ThemeToggle compact className="flex-none" />
          </div>
        </nav>

        {/* Content Area */}
        <div className={`flex-1 min-h-0 ${currentView === "chat" || currentView === "memory" || (currentView === "workflow" && workflowModule === "novel") ? "overflow-hidden" : "overflow-y-auto"}`}>
          {children}
        </div>
      </main>
    </div>
  );
}
