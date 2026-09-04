import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Icon } from "@iconify/react";
import { BrandLogo, spring } from "../../motion";
import { cx } from "../ui";
import { isClientMenuVisible, isWorkflowSubVisible, type ClientMenuVisibility } from "../../clientMenu";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../../workflowState";
import { ThemeToggle } from "../ThemeToggle";
import { HoverPopover } from "./HoverPopover";
import { WorkflowFlyout } from "./WorkflowFlyout";

export type ViewType = "chat" | "models" | "kb" | "assets" | "workflow" | "memory" | "settings";

/** 工作流二级菜单项 id */
export type WorkflowSubId = WorkflowModuleId;

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

/** 二级菜单由工作流模块表派生 —— 那张表是唯一的模块清单，导航不另存一份。 */
export const WORKFLOW_SUB_ITEMS: WorkflowSubItem[] = WORKFLOW_MODULES.map((module) => ({
  id: module.id,
  label: module.title,
  icon: module.icon,
  developing: module.status !== "available",
}));

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "对话", icon: "mdi:chat-outline" },
  { id: "models", label: "模型广场", icon: "mdi:storefront-outline" },
  { id: "kb", label: "知识库", icon: "mdi:database-search-outline" },
  // 紧挨着知识库：知识归知识库、工作流产物归素材库，这条界限在导航上要看得见。
  { id: "assets", label: "素材库", icon: "mdi:folder-multiple-image" },
  { id: "workflow", label: "工作流", icon: "mdi:view-dashboard-outline" },
  { id: "memory", label: "记忆", icon: "mdi:table-heart" },
  { id: "settings", label: "设置", icon: "mdi:cog-outline" },
];

export function isWorkflowSubActive(
  currentView: ViewType,
  workflowModule: WorkflowModuleId | undefined,
  sub: WorkflowSubItem,
): boolean {
  return currentView === "workflow" && sub.id === workflowModule;
}
const ROW = "relative flex w-full items-center rounded-[10px] text-left transition-colors";
const SUB_ROW = "relative flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm transition-colors";
/** 图标与文案都要压在选中底色之上，z-10 是它们和 ActivePill 的分层约定 */
const OVER_PILL = "relative z-10 flex-none";
const TIP = "whitespace-nowrap rounded-md bg-surface-inverse px-2.5 py-1.5 text-[11px] text-ink-inverse shadow-lg";

/** 二级菜单项逐个淡入的间隔 */
const SUB_STAGGER_S = 0.035;
const EXPAND_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** 折叠态只剩一个居中图标，展开态才排图标 + 文案 */
const rowShape = (collapsed: boolean) => (collapsed ? "justify-center px-0 py-2.5" : "space-x-3 px-4 py-3");

/** 选中态的底色块。共享 layoutId 让它在两项之间滑过去，而不是一边消失一边冒出来。 */
function ActivePill({ id }: { readonly id: string }) {
  return (
    <motion.div
      layoutId={id}
      className="absolute inset-0 rounded-[10px] bg-brand-soft"
      style={{ zIndex: 0 }}
      transition={spring.smooth}
    />
  );
}

/** 折叠时整块淡出。x 位移方向由调用方给，图标那一列不动、文字那一列往左收。 */
function slideFade(reduce: boolean, dx: number) {
  if (reduce) return {};
  return {
    initial: { opacity: 0, x: dx },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: dx },
    transition: { duration: 0.2 },
  };
}

/** 折叠/展开按钮的缩放淡入 */
function popFade(reduce: boolean) {
  if (reduce) return {};
  return {
    initial: { opacity: 0, scale: 0.8 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.8 },
    transition: { duration: 0.2 },
  };
}
/** 一级导航项。折叠态下靠 hover 浮层补出文案，否则只剩一个图标认不出是什么。 */
function NavButton({
  item,
  active,
  collapsed,
  onPick,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly onPick: () => void;
}) {
  return (
    <HoverPopover disabled={!collapsed} content={<div className={TIP}>{item.label}</div>}>
      <button
        type="button"
        onClick={onPick}
        aria-current={active ? "page" : undefined}
        className={cx(ROW, rowShape(collapsed), active ? "text-ink" : "text-ink-secondary")}
      >
        {active && <ActivePill id="nav-active" />}
        <Icon icon={item.icon} className={cx(OVER_PILL, "text-xl")} />
        {!collapsed && <span className="relative z-10 text-sm font-medium">{item.label}</span>}
      </button>
    </HoverPopover>
  );
}

/** 二级菜单项：当前页 → 开发中（点不动）→ 普通，三种模样互斥。 */
function subTone(active: boolean, developing: boolean): string {
  if (active) return "text-ink font-semibold";
  if (developing) return "cursor-not-allowed text-ink-tertiary";
  return "text-ink-secondary";
}

function SubNavButton({
  sub,
  active,
  order,
  reduce,
  onPick,
}: {
  readonly sub: WorkflowSubItem;
  readonly active: boolean;
  readonly order: number;
  readonly reduce: boolean;
  readonly onPick: () => void;
}) {
  return (
    <motion.button
      type="button"
      disabled={sub.developing}
      onClick={onPick}
      title={sub.label}
      initial={reduce ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: reduce ? 0 : order * SUB_STAGGER_S, duration: 0.16 }}
      className={cx(SUB_ROW, subTone(active, sub.developing))}
    >
      {active && <ActivePill id="wf-sub-active" />}
      <Icon icon={sub.icon} className={cx(OVER_PILL, "text-lg")} aria-hidden />
      <span className="relative z-10 flex-1 truncate">{sub.label}</span>
      {sub.developing && <span className="relative z-10 flex-none text-[10px] text-ink-tertiary">开发中</span>}
    </motion.button>
  );
}
interface WorkflowGroupProps {
  readonly item: NavItem;
  readonly subItems: WorkflowSubItem[];
  readonly collapsed: boolean;
  readonly onWorkflowPage: boolean;
  readonly open: boolean;
  readonly reduce: boolean;
  readonly isActive: (sub: WorkflowSubItem) => boolean;
  /** 展开态点标题：只开合二级菜单，不跳页 */
  readonly onToggle: () => void;
  /** 折叠态点标题：没有二级菜单可展，直接进工作流页 */
  readonly onOpenWorkflow: () => void;
  readonly onPickSub: (sub: WorkflowSubItem) => void;
}

/**
 * 「工作流」这一项自带二级菜单，所以不走 NavButton：
 * 展开态把子项撑开在下面，折叠态改成 hover 浮层（宽度只剩 56px，撑不开）。
 */
function WorkflowGroup({
  item,
  subItems,
  collapsed,
  onWorkflowPage,
  open,
  reduce,
  isActive,
  onToggle,
  onOpenWorkflow,
  onPickSub,
}: WorkflowGroupProps) {
  return (
    <div className="space-y-0.5">
      <HoverPopover
        disabled={!collapsed}
        content={<WorkflowFlyout items={subItems} isActive={isActive} onSelect={onPickSub} />}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={collapsed ? onOpenWorkflow : onToggle}
          className={cx(ROW, rowShape(collapsed), onWorkflowPage ? "text-ink" : "text-ink-secondary")}
        >
          <Icon icon={item.icon} className={cx(OVER_PILL, "text-xl")} />
          {!collapsed && (
            <>
              <span className="relative z-10 flex-1 text-sm font-medium">{item.label}</span>
              <Icon
                icon="mdi:chevron-down"
                className={cx(OVER_PILL, "text-base text-ink-tertiary transition-transform", !open && "-rotate-90")}
                aria-hidden
              />
            </>
          )}
        </button>
      </HoverPopover>

      {open && !collapsed && (
        <motion.div
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduce ? undefined : { height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: EXPAND_EASE }}
          className="overflow-hidden"
        >
          <div className="ml-4 space-y-0.5 border-l border-hairline-subtle pl-3">
            {subItems.map((sub, order) => (
              <SubNavButton
                key={sub.id}
                sub={sub}
                active={isActive(sub)}
                order={order}
                reduce={reduce}
                onPick={() => onPickSub(sub)}
              />
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
/** 顶部品牌区。折叠时只留 logo，文案与折叠键一起淡出。 */
function BrandHeader({
  collapsed,
  reduce,
  onToggleCollapsed,
}: {
  readonly collapsed: boolean;
  readonly reduce: boolean;
  readonly onToggleCollapsed?: () => void;
}) {
  return (
    <div
      className={cx(
        "flex flex-none items-center border-b border-hairline-subtle transition-all",
        collapsed ? "justify-center p-3" : "space-x-3 p-6",
      )}
    >
      <BrandLogo size={40} />
      <AnimatePresence mode="wait">
        {!collapsed && (
          <motion.div key="brand-text" {...slideFade(reduce, -8)} className="flex-1">
            <p className="font-bold leading-tight text-ink">AI 助手</p>
            <p className="text-xs text-ink-secondary">您的全能 AI 助手</p>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence mode="wait">
        {!collapsed && (
          <motion.button
            key="collapse-btn"
            type="button"
            onClick={onToggleCollapsed}
            aria-label="折叠侧边栏"
            {...popFade(reduce)}
            className="text-ink-tertiary"
          >
            <Icon icon="mdi:chevron-double-left" className="text-base" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 底部两条：主题开关与登出。折叠态都收成居中图标。 */
function RailFooter({ collapsed, onLogout }: { readonly collapsed: boolean; readonly onLogout?: () => void }) {
  return (
    <div className="flex-none border-t border-hairline-subtle">
      <div className={cx("border-b border-hairline-subtle", collapsed ? "flex justify-center py-2.5" : "px-3 py-2")}>
        <ThemeToggle compact={collapsed} />
      </div>
      <div className={cx("flex-none border-t border-hairline-subtle", collapsed ? "flex justify-center py-3" : "p-4")}>
        <button
          type="button"
          onClick={onLogout}
          title={collapsed ? "登出" : undefined}
          className={cx(
            "text-ink-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
            collapsed ? "text-lg" : "w-full text-xs",
          )}
        >
          {collapsed ? <Icon icon="mdi:exit-to-app" aria-hidden /> : "登出"}
        </button>
      </div>
    </div>
  );
}
interface NavRailProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  workflowModule?: WorkflowModuleId;
  onSelectWorkflowSub?: (id: WorkflowSubId) => void;
  onLogout?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  menuVisibility?: ClientMenuVisibility;
}

/** 左侧一级导航。宽度由 Shell 那层的 motion.aside 动，这里只管里面的内容怎么排。 */
export function NavRail({
  currentView,
  onViewChange,
  workflowModule,
  onSelectWorkflowSub,
  onLogout,
  collapsed = false,
  onToggleCollapsed,
  menuVisibility,
}: NavRailProps) {
  const reduce = useReducedMotion() ?? false;
  const onWorkflowPage = currentView === "workflow";

  // 进工作流页就把二级菜单摊开；用户手动收起后，只要还停在工作流页就不再自动弹开
  const [subOpen, setSubOpen] = useState(onWorkflowPage);
  useEffect(() => {
    if (onWorkflowPage) setSubOpen(true);
  }, [onWorkflowPage]);

  const items = NAV_ITEMS.filter((item) => isClientMenuVisible(menuVisibility, `nav.${item.id}`));
  const subItems = WORKFLOW_SUB_ITEMS.filter((sub) => isWorkflowSubVisible(menuVisibility, sub.id));

  // 开发中的模块点了不跳页 —— 两处入口（浮层与展开的二级菜单）共用这一道闸
  const pickSub = (sub: WorkflowSubItem) => {
    if (!sub.developing) onSelectWorkflowSub?.(sub.id);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <BrandHeader collapsed={collapsed} reduce={reduce} onToggleCollapsed={onToggleCollapsed} />

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {items.map((item) =>
          item.id === "workflow" ? (
            <WorkflowGroup
              key={item.id}
              item={item}
              subItems={subItems}
              collapsed={collapsed}
              onWorkflowPage={onWorkflowPage}
              open={subOpen}
              reduce={reduce}
              isActive={(sub) => isWorkflowSubActive(currentView, workflowModule, sub)}
              onToggle={() => setSubOpen((open) => !open)}
              onOpenWorkflow={() => onViewChange("workflow")}
              onPickSub={pickSub}
            />
          ) : (
            <NavButton
              key={item.id}
              item={item}
              active={currentView === item.id}
              collapsed={collapsed}
              onPick={() => onViewChange(item.id)}
            />
          ),
        )}

        <AnimatePresence>
          {collapsed && (
            <motion.button
              key="expand-btn"
              type="button"
              onClick={onToggleCollapsed}
              aria-label="展开侧边栏"
              {...popFade(reduce)}
              className="flex w-full justify-center py-2.5 text-ink-secondary transition-colors"
            >
              <Icon icon="mdi:chevron-double-right" className="text-base" />
            </motion.button>
          )}
        </AnimatePresence>
      </nav>

      <RailFooter collapsed={collapsed} onLogout={onLogout} />
    </div>
  );
}

