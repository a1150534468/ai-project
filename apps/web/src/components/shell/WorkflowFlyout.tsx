import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@iconify/react";
import type { WorkflowSubItem } from "./NavRail";

interface WorkflowFlyoutProps {
  items: WorkflowSubItem[];
  isActive: (sub: WorkflowSubItem) => boolean;
  onSelect: (sub: WorkflowSubItem) => void;
}

/** 折叠态下「工作流」的二级菜单浮层。子项逐个淡入（35ms 间隔）。 */
export function WorkflowFlyout({ items, isActive, onSelect }: WorkflowFlyoutProps) {
  const reduce = useReducedMotion();
  return (
    <div className="min-w-[152px] rounded-xl border border-gray-100 bg-white p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.13)]">
      <p className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">工作流</p>
      {items.map((sub, idx) => {
        const active = isActive(sub);
        return (
          <motion.button
            key={sub.id}
            type="button"
            disabled={sub.developing}
            onClick={() => !sub.developing && onSelect(sub)}
            initial={reduce ? false : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: reduce ? 0 : idx * 0.035, duration: 0.16 }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              active ? "bg-brand-soft font-semibold text-brand-ink"
                : sub.developing ? "cursor-not-allowed text-gray-300" : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            <Icon icon={sub.icon} className="flex-none text-base" aria-hidden />
            <span className="flex-1 truncate">{sub.label}</span>
            {sub.developing && <span className="flex-none text-[10px] text-gray-300">开发中</span>}
          </motion.button>
        );
      })}
    </div>
  );
}
