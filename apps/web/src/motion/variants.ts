/**
 * `motion` 的 variants 表。组件那侧只写 `variants={msgIn} initial="initial" animate="animate"`，
 * 幅度和弹簧全收在这里 —— 调手感只改这一个文件，不用翻组件。
 */
import type { Transition, Variants } from "motion/react";
import { motionAmount, spring } from "./tokens";

/**
 * 三套入场的 `animate` 是同一件事：回到中立位、用同一条弹簧，所以只写一次。
 * 两个轴都显式归零 —— 某套只动了 y，它的 x 本来就在 0，写上去不多花一帧，
 * 但省掉了「这套动的是哪个轴」的心智负担。
 */
const settled = { opacity: 1, x: 0, y: 0, scale: 1, transition: spring.bouncy } as const;

/** 退场一律定时、不用弹簧：元素已经在往外走，再回弹一下会显得没走干净。 */
function exitOver(seconds: number): Transition {
  return { duration: seconds };
}

/** 聊天气泡：从下方托上来，幅度取自全站同一份 token。没有 `exit` —— 消息只会追加，不会单条消失。 */
export const msgIn: Variants = {
  initial: { opacity: 0, y: motionAmount.enterY, scale: motionAmount.enterScale },
  animate: settled,
};

/** Toast 钉在右下角，横向进出才对得上它的位置；而且进和出是同一个位姿，所以只写一份。 */
const toastOffscreen = { opacity: 0, x: 40, scale: 0.9 } as const;

export const toastIn: Variants = {
  initial: toastOffscreen,
  animate: settled,
  exit: { ...toastOffscreen, transition: exitOver(0.2) },
};

/** 弹窗原地放大。退场缩得比入场浅（0.96 对 0.94）、上移也少：开要「长出来」，关只要「让开」。 */
export const modalIn: Variants = {
  initial: { opacity: 0, scale: 0.94, y: 8 },
  animate: settled,
  exit: { opacity: 0, scale: 0.96, y: 6, transition: exitOver(0.18) },
};
