import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const CLOSE_DELAY_MS = 150;
const OFFSET_X = 8;
const MAX_POPOVER_HEIGHT = 320;

interface PopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface HoverPopoverProps {
  children: ReactNode;              // 锚点
  content: ReactNode;               // 浮层内容
  disabled?: boolean;               // 展开态的侧边栏不需要浮层
  className?: string;
}

/**
 * hover 浮层原语。锚点与浮层本体共享同一个 hover 区，离开后延迟 150ms 关闭——
 * 否则鼠标从图标斜着划向浮层的那一瞬间会穿过空隙，浮层闪一下就没了（经典 hover 三角问题）。
 * 浮层用 portal 渲染到 document.body，避免被祖先 overflow-hidden 裁剪。
 */
export function HoverPopover({ children, content, disabled = false, className = "" }: HoverPopoverProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<PopoverRect | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reduce = useReducedMotion();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const show = () => {
    if (disabled) return;
    if (timer.current) clearTimeout(timer.current);
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setAnchorRect({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      });
    }
    setOpen(true);
  };
  const scheduleClose = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  // 计算浮层的位置，防止超出视口底部
  const popoverTop = anchorRect
    ? Math.min(anchorRect.top, window.innerHeight - MAX_POPOVER_HEIGHT)
    : 0;
  const popoverLeft = anchorRect ? anchorRect.right + OFFSET_X : 0;

  return (
    <div className={`relative ${className}`}>
      <div ref={anchorRef} onMouseEnter={show} onMouseLeave={scheduleClose}>
        {children}
      </div>
      {open && anchorRect && createPortal(
        <AnimatePresence>
          <motion.div
            onMouseEnter={show}
            onMouseLeave={scheduleClose}
            initial={reduce ? false : { opacity: 0, scale: 0.96, x: -4 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.96, x: -4 }}
            transition={{ duration: 0.14 }}
            style={{
              transformOrigin: "left center",
              position: "fixed",
              left: `${popoverLeft}px`,
              top: `${popoverTop}px`,
              zIndex: 50,
              pointerEvents: "auto",
            }}
          >
            {content}
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
