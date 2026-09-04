import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";

const CLOSE_DELAY_MS = 150;
const OFFSET_X = 8;
const MAX_POPOVER_HEIGHT = 320;

/** 浮层左上角在视口中的落点（fixed 定位，px）。null 即未展开 —— 位置与开合是同一份状态。 */
interface Placement {
  readonly left: number;
  readonly top: number;
}

interface HoverPopoverProps {
  /** 锚点 */
  children: ReactNode;
  /** 浮层内容 */
  content: ReactNode;
  /** 展开态的侧边栏不需要浮层 */
  disabled?: boolean;
  className?: string;
}

/** 浮层贴锚点右侧、顶边对齐；快贴到视口底部时上推，保证整屏浮层放得下。 */
function placeBeside(anchor: HTMLElement): Placement {
  const rect = anchor.getBoundingClientRect();
  return {
    left: rect.right + OFFSET_X,
    top: Math.min(rect.top, window.innerHeight - MAX_POPOVER_HEIGHT),
  };
}

/**
 * hover 浮层原语。锚点与浮层本体共用一套开合：离开任意一边都只是「预约关闭」，
 * 150ms 内进到另一边就把预约撤掉 —— 否则鼠标从图标斜着划向浮层的那一瞬会穿过
 * 两者之间的空隙，浮层闪一下就没了（经典 hover 三角问题）。
 *
 * 浮层 portal 到 document.body：侧边栏整条是 overflow-hidden 的，留在原地会被裁掉。
 */
export function HoverPopover({ children, content, disabled = false, className = "" }: HoverPopoverProps) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reduce = useReducedMotion();

  const abortClose = useCallback(() => {
    if (closeTimer.current === undefined) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  // 卸载时把还没到点的关闭预约收掉，别往已销毁的组件里 setState
  useEffect(() => abortClose, [abortClose]);

  const openAtAnchor = () => {
    if (disabled) return;
    abortClose();
    if (anchorRef.current) setPlacement(placeBeside(anchorRef.current));
  };

  const closeLater = () => {
    abortClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined;
      setPlacement(null);
    }, CLOSE_DELAY_MS);
  };

  return (
    <div className={`relative ${className}`}>
      <div ref={anchorRef} onMouseEnter={openAtAnchor} onMouseLeave={closeLater}>
        {children}
      </div>
      {placement &&
        createPortal(
          <motion.div
            // 进浮层只撤销关闭预约，不重算位置：重算会让浮层在鼠标进来的瞬间轻微跳一下
            onMouseEnter={abortClose}
            onMouseLeave={closeLater}
            initial={reduce ? false : { opacity: 0, scale: 0.96, x: -4 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            transition={{ duration: 0.14 }}
            style={{
              position: "fixed",
              left: placement.left,
              top: placement.top,
              zIndex: 50,
              transformOrigin: "left center",
              pointerEvents: "auto",
            }}
          >
            {content}
          </motion.div>,
          document.body,
        )}
    </div>
  );
}
