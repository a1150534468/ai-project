import type { Variants } from "motion/react";
import { spring, motionAmount } from "./tokens";

const { enterY, enterScale, enterBlur } = motionAmount;

export const pageEnter: Variants = {
  initial: { opacity: 0, x: enterY * 1.2, scale: enterScale, filter: `blur(${enterBlur}px)` },
  animate: { opacity: 1, x: 0, scale: 1, filter: "blur(0px)", transition: spring.smooth },
  exit: { opacity: 0, x: -enterY, transition: { duration: 0.2 } },
};

export const rowStagger: Variants = {
  animate: { transition: { staggerChildren: 0.07 } },
};

export const rowItem: Variants = {
  initial: { opacity: 0, y: enterY, scale: enterScale, filter: `blur(${enterBlur}px)` },
  animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", transition: spring.bouncy },
};

export const msgIn: Variants = {
  initial: { opacity: 0, y: enterY, scale: enterScale },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.bouncy },
};

export const toastIn: Variants = {
  initial: { opacity: 0, x: 40, scale: 0.9 },
  animate: { opacity: 1, x: 0, scale: 1, transition: spring.bouncy },
  exit: { opacity: 0, x: 40, scale: 0.9, transition: { duration: 0.2 } },
};

export const modalIn: Variants = {
  initial: { opacity: 0, scale: 0.94, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: spring.bouncy },
  exit: { opacity: 0, scale: 0.96, y: 6, transition: { duration: 0.18 } },
};
