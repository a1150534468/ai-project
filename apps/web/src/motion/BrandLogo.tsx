import { motion, useReducedMotion } from "motion/react";
import logo from "../assets/brand-logo.svg";

export function BrandLogo({ size = 40 }: { size?: number }) {
  const reduced = useReducedMotion();
  return (
    <motion.img
      src={logo}
      alt="AI 助手"
      width={size}
      height={size}
      style={{ borderRadius: 11, boxShadow: "0 6px 16px rgba(10,132,255,0.28)" }}
      animate={reduced ? undefined : { y: [0, -5, 0], rotate: [-2, 2, -2] }}
      transition={reduced ? undefined : { duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      whileHover={reduced ? undefined : { scale: 1.12, rotate: -6, transition: { duration: 0.3 } }}
    />
  );
}
