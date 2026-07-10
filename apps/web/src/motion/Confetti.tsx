import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { shouldRenderDecoration } from "./anim";

const COLORS = ["#00b8a9", "#3ec6ff", "#ffd66b", "#ff7a9c", "#7fffd8"];

export function Confetti({ trigger }: { trigger: boolean }) {
  const reduced = useReducedMotion();
  const [burstKey, setBurstKey] = useState(0);

  useEffect(() => {
    if (trigger && shouldRenderDecoration(reduced)) setBurstKey((k) => k + 1);
  }, [trigger, reduced]);

  if (!trigger || !shouldRenderDecoration(reduced) || burstKey === 0) return null;

  return (
    <div style={{ position: "fixed", right: 60, bottom: 70, zIndex: 80, pointerEvents: "none" }}>
      {Array.from({ length: 26 }).map((_, i) => (
        <motion.span
          key={`${burstKey}-${i}`}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
          animate={{
            x: -80 - (i % 7) * 30, y: 120 + (i % 5) * 40, opacity: 0, rotate: 360 + i * 20,
          }}
          transition={{ duration: 1.6, ease: [0.3, 0.7, 0.4, 1] }}
          style={{
            position: "absolute", width: 8, height: 8, borderRadius: 2,
            background: COLORS[i % COLORS.length],
          }}
        />
      ))}
    </div>
  );
}
