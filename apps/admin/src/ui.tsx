import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/*
 * 后台的一套 UI 原语：错误文案、toast、弹窗、确认、面板、徽标、指标卡。
 * 只服务 apps/admin 内部。样式一律落在 index.css 的对应小节，这里不写内联样式
 * （唯一例外是 Modal 的 width —— 它由调用方按内容宽度决定）。
 */

/** 拼 className：滤掉 false/空值，不留 "btn " 这种尾随空格。 */
function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const FALLBACK_ERROR = "操作失败";

/** 把 catch 到的任意值收敛成一句能直接贴到 toast 上的话。 */
export function errMsg(cause: unknown): string {
  if (cause instanceof Error) return cause.message.trim() || FALLBACK_ERROR;
  if (typeof cause === "string") return cause.trim() || FALLBACK_ERROR;
  return FALLBACK_ERROR;
}

/* ——— toast ——— */

export type ToastKind = "ok" | "err";

const TOAST_MS = 2500;

interface Toast {
  /** 每次 show 自增，当 key 用，让入场动画重播 */
  seq: number;
  text: string;
  kind: ToastKind;
}

export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // 卸载时收掉还没到点的定时器，别往已销毁的组件里 setState
  useEffect(() => stopTimer, [stopTimer]);

  const show = useCallback(
    (text: string, kind: ToastKind = "ok") => {
      stopTimer();
      setToast((prev) => ({ seq: (prev?.seq ?? 0) + 1, text, kind }));
      timer.current = setTimeout(() => {
        timer.current = null;
        setToast(null);
      }, TOAST_MS);
    },
    [stopTimer],
  );

  const node = toast && (
    <div key={toast.seq} className={cx("toast", toast.kind)} role="status">
      {toast.text}
    </div>
  );

  return { show, node };
}

/* ——— 弹窗 ——— */

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

/** open 期间才挂 Esc 监听，关掉就摘掉。 */
/** 开着的浮层按 Esc 收起。Modal 与窄屏侧栏抽屉共用这一份。 */
export function useEscapeKey(open: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onEscape]);
}

export function Modal({ open, title, onClose, children, footer, width = "520px" }: ModalProps) {
  useEscapeKey(open, onClose);
  if (!open) return null;
  return (
    // 点遮罩关闭；卡片这层把冒泡截断，点卡片内部不会顺手关掉
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal-card"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ——— 确认 ——— */

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
}

/**
 * 把「弹个确认框」变成一次 await。
 * 前一问还悬着又来一问时，旧 promise 按「取消」收尾 —— 否则它永远不 resolve，
 * 调用方的 await 就卡在那里了。
 */
export function useConfirm() {
  const [asked, setAsked] = useState<ConfirmOptions | null>(null);
  const reply = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const resolve = reply.current;
    reply.current = null;
    setAsked(null);
    resolve?.(ok);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    reply.current?.(false);
    setAsked(opts);
    return new Promise<boolean>((resolve) => {
      reply.current = resolve;
    });
  }, []);

  const node = asked && (
    <Modal
      open
      title={asked.title || "确认"}
      onClose={() => settle(false)}
      footer={
        <div className="modal-footer-actions">
          <button type="button" className="btn ghost" onClick={() => settle(false)}>
            取消
          </button>
          <button
            type="button"
            className={cx("btn", asked.danger && "danger")}
            onClick={() => settle(true)}
          >
            {asked.confirmText || "确认"}
          </button>
        </div>
      }
    >
      <p>{asked.message}</p>
    </Modal>
  );

  return { confirm, node };
}

/* ——— 静态外壳 ——— */

/** 表单一行：标签在上、控件在下。 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="muted">{label}</span>
      {children}
    </label>
  );
}

/** 状态徽标的四档配色。审计页要按动作码算出档位，所以这个联合得有名字。 */
export type PillKind = "g" | "w" | "b" | "n";

/** 状态徽标：g 成功 / w 警告 / b 失败 / n 中性。 */
export function Pill({ kind, children }: { kind: PillKind; children: ReactNode }) {
  return <span className={cx("pill", kind)}>{children}</span>;
}

/** 带标题栏的内容面板，actions 贴在标题右侧。 */
export function Panel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-h">
        <h3>{title}</h3>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-b">{children}</div>
    </section>
  );
}

/** 单个指标；横排一组用 StatStrip 包起来，发丝分隔线由 .stats 的 1px 间隙画出。 */
export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>;
}
