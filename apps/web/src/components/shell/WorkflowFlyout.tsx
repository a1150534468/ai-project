import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@iconify/react";
import { cx } from "../ui";
import type { WorkflowSubItem } from "./NavRail";

/** 子项逐个淡入的间隔；条目不多，35ms 铺开刚好读得出顺序 */
const STAGGER_S = 0.035;

const CARD = "min-w-[152px] rounded-xl border border-hairline-subtle bg-surface p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.13)]";
const TITLE = "px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-ink-tertiary";
const ROW = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors";

interface WorkflowFlyoutProps {
  items: WorkflowSubItem[];
  isActive: (sub: WorkflowSubItem) => boolean;
  onSelect: (sub: WorkflowSubItem) => void;
}

/** 一行三种模样，互斥：当前页 → 开发中（点不动）→ 普通。 */
function rowTone(active: boolean, developing: boolean): string {
  if (active) return "bg-brand-soft font-semibold text-brand-ink";
  if (developing) return "cursor-not-allowed text-ink-tertiary";
  return "text-ink-secondary";
}

/** 折叠态下「工作流」的二级菜单浮层。 */
export function WorkflowFlyout({ items, isActive, onSelect }: WorkflowFlyoutProps) {
  const reduce = useReducedMotion();
  return (
    <div className={CARD}>
      <p className={TITLE}>工作流</p>
      {items.map((sub, index) => (
        <motion.button
          key={sub.id}
          type="button"
          // disabled 已经挡掉了点击，onClick 里不必再判一次 developing
          disabled={sub.developing}
          onClick={() => onSelect(sub)}
          initial={reduce ? false : { opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: reduce ? 0 : index * STAGGER_S, duration: 0.16 }}
          className={cx(ROW, rowTone(isActive(sub), Boolean(sub.developing)))}
        >
          <Icon icon={sub.icon} className="flex-none text-base" aria-hidden />
          <span className="flex-1 truncate">{sub.label}</span>
          {sub.developing && <span className="flex-none text-[10px] text-ink-tertiary">开发中</span>}
        </motion.button>
      ))}
    </div>
  );
}
