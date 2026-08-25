import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * 按钮基元。全站 427 个 <button> 里，品牌主按钮的圆角散成 13 个值
 * （rounded-full 78 / rounded-lg 51 / rounded-xl 25 / rounded-[10px] 22 / 8·9·11·12·14px / md / sm / 2xl / 3xl），
 * 禁用态散成 4 种写法（opacity-50 60 处 / -40 27 / -60 16 / -45 5）。这里把两者各收成一档。
 *
 * 用法有两种，等价：
 *   <Button variant="primary">保存</Button>
 *   <RippleButton className={buttonClass({ variant: "primary" })}>保存</RippleButton>
 * 后者是给 motion/RippleButton 这类「只加动效、样式全靠 className」的组件留的口子 ——
 * 所以样式的真身是 buttonClass()，<Button> 只是它 + <button type="button"> 的薄壳，
 * 不在这里内置动效，普通按钮不该被强塞 spring。
 *
 * focus-visible 不用各自写：index.css 的 base 层已给 button/a/input 统一了 2px 品牌色 outline。
 */
export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "xl";
/** pill = 全圆角（最常见的品牌按钮）；rounded = 10px，与 index.css 里 input/textarea/select 的圆角对齐 */
export type ButtonShape = "pill" | "rounded";

export interface ButtonStyleOptions {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly shape?: ButtonShape;
  /** 撑满父容器宽度 */
  readonly block?: boolean;
  /** 只加工厂没设过的属性（布局、间距、阴影等），别用来盖同族 utility，见 cx.ts */
  readonly className?: string;
}

/**
 * BASE 里刻意不放 `flex-none`：弹窗底部那种 `flex-1` 平分宽度的按钮行很常见，
 * 而 Tailwind 产物里 `.flex-1` 排在 `.flex-none` 前面 —— 工厂一旦设了 flex-none，
 * 调用方传的 flex-1 就永远赢不了（cx.ts 里写的就是这个坑）。需要不收缩的场合自己加 flex-none。
 */
const BASE =
  "inline-flex items-center justify-center gap-1.5 font-semibold transition-colors disabled:cursor-not-allowed";

/**
 * 实底两档（primary / danger）的禁用态刻意不用 opacity：`bg-brand` 半透明后白字只剩 ~2.2:1，
 * 过不了 AA。改成 `bg-hairline` + `ink-tertiary`（灰底灰字，4.6:1）。
 * 弱强调三档本身对比度余量大，继续用 opacity-50 就够。
 *
 * hover 用同色 /90 而不是换到 `-ink` 档：`-ink` 在暗色下是提亮值（brand-ink #5bafff），
 * 白字落上去只有 2.3:1，hover 一下就读不了了；/90 两种主题下都只是轻微压暗，白字仍在 5:1 以上。
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand/90 disabled:bg-hairline disabled:text-ink-tertiary",
  danger: "bg-danger text-white hover:bg-danger/90 disabled:bg-hairline disabled:text-ink-tertiary",
  secondary: "bg-surface-muted text-ink hover:bg-hairline-subtle disabled:opacity-50",
  outline: "border border-hairline bg-surface text-ink hover:border-brand/40 hover:text-brand-ink disabled:opacity-50",
  ghost: "text-ink-secondary hover:bg-surface-muted hover:text-ink disabled:opacity-50",
};

/** 32 / 36 / 40 / 44px 四档，取的是全站实测最高频的四个高度（h-8 74 处、h-9 117、h-10 91、h-11 34） */
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-3.5 text-sm",
  lg: "h-10 px-4 text-sm",
  xl: "h-11 px-6 text-sm",
};

const SHAPE: Record<ButtonShape, string> = {
  pill: "rounded-full",
  rounded: "rounded-[10px]",
};

export function buttonClass({
  variant = "primary",
  size = "md",
  shape = "pill",
  block = false,
  className,
}: ButtonStyleOptions = {}): string {
  return cx(BASE, VARIANT[variant], SIZE[size], SHAPE[shape], block && "w-full", className);
}

export type ButtonProps = ButtonStyleOptions & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

export function Button({ variant, size, shape, block, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, shape, block, className })} {...rest} />;
}
