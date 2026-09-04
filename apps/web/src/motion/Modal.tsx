/**
 * 通用弹窗：一层半透明遮罩 + 居中面板。开关由外面的 `open` 控制，
 * 面板长什么样全交给 `children`，这里只负责「浮上来、点外面关掉」。
 *
 * 键盘无障碍（Esc 关闭、焦点圈在面板内、关掉后焦点还给触发按钮）目前都没做，
 * 四个调用方各自靠自己的取消按钮 —— 要补得先让调用方传一个可访问名，别在这里悄悄加。
 */
import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { modalIn } from "./variants";

/** 遮罩铺满视口并把面板居中。留一圈 padding，小屏上面板不会顶到边。 */
const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "rgba(15,23,42,0.28)",
  backdropFilter: "blur(3px)",
};

interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Modal({ open, onClose, children, className }: ModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          style={OVERLAY_STYLE}
        >
          {/* 面板只接进场：退场时整层遮罩在淡出，面板再自己缩一次两个动画会打架
              （`modalIn.exit` 不是没人用，pages/Memory.tsx 那个抽屉走的就是它） */}
          <motion.div
            variants={modalIn}
            initial="initial"
            animate="animate"
            className={className}
            // 面板内的点击不能冒到遮罩上，否则点面板里任何地方都会关窗
            onClick={(event) => event.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
