import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { motionAmount, spring } from "./tokens";

interface Ripple {
  id: number;
  x: number;
  y: number;
  size: number;
}

type RippleButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
  | "onDragEnter"
  | "onDragLeave"
  | "onDragOver"
  | "onDrop"
>;

export function RippleButton({ children, className, onClick, style, ...rest }: RippleButtonProps) {
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const removalTimers = useRef<Set<number>>(new Set());
  const reduced = useReducedMotion();

  useEffect(
    () => () => {
      for (const timer of removalTimers.current) window.clearTimeout(timer);
      removalTimers.current.clear();
    },
    [],
  );

  const handle = (e: MouseEvent<HTMLButtonElement>) => {
    if (!reduced) {
      const r = e.currentTarget.getBoundingClientRect();
      const size = Math.max(r.width, r.height);
      const id = e.timeStamp;
      setRipples((p) => [...p, { id, x: e.clientX - r.left, y: e.clientY - r.top, size }]);
      const timer = window.setTimeout(() => {
        removalTimers.current.delete(timer);
        setRipples((p) => p.filter((x) => x.id !== id));
      }, 650);
      removalTimers.current.add(timer);
    }
    onClick?.(e);
  };

  const mergedStyle: CSSProperties = {
    position: "relative",
    overflow: "hidden",
    ...style,
  };

  return (
    <motion.button
      {...rest}
      className={className}
      onClick={handle}
      style={mergedStyle}
      whileHover={reduced ? undefined : { y: motionAmount.lift }}
      whileTap={reduced ? undefined : { scale: motionAmount.press }}
      transition={spring.snappy}
    >
      {children}
      {ripples.map((r) => (
        <motion.span
          key={r.id}
          initial={{ opacity: 0.5, scale: 0 }}
          animate={{ opacity: 0, scale: 2.4 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{
            position: "absolute",
            left: r.x,
            top: r.y,
            width: r.size,
            height: r.size,
            marginLeft: -r.size / 2,
            marginTop: -r.size / 2,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.5)",
            pointerEvents: "none",
          }}
        />
      ))}
    </motion.button>
  );
}
