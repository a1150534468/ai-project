import { useState } from "react";
import { Icon } from "@iconify/react";

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

export function InAppSelect({ icon, label, value, options, disabled = false, onChange }: InAppSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
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
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-10 w-full min-w-0 items-center gap-2 rounded-[10px] border border-hairline bg-surface-subtle px-3 text-left text-sm text-ink-secondary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon icon={icon} className="flex-none text-lg text-ink-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? label}</span>
        <Icon icon="mdi:chevron-down" className="flex-none text-lg text-ink-tertiary" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-[12px] border border-hairline-subtle bg-white shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
          <div className="border-b border-[#f0f0f3] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-secondary">
            {label}
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5" role="listbox">
            {options.map((option) => {
              const checked = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2 rounded-[9px] px-3 py-2.5 text-left transition ${
                    checked ? "bg-brand-soft text-brand-ink" : "text-ink-secondary "
                  }`}
                >
                  <span className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full ${
                    checked ? "bg-brand text-white" : "border border-hairline text-transparent"
                  }`}>
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
            })}
            {options.length === 0 && <div className="px-3 py-6 text-center text-xs text-ink-tertiary">暂无可选项</div>}
          </div>
        </div>
      )}
    </div>
  );
}
