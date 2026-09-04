/**
 * 全站提示条。`ToastProvider` 挂在 `main.tsx` 最里层，任何组件 `useToast().show("ok", "已保存")`
 * 就弹一条，2.6 秒后自己退场；成功提示还会顺带撒一次纸屑。
 *
 * 状态用 reducer 而不是 `useState`：删除发生在 2.6 秒后的定时器回调里，
 * 那时候闭包捕获的数组早就旧了 —— 走 reducer 才不会把这期间新弹的提示一起抹掉。
 */
import { createContext, useCallback, useContext, useReducer, useRef, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Confetti } from "./Confetti";
import { toastIn } from "./variants";

export type ToastKind = "ok" | "err";

export interface ToastItem {
  readonly id: string;
  readonly kind: ToastKind;
  readonly text: string;
}

/** 状态就是当前挂着的这几条，不再包一层 `{ items }` —— 那层对象没有第二个字段要放。 */
export type ToastState = readonly ToastItem[];

export type ToastAction =
  | { readonly type: "add"; readonly toast: ToastItem }
  | { readonly type: "remove"; readonly id: string };

export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "add":
      return [...state, action.toast];
    case "remove":
      return state.filter((item) => item.id !== action.id);
  }
}

/** 每条停留多久。时间一到 dispatch remove，退场动画由 `AnimatePresence` 接手。 */
const VISIBLE_MS = 2600;

/** 提示堆在右下角。固定定位 + 高 z-index：聊天区滚动时它不能跟着走。 */
const STACK_STYLE: CSSProperties = {
  position: "fixed",
  right: 22,
  bottom: 22,
  zIndex: 60,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "11px 15px",
  fontSize: 13,
  fontWeight: 600,
};

/** 两种提示只差一个图标和底色，列成表 —— 以后加「警告」也只是多一行。 */
const BADGE = {
  ok: { glyph: "✓", background: "var(--accent-primary,#0066cc)" },
  err: { glyph: "!", background: "#dc2626" },
} as const satisfies Record<ToastKind, { glyph: string; background: string }>;

const BADGE_STYLE: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  color: "#fff",
};

interface ToastApi {
  show: (kind: ToastKind, text: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, [] as ToastState);
  // 序号只要在这一个 provider 内不重复就够。用 ref 而不是模块级计数器：测试里反复挂载不会串号
  const seq = useRef(0);

  const show = useCallback((kind: ToastKind, text: string) => {
    const id = `t${(seq.current += 1)}`;

    dispatch({ type: "add", toast: { id, kind, text } });
    window.setTimeout(() => dispatch({ type: "remove", id }), VISIBLE_MS);
  }, []);

  // 有成功提示就撒纸屑。挂在 provider 上而不是每条提示里 —— 连着成功两次只该撒一轮
  const hasOk = toasts.some((item) => item.kind === "ok");

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {/* aria-live 让读屏软件念出来：提示只出现 2.6 秒，光靠视觉的用户看不到 */}
      <div style={STACK_STYLE} role="status" aria-live="polite">
        <AnimatePresence>
          {toasts.map((item) => (
            <motion.div
              key={item.id}
              variants={toastIn}
              initial="initial"
              animate="animate"
              exit="exit"
              className="glass-card"
              style={ROW_STYLE}
            >
              <span style={{ ...BADGE_STYLE, background: BADGE[item.kind].background }}>{BADGE[item.kind].glyph}</span>
              {item.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {hasOk && <Confetti trigger={hasOk} />}
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast 必须在 ToastProvider 内使用");

  return ctx;
}
