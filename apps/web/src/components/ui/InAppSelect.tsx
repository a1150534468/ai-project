import { useState } from "react";
import { Icon } from "@iconify/react";
import { cx } from "./cx";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface InAppSelectProps {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}

/*
 * 站内下拉。刻意不用原生 <select>：选项要带一行副标题、要跟着深浅色 token 走，
 * 而原生控件的弹出层由系统绘制，这两条都做不到。
 *
 * 代价是得自己收起：面板打开时铺一层占满视口的透明按钮接住「点别处」。
 * 用 button 而不是 div，是为了它能进 tab 序列 —— 键盘用户也得有退路。
 */

const TRIGGER =
  "flex h-10 w-full min-w-0 items-center gap-2 rounded-[10px] border border-hairline bg-surface-subtle px-3 text-left text-sm text-ink-secondary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60";

const PANEL =
  "absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-[12px] border border-hairline-subtle bg-surface shadow-[0_18px_40px_rgba(15,23,42,0.12)]";

const OPTION = "flex w-full items-start gap-2 rounded-[9px] px-3 py-2.5 text-left transition";

const TICK = "mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full";

export function InAppSelect({ icon, label, value, options, disabled = false, onChange }: InAppSelectProps) {
  const [open, setOpen] = useState(false);

  // 值对不上任何一项时（枚举改过、或本地存着旧值）退回第一项，别把触发器显示成空白
  const current = options.find((option) => option.value === value) ?? options.at(0);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="relative min-w-0 flex-1">
      {open && (
        <button
          type="button"
          className="fixed inset-0 z-20 cursor-default"
          aria-label={`关闭${label}`}
          onClick={() => setOpen(false)}
        />
      )}

      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={TRIGGER}
      >
        <Icon icon={icon} className="flex-none text-lg text-ink-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{current?.label ?? label}</span>
        <Icon icon="mdi:chevron-down" className="flex-none text-lg text-ink-tertiary" aria-hidden />
      </button>

      {open && (
        <div className={PANEL}>
          <div className="border-b border-hairline-subtle px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-secondary">
            {label}
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5" role="listbox">
            {options.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-tertiary">暂无可选项</div>
            ) : (
              options.map((option) => (
                <OptionRow
                  key={option.value}
                  option={option}
                  checked={option.value === value}
                  onPick={pick}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionRow({
  option,
  checked,
  onPick,
}: {
  readonly option: SelectOption;
  readonly checked: boolean;
  readonly onPick: (value: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      onClick={() => onPick(option.value)}
      className={cx(OPTION, checked ? "bg-brand-soft text-brand-ink" : "text-ink-secondary")}
    >
      {/* 勾永远占位：选中态填实，未选中态只留描边，行高不随选择跳动 */}
      <span className={cx(TICK, checked ? "bg-brand text-white" : "border border-hairline text-transparent")}>
        <Icon icon="mdi:check" className="text-sm" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{option.label}</span>
        {option.description && (
          <span className="mt-0.5 block line-clamp-2 text-xs leading-5 opacity-70">{option.description}</span>
        )}
      </span>
    </button>
  );
}
