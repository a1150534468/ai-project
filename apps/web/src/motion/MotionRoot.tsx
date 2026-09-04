/**
 * 动效总开关。挂在 `main.tsx` 最外层附近，`reducedMotion="user"` 让整棵树都跟随系统的
 * 「减少动效」偏好 —— 组件里的 `useReducedMotion()` 读的就是它，所以没有第二处需要判断。
 */
import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";

export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
