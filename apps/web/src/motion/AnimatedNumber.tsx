import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "motion/react";
import { easeOutCubic, formatCount } from "./anim";

export function AnimatedNumber({
  value,
  durationSec = 0.75,
  className,
}: {
  value: number;
  durationSec?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value); // 首帧即目标值，SSR 正确
  const prev = useRef(value);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (prev.current === value) return;
    if (reduced) {
      prev.current = value;
      setDisplay(value);
      return;
    }
    const from = prev.current;
    prev.current = value;
    const controls = animate(from, value, {
      duration: durationSec,
      ease: easeOutCubic,
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, durationSec, reduced]);

  return <span className={className}>{formatCount(display)}</span>;
}
