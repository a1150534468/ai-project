import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * 面板基元。全站最高频的那串手写 className 是
 * `rounded-2xl border border-hairline-subtle bg-surface p-5`（23 处逐字重复），
 * 再往下是同一造型换 padding / 换圆角的变体（p-4 7 处、rounded-xl…p-3 9 处、rounded-[14px]…p-5 5 处）。
 * 这里把「圆角 + 描边 + 面 + 内边距」四个维度收成参数，值仍然全部来自 --color-* token。
 *
 * 注意 index.css 里 `.apple-shell .rounded-2xl{border-radius:18px}` / `.rounded-xl{11px}` 的改写：
 * 所以 radius="lg" 在 app 内实际是 18px、"md" 是 11px，这里保留 rounded-2xl/rounded-xl 的写法
 * 就是为了跟着那套改写走，不要换成 rounded-[18px] 之类绕开它。
 */
export type CardPadding = "none" | "sm" | "md" | "lg" | "xl";
export type CardTone = "surface" | "subtle" | "muted" | "raised";
export type CardRadius = "md" | "lg";

export interface CardStyleOptions {
  readonly padding?: CardPadding;
  readonly tone?: CardTone;
  readonly radius?: CardRadius;
  /** 关掉描边（用在已经有分组底色、不需要再画一圈线的场合） */
  readonly bordered?: boolean;
  /** 只加工厂没设过的属性（布局、间距、阴影等），别用来盖同族 utility，见 cx.ts */
  readonly className?: string;
}

/** 12 / 16 / 20 / 24px，对齐 design-system.md §4 的 --space-3 ~ --space-6 */
const PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
  xl: "p-6",
};

const TONE: Record<CardTone, string> = {
  surface: "bg-surface",
  subtle: "bg-surface-subtle",
  muted: "bg-surface-muted",
  raised: "bg-surface-raised",
};

const RADIUS: Record<CardRadius, string> = {
  md: "rounded-xl",
  lg: "rounded-2xl",
};

export function cardClass({
  padding = "lg",
  tone = "surface",
  radius = "lg",
  bordered = true,
  className,
}: CardStyleOptions = {}): string {
  return cx(RADIUS[radius], bordered && "border border-hairline-subtle", TONE[tone], PADDING[padding], className);
}

export type CardProps = CardStyleOptions & Omit<HTMLAttributes<HTMLDivElement>, "className">;

/** 语义上是 <article>/<section> 的地方直接用 `className={cardClass(...)}`，别为了用组件把标签改成 div */
export function Card({ padding, tone, radius, bordered, className, ...rest }: CardProps) {
  return <div className={cardClass({ padding, tone, radius, bordered, className })} {...rest} />;
}
