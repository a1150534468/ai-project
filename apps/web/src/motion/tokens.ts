/**
 * 动效常量表。会动的组件一律从这里取值、不在组件里写裸数字 ——
 * 各处各写一套 stiffness，整个界面的节奏就散了。
 */
import type { Transition } from "motion/react";

/** 弹簧只调刚度与阻尼这两个量，包一层就不用把 `type: "spring"` 抄三遍，也没机会把字段名写错。 */
function springOf(stiffness: number, damping: number): Transition {
  return { type: "spring", stiffness, damping };
}

/**
 * 三档弹簧，按回弹幅度从小到大：
 *  - `snappy`：按钮按下与松开，要跟手，所以刚度最高、几乎不过冲。
 *  - `bouncy`：气泡 / 弹窗 / Toast 入场，过冲一点才有「弹出来」的观感。
 *  - `smooth`：侧栏宽度这类大面积位移，晃一下很扎眼，所以给得最稳。
 */
export const spring = {
  snappy: springOf(520, 30),
  bouncy: springOf(380, 22),
  smooth: springOf(260, 32),
} as const;

/**
 * 入场位移与按压手感的幅度。
 * `enterY` / `enterScale` 给 `variants.ts` 的入场动画，`lift` / `press` 给 `RippleButton` 的悬停与按下；
 * `lift` 是负数 —— CSS 的 y 轴向下为正，「抬起来」得往负方向走。
 */
export const motionAmount = {
  enterY: 26,
  enterScale: 0.9,
  lift: -5,
  press: 0.93,
} as const;
