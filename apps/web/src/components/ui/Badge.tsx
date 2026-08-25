import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * 药丸标签基元。它存在的主要理由不是省字数，而是把 design-system.md 的
 * 「状态色三件套」写成代码里唯一的组合方式：弱底 `X/10` 上的文字必须用 `X-ink`。
 * 直接写 `bg-warning/10 text-warning` 只有 2.9:1、`text-danger` 4.1:1，都过不了 AA，
 * 换成 `-ink` 分别是 4.9:1 / 6.0:1 —— 这个配对现在由 SOFT / OUTLINE 表锁死，调用方选不错。
 *
 * brand 一档不走 `/10`：它有专门的 `brand-soft` token（暗色下是深蓝底而不是半透明蓝）。
 */
export type BadgeTone = "brand" | "danger" | "warning" | "info" | "success" | "neutral";
/** soft = 弱底 + -ink 文字（默认）；solid = 实底白字；outline = 只有描边 */
export type BadgeVariant = "soft" | "solid" | "outline";
export type BadgeSize = "xs" | "sm" | "md";

export interface BadgeStyleOptions {
  readonly tone?: BadgeTone;
  readonly variant?: BadgeVariant;
  readonly size?: BadgeSize;
  /** 只加工厂没设过的属性（布局、间距等），别用来盖同族 utility，见 cx.ts */
  readonly className?: string;
}

const BASE = "inline-flex flex-none items-center gap-1 rounded-full font-medium";

const SOFT: Record<BadgeTone, string> = {
  brand: "bg-brand-soft text-brand-ink",
  danger: "bg-danger/10 text-danger-ink",
  warning: "bg-warning/10 text-warning-ink",
  info: "bg-info/10 text-info-ink",
  success: "bg-success/10 text-success-ink",
  neutral: "bg-surface-muted text-ink-secondary",
};

/**
 * 实底上是白字，所以底色用 `X`（600 档）而不是更深的 `X-ink`。
 * 例外是 warning / success：它们的 600 档太亮，白字只有 3.1:1 / 3.4:1，过不了 AA；
 * 换成 `text-scrim`（唯一一个不随主题翻转的深色 token）是 5.5:1，且暗色下底色更亮、对比更好。
 * neutral 走 inverse 面 —— 那一档的底和字都跟着主题翻。
 */
const SOLID: Record<BadgeTone, string> = {
  brand: "bg-brand text-white",
  danger: "bg-danger text-white",
  warning: "bg-warning text-scrim",
  info: "bg-info text-white",
  success: "bg-success text-scrim",
  neutral: "bg-surface-inverse text-ink-inverse",
};

const OUTLINE: Record<BadgeTone, string> = {
  brand: "border border-brand/30 text-brand-ink",
  danger: "border border-danger/30 text-danger-ink",
  warning: "border border-warning/30 text-warning-ink",
  info: "border border-info/30 text-info-ink",
  success: "border border-success/30 text-success-ink",
  neutral: "border border-hairline text-ink-secondary",
};

const VARIANT: Record<BadgeVariant, Record<BadgeTone, string>> = {
  soft: SOFT,
  solid: SOLID,
  outline: OUTLINE,
};

/** 三档取的是全站实测最高频的三种组合（px-2 py-0.5 text-[10px] / [11px]、px-2.5 py-1 text-[11px]） */
const SIZE: Record<BadgeSize, string> = {
  xs: "px-2 py-0.5 text-[10px]",
  sm: "px-2 py-0.5 text-[11px]",
  md: "px-2.5 py-1 text-[11px]",
};

export function badgeClass({ tone = "neutral", variant = "soft", size = "sm", className }: BadgeStyleOptions = {}): string {
  return cx(BASE, VARIANT[variant][tone], SIZE[size], className);
}

export type BadgeProps = BadgeStyleOptions & Omit<HTMLAttributes<HTMLSpanElement>, "className">;

export function Badge({ tone, variant, size, className, ...rest }: BadgeProps) {
  return <span className={badgeClass({ tone, variant, size, className })} {...rest} />;
}
