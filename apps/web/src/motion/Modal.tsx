/**
 * 通用弹窗：一层半透明遮罩 + 居中面板。开关由外面的 `open` 控制，
 * 面板长什么样全交给 `children`，这里只负责「浮上来、点外面关掉」。
 *
 * 键盘那三件事（Esc 关、焦点圈在面板内、关掉后还给触发按钮）在 `useDialog` 里，
 * 六处手搭的浮层用的也是同一个 hook。`label` 是必填的：没有可访问名，
 * 读屏软件念到这一层只会说一句「对话框」。
 */
import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDialog } from "./useDialog";
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
  /** 给 `undefined` 就是「这一刻不许关」：点遮罩和 Esc 一起失效，跟被禁掉的取消按钮对齐 */
  readonly onClose: (() => void) | undefined;
  /** 面板的可访问名，通常就是面板里那行标题 */
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Modal({ open, onClose, label, children, className }: ModalProps) {
  const dialogProps = useDialog({ open, onClose, label });

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
            {...dialogProps}
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
