/**
 * 基础视觉基元的统一出口。只收「样式基元」——
 * 每个都是「一份 *Class() 类名工厂 + 一层薄组件壳」，样式的真身在工厂里，
 * 好让 motion/RippleButton 这种只加动效的组件也能直接复用（className={buttonClass(...)}）。
 *
 * 同目录的 DownloadLinkDialog / InAppSelect 是成品业务组件，不从这里导出，
 * 免得任何 import 都顺带把 motion 那一坨拖进来。
 *
 * Switch 是唯一一个自带交互语义（role="switch" + aria-checked）而不是纯类名工厂的成员，
 * 也在这里出：它同样不碰 motion，而且手写版本已经在三个页面里各长了一份。
 */
export { cx } from "./cx";
export { Button, buttonClass } from "./Button";
export type { ButtonProps, ButtonShape, ButtonSize, ButtonStyleOptions, ButtonVariant } from "./Button";
export { Card, cardClass } from "./Card";
export type { CardPadding, CardProps, CardRadius, CardStyleOptions, CardTone } from "./Card";
export { Badge, badgeClass } from "./Badge";
export type { BadgeProps, BadgeSize, BadgeStyleOptions, BadgeTone, BadgeVariant } from "./Badge";
export { Alert, alertClass } from "./Alert";
export type { AlertProps, AlertSize, AlertStyleOptions, AlertTone } from "./Alert";
export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";
