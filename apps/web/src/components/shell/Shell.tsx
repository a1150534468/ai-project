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
  children,
}: ShellProps & { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(loadNavCollapsed);
  const reduceMotion = useReducedMotion();

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
    <div className="flex h-dvh min-h-0 overflow-hidden bg-[#f5f7fa]">
      <motion.aside
        animate={{ width: collapsed ? 56 : 240 }}
        transition={reduceMotion ? { duration: 0 } : spring.smooth}
        className="hidden flex-none flex-col overflow-hidden border-r border-gray-100 bg-white lg:flex"
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
        <nav className="border-b border-gray-100 bg-white px-4 py-3 lg:hidden">
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {NAV_ITEMS.flatMap((item) =>
              item.id === "workflow"
                ? WORKFLOW_SUB_ITEMS.filter((sub) => !sub.developing).map((sub) => {
                    const active = isWorkflowSubActive(currentView, workflowModule, sub);
                    return (
                      <button
                        key={`wf:${sub.id}`}
                        type="button"
                        onClick={() => handleWorkflowSubClick(sub.id)}
                        className={`inline-flex flex-none items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                          active
                            ? "border-brand bg-brand text-white"
                            : "border-[#d2d2d7] bg-[#f7faf9] text-[#6e6e73] hover:border-brand/40 hover:text-[#1d1d1f]"
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
                          : "border-[#d2d2d7] bg-[#f7faf9] text-[#6e6e73] hover:border-brand/40 hover:text-[#1d1d1f]"
                      }`}
                    >
                      <Icon icon={item.icon} className="text-sm" aria-hidden />
                      <span>{item.label}</span>
                    </button>,
                  ]
            )}
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
