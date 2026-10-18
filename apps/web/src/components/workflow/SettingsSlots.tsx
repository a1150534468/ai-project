import type { ReactNode } from "react";
import { cx } from "../ui/cx";

/**
 * 四个工作流模块「设置栏」共用的语言（生图 / 小说 / 桌宠 / 图文）。
 *
 * 改版前四个模块各有各的写法：字段名从 11px 到 14px 都有、字重从 medium 到 semibold 都有、
 * 圆角有 8 / 9 / 10 / 11 / 14 / 16px 六种、桌宠与图文里还有 10px 的浅灰小字。同一件事
 * （「填一个字段」）在四个模块里长得不一样，切换模块时读法要重新学一遍 —— 这就是「别扭」的来源。
 *
 * 这里定的是三个层级，别的什么都不定：
 *   - **分组小标题**（`SETTINGS_GROUP`）：12px/600，`ink-secondary`。一组字段的帽子。
 *   - **字段名**（`SETTINGS_LABEL`）：14px/500，`ink`。规范正文下限就是 14px，不再往下掉。
 *   - **辅助信息**（`SETTINGS_HINT`）：12px，`ink-tertiary`。计数、上限、"可多选"这类。
 * 控件一律 `rounded-[10px]`（规范允许集里的输入控件档）+ 弱底 + 一条 hairline，与 `InAppSelect`
 * 的触发器已经是同一副几何。
 *
 * ⚠️ 字段名与辅助信息**分处两个元素**：`hint` 是 label 的兄弟节点，不写进 label 里。写进去
 * 会让 label 的可访问名变成「写作风格 0/500」，`getByLabelText("写作风格")` 这类断言与读屏
 * 一起失效。要 label 关联控件就用 `htmlFor` + 控件自己的 `id`。
 */

export const SETTINGS_GROUP = "text-xs font-semibold text-ink-secondary";
export const SETTINGS_LABEL = "text-sm font-medium text-ink";
export const SETTINGS_HINT = "text-xs text-ink-tertiary";

/** 单行控件（input / select / 自绘下拉的触发器）。 */
export const SETTINGS_CONTROL =
  "h-10 w-full rounded-[10px] border border-hairline bg-surface-subtle px-3 text-sm text-ink outline-none transition placeholder:text-ink-tertiary focus:border-brand focus:ring-2 focus:ring-brand/10 disabled:cursor-not-allowed disabled:opacity-60";

/** 多行控件（textarea）。 */
export const SETTINGS_TEXTAREA =
  "w-full resize-y rounded-[10px] border border-hairline bg-surface-subtle p-3 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-tertiary focus:border-brand focus:ring-2 focus:ring-brand/10 disabled:cursor-not-allowed disabled:opacity-60";

/** 虚线框槽位（上传、空位）。 */
export const SETTINGS_DROPZONE =
  "flex w-full items-center justify-center gap-2 rounded-[10px] border border-dashed border-hairline bg-surface-subtle text-sm font-medium text-ink transition disabled:cursor-not-allowed disabled:opacity-60";

/**
 * 方形上传位（参考图三宫格里的那一格）。刻意**不基于 `SETTINGS_DROPZONE` 覆写** ——
 * 那边是 `text-sm`、这边要 `text-xs`，`cx` 不做冲突消解，同族两条 utility 谁生效看构建顺序。
 */
export const SETTINGS_DROPZONE_TILE =
  "grid aspect-square cursor-pointer place-items-center rounded-[10px] border border-dashed border-hairline bg-surface-subtle p-2 text-center text-xs leading-4 text-ink-tertiary transition";

/** 只读信息槽位（模型名、配额说明这类不用填的行）。 */
export const SETTINGS_SLOT = "rounded-[10px] bg-surface-subtle px-3 py-2.5 text-sm text-ink-secondary";

/**
 * 设置栏内的分段选择（批量张数、生成方式、创作方式）。
 *
 * ⚠️ 与 `ui/SegmentedControl.tsx`（工具栏/页级筛选用的那条带滑动白底板的分段控件）是**两个语境**，
 * 不是两份规范：设置栏是 300px 的竖栏，控件要**撑满栏宽**、选中态用品牌弱底（`brand-soft`），
 * 与 `SETTINGS_CONTROL` 的输入控件同一副几何；页级筛选在通栏工具条上，选项宽度随文案、
 * 选中态靠底板滑动。改动前先确认自己改的是哪一个语境 —— 别把设置栏的控件改成随文案收缩的。
 */
export const SETTINGS_SEGMENT = "grid overflow-hidden rounded-[10px] border border-hairline bg-surface-subtle";
export const SETTINGS_SEGMENT_ON = "bg-brand-soft font-semibold text-brand-ink";
export const SETTINGS_SEGMENT_OFF = "font-medium text-ink-secondary";

/**
 * 设置栏顶部的标题行（栏内唯一的一行标题，不再叠英文眉标）。56px 与三个区的其它栏头对齐。
 *
 * ⚠️ 已收敛：栏头只有 `WF_PANEL_HEAD` 一份（`workflowLayout.ts`），这里不再另立常量 ——
 * 两份只是 `gap` 与底色不同，同一屏里就会看出三区栏头不齐。设置栏要栏头时直接用那一份。
 */

export interface SettingsGroupProps {
  /** 分组小标题。四个模块用同一套词：「输入」「参数」「外观」「生成选项」… */
  readonly title: string;
  /** 标题右侧的辅助信息 */
  readonly hint?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function SettingsGroup({ title, hint, children, className }: SettingsGroupProps) {
  return (
    <section className={cx("grid gap-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className={SETTINGS_GROUP}>{title}</h3>
        {hint != null && <span className={SETTINGS_HINT}>{hint}</span>}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

export interface SettingsFieldProps {
  /** 字段名。需要挂必填星号这类小标记时可以直接传节点 */
  readonly label: ReactNode;
  /** 辅助信息，跟在字段名右边 */
  readonly hint?: ReactNode;
  /** 给了就渲染成 `<label htmlFor>`，把控件关联过去；不给则只当一行小标题 */
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function SettingsField({ label, hint, htmlFor, children, className }: SettingsFieldProps) {
  return (
    <div className={cx("grid gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={SETTINGS_LABEL}>
            {label}
          </label>
        ) : (
          <span className={SETTINGS_LABEL}>{label}</span>
        )}
        {hint != null && <span className={SETTINGS_HINT}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
