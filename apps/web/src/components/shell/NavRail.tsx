import { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Icon } from "@iconify/react";
import { AnimatedNumber, BrandLogo, SpendBurst, spring, computeSpendBurst } from "../../motion";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../../workflowState";
import { HoverPopover } from "./HoverPopover";
import { WorkflowFlyout } from "./WorkflowFlyout";
import { isClientMenuVisible, type ClientMenuVisibility } from "../../clientMenu";

export type ViewType = "chat" | "models" | "kb" | "tool-market" | "workflow" | "video" | "digital-human" | "report" | "agent-teams" | "billing" | "memory" | "settings" | "wechat";

/** 工作流二级菜单项 id：模块 id 或独立的 AI 智能报告页 */
export type WorkflowSubId = WorkflowModuleId | "report";

export interface NavItem {
  id: ViewType;
  label: string;
  icon: string;
}

export interface WorkflowSubItem {
  id: WorkflowSubId;
  label: string;
  icon: string;
  developing: boolean;
}

const AI_REPORT_SUB_ITEM: WorkflowSubItem = {
  id: "report",
  label: "AI 智能报告",
  icon: "mdi:file-chart-outline",
  developing: false,
};

const WORKFLOW_MODULE_SUB_ITEMS: WorkflowSubItem[] = WORKFLOW_MODULES.map((m) => ({
  id: m.id,
  label: m.title,
  icon: m.icon,
  developing: m.status !== "available",
}));

/** AI 智能报告插入到模块列表正中间 */
export const WORKFLOW_SUB_ITEMS: WorkflowSubItem[] = [
  ...WORKFLOW_MODULE_SUB_ITEMS.slice(0, 3),
  AI_REPORT_SUB_ITEM,
  ...WORKFLOW_MODULE_SUB_ITEMS.slice(3),
];

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "对话", icon: "mdi:chat-outline" },
  { id: "models", label: "模型广场", icon: "mdi:storefront-outline" },
  { id: "kb", label: "知识库", icon: "mdi:database-search-outline" },
  { id: "tool-market", label: "工具市场", icon: "mdi:toolbox-outline" },
  { id: "workflow", label: "工作流", icon: "mdi:view-dashboard-outline" },
  { id: "video", label: "AI 视频", icon: "mdi:video-outline" },
  { id: "digital-human", label: "数字人口播", icon: "mdi:account-voice" },
  { id: "agent-teams", label: "Agent 团队", icon: "mdi:account-group-outline" },
  { id: "wechat", label: "微信接入", icon: "mdi:wechat" },
  { id: "memory", label: "记忆", icon: "mdi:table-heart" },
  { id: "settings", label: "设置", icon: "mdi:cog-outline" },
];

export function isWorkflowSubActive(
  currentView: ViewType,
  workflowModule: WorkflowModuleId | undefined,
  sub: WorkflowSubItem
): boolean {
  return currentView === "report"
    ? sub.id === "report"
    : currentView === "workflow" && sub.id === workflowModule;
}

interface NavRailProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  workflowModule?: WorkflowModuleId;
  onSelectWorkflowSub?: (id: WorkflowSubId) => void;
  balance?: number | null;
  onLogout?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  menuVisibility?: ClientMenuVisibility;
}

export function NavRail({
  currentView,
  onViewChange,
  workflowModule,
  onSelectWorkflowSub,
  balance = null,
  onLogout,
  collapsed = false,
  onToggleCollapsed,
  menuVisibility,
}: NavRailProps) {
  const reduce = useReducedMotion();

  // 工作流二级菜单展开态：进入工作流/报告页时自动展开
  const workflowGroupActive = currentView === "workflow" || currentView === "report";
  const [workflowOpen, setWorkflowOpen] = useState(workflowGroupActive);
  useEffect(() => {
    if (workflowGroupActive) setWorkflowOpen(true);
  }, [workflowGroupActive]);

  const handleWorkflowSubClick = (sub: WorkflowSubItem) => {
    if (sub.developing) return;
    onSelectWorkflowSub?.(sub.id);
  };
  const visibleNavItems = NAV_ITEMS.filter((item) =>
    isClientMenuVisible(menuVisibility, `nav.${item.id}`),
  );
  const visibleWorkflowSubItems = WORKFLOW_SUB_ITEMS.filter((sub) =>
    isClientMenuVisible(menuVisibility, `workflow.${sub.id}`),
  );

  // SpendBurst state
  const [burstActive, setBurstActive] = useState(false);
  const [burstAmount, setBurstAmount] = useState(0);
  const [burstOriginX, setBurstOriginX] = useState(0);
  const [burstOriginY, setBurstOriginY] = useState(0);
  const prevBalanceRef = useRef<number | null>(null);
  const balanceElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const amount = computeSpendBurst(prevBalanceRef.current, balance);
    if (amount !== null && balanceElementRef.current) {
      const rect = balanceElementRef.current.getBoundingClientRect();
      setBurstAmount(amount);
      setBurstOriginX(rect.left + rect.width / 2);
      setBurstOriginY(rect.top + rect.height / 2);
      setBurstActive(true);
      timer = setTimeout(() => setBurstActive(false), 1000);
    }
    // 无论是否触发，总是更新 ref（关键修复）
    prevBalanceRef.current = typeof balance === "number" ? balance : prevBalanceRef.current;
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [balance]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Brand */}
      <div className={`flex flex-none items-center border-b border-gray-100 transition-all ${
        collapsed ? "justify-center p-3" : "space-x-3 p-6"
      }`}>
        <BrandLogo size={40} />
        <AnimatePresence mode="wait">
          {!collapsed && (
            <motion.div
              key="brand-text"
              initial={reduce ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? undefined : { opacity: 0, x: -8 }}
              transition={{ duration: 0.2 }}
              className="flex-1"
            >
              <p className="font-bold leading-tight text-gray-900">AI 助手</p>
              <p className="text-xs text-gray-500">您的全能 AI 助手</p>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence mode="wait">
          {!collapsed && (
            <motion.button
              key="collapse-btn"
              type="button"
              onClick={onToggleCollapsed}
              initial={reduce ? false : { opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
              className="text-gray-400 hover:text-gray-600"
              aria-label="折叠侧边栏"
            >
              <Icon icon="mdi:chevron-double-left" className="text-base" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {visibleNavItems.map((item) => {
          if (item.id === "workflow") {
            // 工作流项
            const workflowFlyout = (
              <WorkflowFlyout
                items={visibleWorkflowSubItems}
                isActive={(sub) => isWorkflowSubActive(currentView, workflowModule, sub)}
                onSelect={handleWorkflowSubClick}
              />
            );
            return (
              <div key="workflow" className="space-y-0.5">
                <HoverPopover
                  disabled={!collapsed}
                  content={workflowFlyout}
                >
                  <button
                    onClick={() => {
                      if (!collapsed) {
                        setWorkflowOpen((open) => !open);
                      } else {
                        onViewChange("workflow");
                      }
                    }}
                    aria-expanded={workflowOpen}
                    className={`relative w-full flex items-center rounded-[10px] text-left transition-colors ${
                      collapsed ? "justify-center px-0 py-2.5" : "space-x-3 px-4 py-3"
                    } ${
                      workflowGroupActive
                        ? "text-gray-900 font-600"
                        : "text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    <Icon icon={item.icon} className="relative z-10 text-xl flex-none" />
                    {!collapsed && (
                      <>
                        <span className="relative z-10 flex-1 text-sm font-medium">{item.label}</span>
                        <Icon
                          icon="mdi:chevron-down"
                          className={`relative z-10 flex-none text-base text-gray-400 transition-transform ${
                            workflowOpen ? "" : "-rotate-90"
                          }`}
                          aria-hidden
                        />
                      </>
                    )}
                  </button>
                </HoverPopover>
                {workflowOpen && !collapsed && (
                  <motion.div
                    initial={reduce ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={reduce ? undefined : { height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="ml-4 space-y-0.5 border-l border-gray-100 pl-3">
                      {visibleWorkflowSubItems.map((sub, idx) => {
                        const active = isWorkflowSubActive(currentView, workflowModule, sub);
                        return (
                          <motion.button
                            key={sub.id}
                            type="button"
                            disabled={sub.developing}
                            onClick={() => handleWorkflowSubClick(sub)}
                            title={sub.label}
                            initial={reduce ? false : { opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: reduce ? 0 : idx * 0.035, duration: 0.16 }}
                            className={`relative w-full flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm transition-colors ${
                              active
                                ? "text-gray-900 font-semibold"
                                : sub.developing
                                  ? "cursor-not-allowed text-gray-300"
                                  : "text-gray-500 hover:bg-gray-50"
                            }`}
                          >
                            {active && (
                              <motion.div
                                layoutId="wf-sub-active"
                                className="absolute inset-0 rounded-[10px] bg-brand-soft"
                                style={{ zIndex: 0 }}
                                transition={spring.smooth}
                              />
                            )}
                            <Icon icon={sub.icon} className="relative z-10 flex-none text-lg" aria-hidden />
                            <span className="relative z-10 flex-1 truncate">{sub.label}</span>
                            {sub.developing && (
                              <span className="relative z-10 flex-none text-[10px] text-gray-300">开发中</span>
                            )}
                          </motion.button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </div>
            );
          }
          // 普通导航项
          const navLabel = item.label;
          return (
            <HoverPopover
              key={item.id}
              disabled={!collapsed}
              content={
                <div className="whitespace-nowrap rounded-md bg-gray-900 px-2.5 py-1.5 text-[11px] text-white shadow-lg">
                  {navLabel}
                </div>
              }
            >
              <button
                onClick={() => onViewChange(item.id)}
                className={`relative w-full flex items-center rounded-[10px] text-left transition-colors ${
                  collapsed ? "justify-center px-0 py-2.5" : "space-x-3 px-4 py-3"
                } ${
                  currentView === item.id
                    ? "text-gray-900 font-600"
                    : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {currentView === item.id && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-[10px] bg-brand-soft"
                    style={{ zIndex: 0 }}
                    transition={spring.smooth}
                  />
                )}
                <Icon icon={item.icon} className="relative z-10 flex-none text-xl" />
                {!collapsed && (
                  <span className="relative z-10 text-sm font-medium">{item.label}</span>
                )}
              </button>
            </HoverPopover>
          );
        })}

        {/* Expand Button (collapsed state) */}
        <AnimatePresence>
          {collapsed && (
            <motion.button
              key="expand-btn"
              type="button"
              onClick={onToggleCollapsed}
              initial={reduce ? false : { opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
              className="w-full flex justify-center py-2.5 text-gray-500 hover:text-gray-900 transition-colors"
              aria-label="展开侧边栏"
            >
              <Icon icon="mdi:chevron-double-right" className="text-base" />
            </motion.button>
          )}
        </AnimatePresence>
      </nav>

      {/* Bottom Card + Logout */}
      <div className="flex-none border-t border-gray-100">
        {/* Balance Card */}
        <HoverPopover
          disabled={!collapsed}
          content={
            <div className="whitespace-nowrap rounded-md bg-gray-900 px-2.5 py-1.5 text-[11px] text-white shadow-lg">
              {balance === null ? "同步中" : `${balance.toLocaleString("zh-CN")} 点 · 充值 ›`}
            </div>
          }
        >
          {collapsed ? (
            <button
              type="button"
              className="w-full flex justify-center py-3 text-gray-500 hover:text-gray-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
              onClick={() => onViewChange("billing")}
              aria-label="充值算力点"
            >
              <Icon icon="mdi:lightning-bolt-outline" className="text-lg" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="w-full p-4 text-left hover:bg-gray-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-inset"
              onClick={() => onViewChange("billing")}
              aria-label="充值算力点"
            >
              <div className="flex items-center space-x-3">
                <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand">
                  <Icon icon="mdi:lightning-bolt-outline" className="text-lg" aria-hidden />
                </div>
                <div className="flex-1 min-w-0">
                  <div ref={balanceElementRef} className="truncate text-sm font-medium text-gray-800">
                    {balance === null ? "同步中" : <><AnimatedNumber value={balance} /> 点</>}
                  </div>
                  <p className="text-xs text-gray-500">算力点</p>
                </div>
                <span className="flex-none text-xs font-medium text-brand">充值</span>
                <Icon icon="mdi:chevron-right" className="flex-none text-sm text-gray-300" aria-hidden />
              </div>
            </button>
          )}
        </HoverPopover>

        {/* SpendBurst particle effect */}
        <SpendBurst amount={burstAmount} originX={burstOriginX} originY={burstOriginY} active={burstActive} />

        {/* Logout Button */}
        <div className={`flex-none border-t border-gray-100 ${collapsed ? "flex justify-center py-3" : "p-4"}`}>
          <button
            onClick={onLogout}
            className={`text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
              collapsed ? "text-lg" : "w-full text-xs"
            }`}
            title={collapsed ? "登出" : undefined}
          >
            {collapsed ? (
              <Icon icon="mdi:exit-to-app" aria-hidden />
            ) : (
              "登出"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
