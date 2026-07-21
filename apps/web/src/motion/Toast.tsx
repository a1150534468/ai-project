import { createContext, useCallback, useContext, useReducer, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toastReducer, type ToastKind } from "./anim";
import { toastIn } from "./variants";
import { Confetti } from "./Confetti";

interface ToastApi { show: (kind: ToastKind, text: string) => void; }
const ToastCtx = createContext<ToastApi | null>(null);

let seq = 0;
const nextId = () => `t${seq++}`;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(toastReducer, { items: [] });
  const hasOk = state.items.some((t) => t.kind === "ok");

  const show = useCallback((kind: ToastKind, text: string) => {
    const id = nextId();
    dispatch({ type: "add", toast: { id, kind, text } });
    window.setTimeout(() => dispatch({ type: "remove", id }), 2600);
  }, []);

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div style={{ position: "fixed", right: 22, bottom: 22, zIndex: 60, display: "flex", flexDirection: "column", gap: 10 }}>
        <AnimatePresence>
          {state.items.map((t) => (
            <motion.div
              key={t.id}
              variants={toastIn}
              initial="initial"
              animate="animate"
              exit="exit"
              className="glass-card"
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 15px", fontSize: 13, fontWeight: 600 }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: "50%", display: "grid", placeItems: "center",
                color: "#fff", background: t.kind === "ok" ? "var(--accent-primary,#0066cc)" : "#dc2626",
              }}>{t.kind === "ok" ? "✓" : "!"}</span>
              {t.text}
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
