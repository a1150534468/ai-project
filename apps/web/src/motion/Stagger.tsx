/**
 * 列表 / 卡片的「逐个弹出」入场动效已按产品反馈去掉，只留下这两个透传壳子：
 * 调用方（`pages/Knowledge.tsx`）的 `className` 还挂在它们身上，直接删会掉布局。
 * 等那个页面重写时把 `<Stagger>` 换成普通 `<div>`，这个文件就可以一起消失。
 */
import type { ReactNode } from "react";

interface PassthroughProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Stagger({ children, className }: PassthroughProps) {
  return <div className={className}>{children}</div>;
}

export function StaggerItem({ children, className }: PassthroughProps) {
  return <div className={className}>{children}</div>;
}
