/**
 * 桌宠工坊自己的五个展示原件(Card / CardTitle / StatusPill / PrimaryButton / ImagePlaceholder)。
 * 从 `CodexPetStudio.tsx` 原样搬出，拆分时一个类名都没改。
 *
 * 2026-10-15 改版：几何归位到规范允许集 —— 卡片 `rounded-2xl`（原来 16px 不在档内）、
 * 去掉壳内不该有的投影（规范 §7：层次靠面与边框）、`text-[10px]` 一律提到 12px。
 * 这里不是要建全局基础组件层，只是让三个面板文件共用同一份原件。
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
      className={`rounded-2xl border border-hairline-subtle bg-surface ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * 卡头：一条 56px 的头行 + 下沿 hairline。带 `bg-surface` 是为了在**工作区卡**（底色是
 * `surface-subtle` 的那张）里也能显出一条白带 —— 与生图工作区那条头行同一副观感。
 */
export function CardTitle({ icon, title, aside }: { readonly icon: string; readonly title: string; readonly aside?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-2 border-b border-hairline-subtle bg-surface px-4 py-2">
      <span className="grid size-7 place-items-center rounded-[10px] bg-brand-soft text-brand-ink">
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
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
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

/**
 * 空态占位。`max-w-prose` 是给长句子留的：外层是 `grid place-items-center`，
 * 网格项默认按 max-content 撑宽，一句 100 字的说明会顶成一行不换行、横向溢出容器。
 * 限到 65ch 之后它才在该断的地方断 —— 空态文案写多长都不会破版。
 */
export function ImagePlaceholder({ text }: { readonly text: string }) {
  return (
    <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-hairline bg-surface-subtle px-5 text-center">
      <p className="max-w-prose text-xs leading-5 text-ink-tertiary">{text}</p>
    </div>
  );
}
