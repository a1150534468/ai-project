import { useCallback, useState } from "react";
import { Icon } from "@iconify/react";
import { Modal, RippleButton } from "../motion";
import { buttonClass } from "./ui";

const PANEL = "mx-4 w-full max-w-sm rounded-2xl bg-surface p-6 shadow-lg";
const ACTION = { size: "lg", shape: "rounded", className: "flex-1" } as const;

/** 一次确认：问什么、确认后要跑什么活。文案给了默认值，危险操作换红按钮。 */
export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  /** 点「确认」后真正要做的事。抛错就留在弹窗里，让人能再点一次或者退出去 */
  readonly onConfirm: () => Promise<void> | void;
  readonly onCancel?: () => void;
  readonly confirmText?: string;
  readonly cancelText?: string;
  readonly isDangerous?: boolean;
}

/** 摆在屏幕上的那次确认：问题本身 + 谁在等答案 + 活是不是正在跑 */
interface Pending {
  readonly request: ConfirmRequest;
  readonly answer: (confirmed: boolean) => void;
  readonly running: boolean;
}

function ConfirmPanel({
  request,
  running,
  onCancel,
  onConfirm,
}: {
  readonly request: ConfirmRequest;
  readonly running: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    // 活正在跑的时候取消键是禁的，点遮罩和 Esc 也跟着禁：这时候「取消」只会把
    // 等答案的调用方放走，后台那笔活照样在跑，等于给了个假的撤销
    <Modal open onClose={running ? undefined : onCancel} label={request.title} className={PANEL}>

      <div className="mb-4 flex items-start gap-3">
        {request.isDangerous && <Icon icon="mdi:alert-circle" className="mt-1 flex-none text-xl text-danger-ink" />}
        <h2 className="text-lg font-semibold text-ink">{request.title}</h2>
      </div>

      <p className="mb-6 text-sm text-ink-secondary">{request.message}</p>

      <div className="flex gap-3">
        <RippleButton onClick={onCancel} disabled={running} className={buttonClass({ variant: "outline", ...ACTION })}>
          {request.cancelText || "取消"}
        </RippleButton>
        <RippleButton
          onClick={onConfirm}
          disabled={running}
          className={buttonClass({ variant: request.isDangerous ? "danger" : "primary", ...ACTION })}
        >
          {running && <Icon icon="mdi:loading" className="mr-1 inline animate-spin" />}
          {request.confirmText || "确认"}
        </RippleButton>
      </div>
    </Modal>
  );
}

/**
 * 把「弹个确认框」变成一句 await：`confirm(...)` 返回的 promise 等用户点完才落地，
 * 弹窗本体由返回的 `<Dialog />` 挂在调用方的树上。
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((answer) => {
        setPending({ request, answer, running: false });
      }),
    [],
  );

  // 关掉弹窗和放走等着的调用方是一件事，别分开做
  const settle = useCallback((current: Pending, confirmed: boolean) => {
    setPending(null);
    current.answer(confirmed);
  }, []);

  const Dialog = useCallback(() => {
    if (pending === null) return null;
    const { request } = pending;

    const cancel = () => {
      request.onCancel?.();
      settle(pending, false);
    };

    const run = async () => {
      setPending({ ...pending, running: true });
      try {
        await request.onConfirm();
        settle(pending, true);
      } catch {
        // 失败不关窗：收掉转圈让人能重试，同时先告诉调用方这次没成
        setPending({ ...pending, running: false });
        pending.answer(false);
      }
    };

    return <ConfirmPanel request={request} running={pending.running} onCancel={cancel} onConfirm={() => void run()} />;
  }, [pending, settle]);

  return { confirm, Dialog };
}
