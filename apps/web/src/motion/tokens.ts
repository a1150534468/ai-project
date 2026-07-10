import type { Transition } from "motion/react";

export const spring = {
  snappy: { type: "spring", stiffness: 520, damping: 30 } satisfies Transition,
  bouncy: { type: "spring", stiffness: 380, damping: 22 } satisfies Transition,
  smooth: { type: "spring", stiffness: 260, damping: 32 } satisfies Transition,
} as const;

export const duration = { micro: 0.17, std: 0.34, emph: 0.48 } as const;

export const easing = {
  outExpo: [0.16, 1, 0.3, 1],
  softSpring: [0.34, 1.4, 0.5, 1],
} as const;

export const motionAmount = {
  enterY: 26,
  enterScale: 0.9,
  enterBlur: 8,
  lift: -5,
  press: 0.93,
} as const;
