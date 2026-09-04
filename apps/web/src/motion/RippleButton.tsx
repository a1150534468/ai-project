/**
 * 带水波纹的按钮。样式全靠外面传 `className`（配 `components/ui` 的 `buttonClass`），
 * 这里只管三件事：悬停微抬、按下微缩、点击处扩散一圈水波。
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { motionAmount, spring } from "./tokens";

interface Ripple {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** 一圈水波扩散淡尽要多久。 */
const RIPPLE_SECONDS = 0.6;

/** 多等 50ms 才把它从数组里摘掉：动画正好播完再卸元素，不会在最后一帧突然消失。 */
const RIPPLE_CLEANUP_MS = RIPPLE_SECONDS * 1000 + 50;

/**
 * 接 `motion` 自己的按钮 props，而不是手写一串 `Omit<ButtonHTMLAttributes, "onDrag" | ...>`：
 * 那串名单要跟着 motion 的 props 变，漏一个就是编译错误，而 motion 本来就导出了算好的版本。
 *
 * 挖掉四样：悬停 / 按下 / 弹簧由组件自己定，不接受外面覆盖（否则「全站手感统一」就没了）；
 * `children` 收窄回 `ReactNode` —— motion 允许把 `MotionValue` 当子节点，但这里的子节点和水波
 * 是并排渲染的普通 JSX，收不了那种值。
 */
export type RippleButtonProps = Omit<
  HTMLMotionProps<"button">,
  "whileHover" | "whileTap" | "transition" | "children"
> & {
  readonly children?: ReactNode;
};

function rippleStyle({ x, y, size }: Ripple): CSSProperties {
  return {
    position: "absolute",
    // 圆心对准点击点：定位到 (x, y) 之后再用负 margin 把自己拉回半径
    left: x,
    top: y,
    width: size,
    height: size,
    marginLeft: -size / 2,
    marginTop: -size / 2,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.5)",
    pointerEvents: "none",
  };
}

export function RippleButton({ children, className, onClick, style, ...rest }: RippleButtonProps) {
  const [ripples, setRipples] = useState<readonly Ripple[]>([]);
  const reducedMotion = useReducedMotion();
  // 递增序号当 key：同一毫秒内连点两下，用 e.timeStamp 会撞成同一个 id
  const seq = useRef(0);
  // 卸载时要把还没到点的清理定时器一并撤掉，否则 setState 会打在已卸载的组件上
  const pending = useRef<Set<number>>(new Set());

  useEffect(
    () => () => {
      for (const timer of pending.current) window.clearTimeout(timer);
      pending.current.clear();
    },
    [],
  );

  function spawnRipple(event: MouseEvent<HTMLButtonElement>): void {
    const box = event.currentTarget.getBoundingClientRect();
    const id = (seq.current += 1);
    // 直径取长边：从角上点也能铺满整个按钮
    const size = Math.max(box.width, box.height);

    setRipples((current) => [...current, { id, x: event.clientX - box.left, y: event.clientY - box.top, size }]);

    const timer = window.setTimeout(() => {
      pending.current.delete(timer);
      setRipples((current) => current.filter((ripple) => ripple.id !== id));
    }, RIPPLE_CLEANUP_MS);

    pending.current.add(timer);
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    // 减少动效时只透传点击，不铺水波
    if (!reducedMotion) spawnRipple(event);
    onClick?.(event);
  }

  return (
    <motion.button
      {...rest}
      className={className}
      onClick={handleClick}
      // 水波是绝对定位的子元素：容器必须自己成为定位上下文，还得裁掉溢出的那圈
      style={{ position: "relative", overflow: "hidden", ...style }}
      whileHover={reducedMotion ? undefined : { y: motionAmount.lift }}
      whileTap={reducedMotion ? undefined : { scale: motionAmount.press }}
      transition={spring.snappy}
    >
      {children}
      {ripples.map((ripple) => (
        <motion.span
          key={ripple.id}
          initial={{ opacity: 0.5, scale: 0 }}
          animate={{ opacity: 0, scale: 2.4 }}
          transition={{ duration: RIPPLE_SECONDS, ease: [0.22, 1, 0.36, 1] }}
          style={rippleStyle(ripple)}
        />
      ))}
    </motion.button>
  );
}
