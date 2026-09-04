/**
 * 成功提示附带的一次纸屑爆开。纯装饰，出错时不放。
 * 挂在 `ToastProvider` 里，`trigger` 就是「当前有没有一条成功提示」。
 */
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * 装饰性动效（纸屑、粒子、光扫）在用户要求减少动效时一律不渲染。
 * `useReducedMotion()` 是三态：`null` 表示还没测出来（SSR、首帧），这时按「照常渲染」处理 ——
 * 只有明确要求减少动效才关掉，所以这里比的是 `=== true` 而不是取真值。
 */
export function shouldRenderDecoration(reducedMotion: boolean | null): boolean {
  return reducedMotion !== true;
}

const COLORS = ["#0066cc", "#2997ff", "#ffd60a", "#ff375f", "#64d2ff"];

/**
 * 26 片纸屑的落点在模块加载时算一次，不在每次渲染里重算。
 * 刻意用 `i % 7` / `i % 5` 而不是 `Math.random()`：两个互质的周期错开就足够乱，
 * 而确定性意味着同一次爆开重渲染时纸屑不会瞬移。
 */
const PIECES = Array.from({ length: 26 }, (_unused, index) => ({
  color: COLORS[index % COLORS.length],
  driftX: -80 - (index % 7) * 30,
  driftY: 120 + (index % 5) * 40,
  spin: 360 + index * 20,
}));

export function Confetti({ trigger }: { trigger: boolean }) {
  const reducedMotion = useReducedMotion();
  const allowed = trigger && shouldRenderDecoration(reducedMotion);
  /**
   * 每次重新触发换一个 key，让 26 片整体重挂、动画从头播。
   * 初始 0 表示 effect 还没跑过：首帧先不画，纸屑就不会在「挂载」与「重挂」之间闪两遍。
   */
  const [burst, setBurst] = useState(0);

  useEffect(() => {
    if (allowed) setBurst((previous) => previous + 1);
  }, [allowed]);

  if (!allowed || burst === 0) return null;

  return (
    <div style={{ position: "fixed", right: 60, bottom: 70, zIndex: 80, pointerEvents: "none" }}>
      {PIECES.map((piece, index) => (
        <motion.span
          key={`${burst}-${index}`}
          initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
          animate={{ x: piece.driftX, y: piece.driftY, rotate: piece.spin, opacity: 0 }}
          transition={{ duration: 1.6, ease: [0.3, 0.7, 0.4, 1] }}
          style={{ position: "absolute", width: 8, height: 8, borderRadius: 2, background: piece.color }}
        />
      ))}
    </div>
  );
}
