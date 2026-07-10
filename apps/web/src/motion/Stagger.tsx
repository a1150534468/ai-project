import type { ReactNode } from "react";

// 说明：列表/卡片的「逐个弹出」入场动效已按产品反馈移除，
// 这里保留组件与 className 透传（维持布局），仅不再做入场动画。
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}
