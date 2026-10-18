/**
 * 页面转场与依次入场。规范 §6 承诺的两条动效，之前代码里都不存在 ——
 * 视图切换是硬切，列表是一次性全冒出来。落地的是 `prototype/说明.md` 二节那两组参数：
 *
 * - **页面转场** 420ms smooth 弹簧：进入 = 上移 12px + 缩放 .992→1 + 模糊 6px→0；
 *   离开 = 160ms 加速淡出（离开比进入快，元素已经在往外走，再回弹一下会显得没走干净）。
 * - **进入依次出现** 每项 40ms 间隔、最多 7 项、总长 ≤600ms，bouncy 曲线；
 *   只对进入的那一屏播，主角先到、其余跟上。
 *
 * ⚠️ 幅度刻意比 `msgIn` 小得多：气泡是一个新元素从零长出来，而整页是「已经在屏幕上的东西
 * 换了内容」，位移 26px + 缩到 .9 会让用户以为页面被抽走换了一张。模糊只有 6px，够盖住
 * 「两套内容在同一帧里都清晰」的撕裂感，又不至于像毛玻璃那样糊掉文字。
 */
import { motion, type Transition } from "motion/react";
import type { ReactNode } from "react";
import { spring } from "./tokens";

/**
 * 这个环境跑不跑动画。
 *
 * jsdom 没有 `requestAnimationFrame` 驱动的帧循环，`AnimatePresence` 的 exit 永远等不到
 * `onComplete` —— 旧视图会一直挂在 DOM 里，于是「切换到 B 页」在测试中断言成「A 和 B 都在」。
 * 那不是 bug 是环境差异，所以这里按能力判断而不是按 `process.env.NODE_ENV`：
 * 没有 `matchMedia` 就是 jsdom（真浏览器一定有），直接退化成不包 `AnimatePresence` 的硬切。
 *
 * ⚠️ 不要改成读 `import.meta.env.MODE === "test"`：那会让生产构建里永远带着这条分支，
 * 而且真实用户的「减少动效」偏好由 `MotionConfig reducedMotion="user"` 统一接管，走的是另一条路。
 */
const CAN_ANIMATE = typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * 这个环境能不能跑 exit 动画。`App.tsx` 包不包 `AnimatePresence` 也看它 ——
 * 没有帧循环的环境里 `AnimatePresence` 只会把旧视图永久留在 DOM 里（exit 等不到完成），
 * 那层 wrapper 反而成了「切换后两个页面都在」的根源。
 */
export const canAnimateTransitions = CAN_ANIMATE;

/**
 * 方向随导航顺序：往下切（侧栏序号变大）从下方进，往上切从上方进。
 * 参数从 `direction` 进来而不是自己记上次的页面 —— 「上一次」属于路由层，组件里再存一份
 * 就会和真实导航顺序打架（浏览器后退、直达 URL 都会绕开它）。
 */
export interface PageTransitionProps {
  readonly children: ReactNode;
  /** 1 = 往下切（从下方进入），-1 = 往上切（从上方进入），0 = 不区分方向（首屏） */
  readonly direction?: 1 | -1 | 0;
  readonly className?: string;
}

export function PageTransition({ children, direction = 0, className }: PageTransitionProps) {
  // 没有动画能力（jsdom）就只当一层普通容器：内容该在就在、该走就走，
  // 调用方那套 `AnimatePresence` 也就没有存在的必要 —— 见 App.tsx 的同名判断。
  if (!CAN_ANIMATE) {
    return <div className={className}>{children}</div>;
  }

  const enter: Transition = { ...spring.smooth, duration: 0.42 };
  return (
    <motion.div
      // key 由调用方给：转场要「换内容就重播」，而 key 变一次 React 才会卸旧装新，
      // 卸旧才会走 exit —— 少了 key，同一棵子树里换内容只是原地改字，什么都不播。
      className={className}
      initial={{ opacity: 0, y: direction === 0 ? 12 : direction * 12, scale: 0.992, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)", transition: enter }}
      exit={{ opacity: 0, scale: 0.996, filter: "blur(2px)", transition: { duration: 0.16 } }}
    >
      {children}
    </motion.div>
  );
}

/** 依次入场的最大项数与单项延迟。总长 6×40 + 380 ≈ 620ms，卡在规范「≤600ms」附近。 */
const STAGGER_MAX_ITEMS = 7;
const STAGGER_STEP = 0.04;

export interface StaggerProps {
  readonly children: ReactNode;
  /** 首项延迟。同一屏里有两组 Stagger 时，给第二组一个非零值才不会同时起步 */
  readonly delay?: number;
  readonly className?: string;
}

/**
 * 列表 / 卡片墙的依次入场。子项必须是 `motion` 组件并挂 `variants={staggerItem}`，
 * 因为这里下发的是 variants 而不是把 children 逐个 clone —— 克隆一层会让调用方的
 * ref / key / props 透传全断在中间。
 */
export function Stagger({ children, delay = 0, className }: StaggerProps) {
  return (
    <motion.div
      className={className}
      initial="initial"
      animate="animate"
      variants={{
        initial: {},
        animate: { transition: { staggerChildren: STAGGER_STEP, delayChildren: delay } },
      }}
    >
      {children}
    </motion.div>
  );
}

/** 给 `Stagger` 的直接子项用。第 7 项之后不再累加延迟 —— 20 张图要放到 800ms 后才太傻。 */
export const staggerItem = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: spring.bouncy },
} as const;
