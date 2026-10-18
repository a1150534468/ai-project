import { Icon } from "@iconify/react";
import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { SegmentedControl } from "../ui/SegmentedControl";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../../workflowState";
import { isWorkflowSubVisible, type ClientMenuVisibility } from "../../clientMenu";
import type { PanelVisibility } from "./panelVisibility";

/**
 * 工作流顶栏：**模块切换胶囊 + 模块状态 chip + 面板开关**。
 *
 * 改版前每个模块页是「面包屑『工作流 / 生图模块』+ 24px H1 + 一句模块自述」三行，占掉 100px；
 * 而模块名侧栏里已经写着、又说了一遍。原型里这一条被压成 56px 的顶栏：左边四个模块胶囊、
 * 右边状态 chip 与一对面板开关，位置固定在所有模块的第一条。
 *
 * 三个约定：
 *   - **胶囊上是短名**（`shortTitle`）：56px 高的条带放不下「多平台图文工作流」。
 *   - **顶栏里不放 `h1`**：模块是这一屏的「页」，但它的名字以切换器的形态出现，语义上应交给
 *     各页自己的 h1（小说书库页有、工作台各模块有）。放进来还会和页面标题打架。
 *   - **状态 chip 是可选的**：只有拿得到数据的模块才给（生图给「任务队列 · N 进行中」），
 *     拿不到就不渲染 —— 编一个空 chip 比不渲染更糟。
 */
export interface WorkflowTopBarProps {
  readonly activeModuleId: WorkflowModuleId;
  /** 点胶囊切模块。没给回调就只显示不可点（例如单独挂载本组件做视觉检查时） */
  readonly onSelectModule?: (id: WorkflowModuleId) => void;
  readonly menuVisibility?: ClientMenuVisibility;
  readonly status?: ReactNode;
  readonly className?: string;
  /** 给了就渲染「面板开关」那一对按钮（三区模块才给） */
  readonly panels?: PanelVisibility;
  readonly onTogglePanel?: (side: "left" | "right") => void;
}

export function WorkflowTopBar({
  activeModuleId,
  onSelectModule,
  menuVisibility,
  status,
  className,
  panels,
  onTogglePanel,
}: WorkflowTopBarProps) {
  const modules = WORKFLOW_MODULES.filter(
    (module) => module.status === "available" && isWorkflowSubVisible(menuVisibility, module.id),
  );

  return (
    <header
      className={cx(
        "flex min-h-14 flex-none items-center gap-3 border-b border-hairline-subtle bg-surface px-4 sm:px-6",
        className,
      )}
    >
      {/* 模块切换原来是一排实心品牌色胶囊，选中项靠「填成实心」表示 —— 和素材库、知识库那两处
          又是另一副长相。现在统一成分段控件：选中项下面一块白底板滑过去（spring.smooth），
          与侧栏导航的选中指示器同一条曲线。 */}
      <SegmentedControl
        ariaLabel="工作流模块"
        value={activeModuleId}
        onChange={(id) => onSelectModule?.(id)}
        options={modules.map((module) => ({
          value: module.id,
          label: module.shortTitle,
          icon: module.icon,
          title: module.title,
          disabled: onSelectModule === undefined,
        }))}
        className="min-w-0"
      />

      <div className="ml-auto flex flex-none items-center gap-2">
        {status}
        {panels && onTogglePanel && (
          <PanelToggle
            side="left"
            visible={panels.left}
            label="设置栏"
            onToggle={() => onTogglePanel("left")}
          />
        )}
        {panels && onTogglePanel && (
          <PanelToggle
            side="right"
            visible={panels.right}
            label="历史栏"
            onToggle={() => onTogglePanel("right")}
          />
        )}
      </div>
    </header>
  );
}

/**
 * 面板开关的一颗：箭头朝哪边表示「这一栏现在在哪」，收起来就换成反向箭头。
 * `aria-pressed` 报的是「当前是展开的」——读屏用户听到的是状态，不是图标长什么样。
 */
function PanelToggle({
  side,
  visible,
  label,
  onToggle,
}: {
  readonly side: "left" | "right";
  readonly visible: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  const action = visible ? "收起" : "展开";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={visible}
      aria-label={`${action}${label}`}
      title={`${action}${label}`}
      className={cx(
        "grid h-9 w-9 flex-none place-items-center rounded-[10px] border transition-colors",
        visible
          ? "border-hairline bg-surface text-ink-secondary hover:text-ink"
          : "border-hairline-subtle bg-surface-muted text-ink-tertiary",
      )}
    >
      <Icon
        icon={
          side === "left"
            ? visible
              ? "mdi:arrow-collapse-left"
              : "mdi:arrow-expand-left"
            : visible
              ? "mdi:arrow-collapse-right"
              : "mdi:arrow-expand-right"
        }
        className="text-lg"
        aria-hidden
      />
    </button>
  );
}

/** 顶栏右侧的状态 chip。中性与进行中两种语气，颜色仍然只走语义 token。 */
export function WorkflowStatusChip({
  icon,
  children,
  tone = "neutral",
}: {
  readonly icon: string;
  readonly children: ReactNode;
  readonly tone?: "neutral" | "live";
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
        tone === "live" ? "border-brand/30 bg-brand-soft text-brand-ink" : "border-hairline bg-surface-subtle text-ink-secondary",
      )}
    >
      <Icon icon={icon} className="text-base" aria-hidden />
      {children}
    </span>
  );
}
