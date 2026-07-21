import { Icon } from "@iconify/react";
import { STAGES } from "../../dubWizard";

export interface StepRailProps {
  readonly active: number;
  readonly busy?: boolean;
  /** 传入即允许点击任意一步跳转（历史任务复盘用） */
  readonly onSelect?: (index: number) => void;
}

export function StepRail({ active, busy = false, onSelect }: StepRailProps) {
  const clickable = Boolean(onSelect) && !busy;
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-3">
      {STAGES.map((step, i) => {
        const on = i === active;
        const done = i < active;
        return (
          <li key={step.id}>
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onSelect?.(i)}
              title={clickable ? `跳到「${step.title}」` : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors ${clickable ? "cursor-pointer " : "cursor-default"}`}
            >
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
              {/* 当前步：脉冲光环；忙碌时加速为 ping，让用户一眼看出「这一步正在跑」 */}
              {on && (
                <span
                  className={`absolute inset-0 rounded-full bg-brand/30 ${busy ? "animate-ping" : "animate-pulse"}`}
                  aria-hidden
                />
              )}
              <span
                className={`relative flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-all duration-300 ${
                  done
                    ? "bg-brand text-white"
                    : on
                      ? "bg-brand text-white ring-2 ring-brand/40 ring-offset-1"
                      : "bg-gray-100 text-[#b6b6bd]"
                }`}
              >
                {done ? (
                  <Icon icon="mdi:check" className="text-[13px]" />
                ) : on && busy ? (
                  <Icon icon="mdi:loading" className="animate-spin text-[13px]" />
                ) : (
                  i + 1
                )}
              </span>
            </span>
            <span>
              <span className={`block text-[13px] font-semibold transition-colors ${on || done ? "text-[#1d1d1f]" : "text-[#b6b6bd]"}`}>
                {step.title}
              </span>
              <span className={`block text-[11px] transition-colors ${on || done ? "text-[#8a8a8f]" : "text-[#c7c7cc]"}`}>
                {step.sub}
              </span>
            </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
