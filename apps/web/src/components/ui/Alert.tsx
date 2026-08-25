import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * 状态提示块（错误 / 警告 / 说明 / 成功回执）。全站有 66 处「弱底 + `-ink` 文字」的块，
 * 光 danger 一种就散成 11 种圆角·内边距组合（rounded-lg / xl / [9px] / [10px] / [12px] / [14px]
 * × px-3 py-2 / px-4 py-3 / px-5 py-4 / px-3 py-2.5 × text-xs / text-sm）。这里收成 tone × size 两档。
 *
 * 和 Badge 一样，配对由表锁死：弱底 `X/10` 上的文字只能是 `X-ink`（见 design-system.md 状态色三件套）。
 * 区别是 Alert 承载的是正文而不是标签，所以 AA 在这里是硬要求，不是锦上添花。
 */
export type AlertTone = "danger" | "warning" | "info" | "success" | "brand";
export type AlertSize = "sm" | "md";

export interface AlertStyleOptions {
  readonly tone?: AlertTone;
  readonly size?: AlertSize;
  /** 加一圈 `X/20` 描边。默认关，因为全站多数提示块是无描边的纯弱底 */
  readonly bordered?: boolean;
  /** 只加工厂没设过的属性（布局、间距等），别用来盖同族 utility，见 cx.ts */
  readonly className?: string;
}

const TONE: Record<AlertTone, string> = {
  danger: "bg-danger/10 text-danger-ink",
  warning: "bg-warning/10 text-warning-ink",
  info: "bg-info/10 text-info-ink",
  success: "bg-success/10 text-success-ink",
  brand: "bg-brand-soft text-brand-ink",
};

const BORDER: Record<AlertTone, string> = {
  danger: "border border-danger/20",
  warning: "border border-warning/20",
  info: "border border-info/20",
  success: "border border-success/20",
  brand: "border border-brand/20",
};

const SIZE: Record<AlertSize, string> = {
  sm: "rounded-[10px] px-3 py-2 text-xs",
  md: "rounded-xl px-4 py-3 text-sm",
};

export function alertClass({ tone = "danger", size = "md", bordered = false, className }: AlertStyleOptions = {}): string {
  return cx(SIZE[size], TONE[tone], bordered && BORDER[tone], className);
}

export type AlertProps = AlertStyleOptions & Omit<HTMLAttributes<HTMLDivElement>, "className">;

/** 默认 role：danger 是 `alert`（assertive，读屏会打断），其余是 `status`（polite） */
export function Alert({ tone = "danger", size, bordered, className, role, ...rest }: AlertProps) {
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={alertClass({ tone, size, bordered, className })}
      {...rest}
    />
  );
}
