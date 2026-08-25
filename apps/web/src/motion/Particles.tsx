import { motion, useReducedMotion } from "motion/react";
import { shouldRenderDecoration } from "./anim";

const SPARK_COLORS = ["#7fffd8", "#ffd66b"];

export function SpendBurst({
  amount, originX, originY, active,
}: { amount: number; originX: number; originY: number; active: boolean }) {
  const reduced = useReducedMotion();
  if (!active) return null;

  const showParticles = shouldRenderDecoration(reduced);

  return (
    <div style={{ position: "fixed", left: originX, top: originY, zIndex: 70, pointerEvents: "none" }}>
      <motion.div
        initial={{ opacity: 0, y: 6, scale: 0.9 }}
        animate={{ opacity: [0, 1, 0], y: -40, scale: 1 }}
        transition={{ duration: 1 }}
        style={{ fontWeight: 800, fontSize: 15, color: "rgb(var(--color-danger))" }}
      >
        -{amount}
      </motion.div>
      {showParticles && Array.from({ length: 14 }).map((_, i) => {
        const ang = (i / 14) * Math.PI * 2;
        const dist = 30 + (i % 5) * 12;
        return (
          <motion.span
            key={i}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist - 20, opacity: 0, scale: 0 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            style={{ position: "absolute", width: 5, height: 5, borderRadius: "50%", background: SPARK_COLORS[i % 2] }}
          />
        );
      })}
    </div>
  );
}
