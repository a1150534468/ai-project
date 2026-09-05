/**
 * `motion/` 的对外出口。这里只列真的有人 import 的东西 —— 不用 `export *`：
 * 桶文件把整个模块摊出去，谁在用哪一样就看不出来了，死代码也跟着一直留着。
 *
 * `Confetti`、`toastReducer`、`motionAmount` 之类只在模块内部用，不从这里导出；
 * 要直接测某个组件就按路径 import（测试里已有 `motion/Toast` 这种写法）。
 */
export { spring } from "./tokens";
export { msgIn, modalIn } from "./variants";
export { MotionRoot } from "./MotionRoot";
export { RippleButton } from "./RippleButton";
export { Modal } from "./Modal";
export { useDialog } from "./useDialog";
export { ToastProvider, useToast } from "./Toast";
export { BrandLogo } from "./BrandLogo";
