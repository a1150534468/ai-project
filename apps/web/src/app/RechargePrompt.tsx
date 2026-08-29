/**
 * 余额不足提示。触发点只有一个:对话流回了 `INSUFFICIENT_BALANCE`。
 * 从 `App.tsx` 原样搬出的一段 JSX,行为不变:「稍后再说」只关弹窗,「去充值」关弹窗并跳计费页。
 */
import { Modal } from "../motion";

export function RechargePrompt({
  open,
  onClose,
  onRecharge,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRecharge: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} className="w-[90vw] max-w-sm rounded-2xl bg-surface p-6 shadow-xl">
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-2xl text-brand">
          ⚡
        </div>
        <h3 className="text-lg font-bold text-ink">余额不足</h3>
        <p className="mt-2 text-sm text-ink-secondary">当前算力点余额不足以发起本次对话，请充值算力点后重试。</p>
        <div className="mt-6 flex w-full gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-full border border-hairline-subtle py-2.5 text-sm font-medium text-ink-secondary transition-colors "
          >
            稍后再说
          </button>
          <button
            onClick={onRecharge}
            className="flex-1 rounded-full bg-brand py-2.5 text-sm font-medium text-white transition-opacity "
          >
            去充值
          </button>
        </div>
      </div>
    </Modal>
  );
}
