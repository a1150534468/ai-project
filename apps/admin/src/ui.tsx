import { useState, useCallback, useEffect, ReactNode } from "react";

export type ToastKind = "ok" | "err";
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: ToastKind } | null>(null);
  const show = useCallback((text: string, kind: ToastKind = "ok") => {
    setMsg({ text, kind });
    setTimeout(() => setMsg(null), 2500);
  }, []);
  const node = msg ? <div className={`toast ${msg.kind}`}>{msg.text}</div> : null;
  return { show, node };
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}
export function Field({ label, children }: FieldProps) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
      <span className="muted">{label}</span>
      {children}
    </label>
  );
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "操作失败";
}

/* === Modal === */
interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

export function Modal({ open, title, onClose, children, footer, width = "520px" }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-card" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/* === Drawer === */
interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, title, onClose, children, footer }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2 className="drawer-title">{title}</h2>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </div>
  );
}

/* === useConfirm === */
interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
}

interface ConfirmState {
  open: boolean;
  opts?: ConfirmOptions;
  resolve?: (value: boolean) => void;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState>({ open: false });

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({ open: true, opts, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (state.resolve) state.resolve(true);
    setState({ open: false });
  }, [state.resolve]);

  const handleCancel = useCallback(() => {
    if (state.resolve) state.resolve(false);
    setState({ open: false });
  }, [state.resolve]);

  const node = state.open && state.opts ? (
    <Modal
      open={true}
      title={state.opts.title || "确认"}
      onClose={handleCancel}
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" onClick={handleCancel}>
            取消
          </button>
          <button
            className={`btn ${state.opts.danger ? "danger" : ""}`}
            onClick={handleConfirm}
          >
            {state.opts.confirmText || "确认"}
          </button>
        </div>
      }
    >
      <p>{state.opts.message}</p>
    </Modal>
  ) : null;

  return { confirm, node };
}

/* === Pill === */
interface PillProps {
  kind: "g" | "w" | "b" | "n";
  children: ReactNode;
}

export function Pill({ kind, children }: PillProps) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

/* === Panel === */
interface PanelProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, actions, children }: PanelProps) {
  return (
    <div className="panel">
      <div className="panel-h">
        <h3>{title}</h3>
        {actions && <div style={{ marginLeft: "auto" }}>{actions}</div>}
      </div>
      <div style={{ padding: "16px" }}>{children}</div>
    </div>
  );
}

/* === Stat & StatStrip === */
interface StatProps {
  label: string;
  value: string | number;
  delta?: string | number;
  dotColor?: "up" | "down";
}

export function Stat({ label, value, delta, dotColor }: StatProps) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {delta !== undefined && (
        <div className={`d ${dotColor || ""}`}>
          {dotColor === "up" && "↑"} {dotColor === "down" && "↓"} {delta}
        </div>
      )}
    </div>
  );
}

interface StatStripProps {
  children: ReactNode;
}

export function StatStrip({ children }: StatStripProps) {
  return <div className="stats">{children}</div>;
}
