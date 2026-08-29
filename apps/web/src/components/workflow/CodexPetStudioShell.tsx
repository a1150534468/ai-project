/**
 * 桌宠工坊自己的五个展示原件(Card / CardTitle / StatusPill / PrimaryButton / ImagePlaceholder)。
 * 从 `CodexPetStudio.tsx` 原样搬出,**类名逐字未改**——这些字符串就是视觉本身,任何"顺手统一"
 * 都会在没有视觉测试的地方留下肉眼可见的差异。
 *
 * 这里不是要建全局基础组件层(那是 P2.3 的议题);只是让三个面板文件共用同一份原件,
 * 避免拆分时把同一个按钮复制三遍。
 */
import { Icon } from "@iconify/react";
import type { ReactNode } from "react";
import { codexPetStatusLabel } from "./codexPetStudioModel";

export function Card({ children, className = "", ariaLabel }: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly ariaLabel?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={`rounded-[16px] border border-hairline-subtle bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.03)] ${className}`}
    >
      {children}
    </section>
  );
}

export function CardTitle({ icon, title, aside }: { readonly icon: string; readonly title: string; readonly aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-hairline-subtle px-4 py-3">
      <span className="grid size-7 place-items-center rounded-[8px] bg-brand-soft text-brand-ink">
        <Icon icon={icon} className="text-base" aria-hidden />
      </span>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {aside && <div className="ml-auto">{aside}</div>}
    </div>
  );
}

export function StatusPill({ status }: { readonly status: string }) {
  const complete = status === "ready";
  const failed = status === "failed" || status === "cancelled";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
      complete ? "bg-brand-soft text-brand-ink" : failed ? "bg-danger/10 text-danger-ink" : "bg-brand-soft text-brand-ink"
    }`}>
      {codexPetStatusLabel(status)}
    </span>
  );
}

export function PrimaryButton(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly kind?: "primary" | "secondary" | "danger";
  readonly icon?: string;
  readonly ariaLabel?: string;
}) {
  const kind = props.kind ?? "primary";
  const colors = kind === "primary"
    ? "bg-brand text-white "
    : kind === "danger"
      ? "border border-danger/30 bg-surface text-danger-ink "
      : "border border-hairline-subtle bg-surface text-ink ";
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[10px] px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-45 ${colors}`}
    >
      {props.icon && <Icon icon={props.icon} className="text-base" aria-hidden />}
      {props.children}
    </button>
  );
}

export function ImagePlaceholder({ text }: { readonly text: string }) {
  return (
    <div className="grid min-h-40 place-items-center rounded-[12px] border border-dashed border-hairline bg-surface-subtle px-5 text-center text-xs leading-5 text-ink-tertiary">
      {text}
    </div>
  );
}
