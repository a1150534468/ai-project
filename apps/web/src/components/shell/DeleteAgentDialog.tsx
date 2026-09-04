import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { Modal, RippleButton } from "../../motion";

const PANEL = "mx-4 w-full max-w-sm rounded-2xl bg-surface p-6 shadow-lg";
const CANCEL = "flex-1 rounded-lg border border-hairline-subtle px-4 py-2 text-sm font-medium text-ink transition-colors";
const CONFIRM =
  "flex-1 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const NAME_INPUT = "h-10 w-full rounded-lg border border-hairline-subtle px-3 text-sm outline-none focus:border-danger";

interface DeleteAgentDialogProps {
  open: boolean;
  agentName: string;
  sessionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 删除 Agent 会级联删掉它名下所有对话与消息，不可恢复。
 * 有对话时要求原样输入 Agent 名称——这个入口藏在 ⋯ 菜单里，鼠标一滑就误点。
 */
export function DeleteAgentDialog({ open, agentName, sessionCount, onCancel, onConfirm }: DeleteAgentDialogProps) {
  const guarded = sessionCount > 0;
  const [typed, setTyped] = useState("");

  // 每次重新打开都从空白开始：上一次输了一半就关掉的名字不该留到下一个 Agent 身上
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  return (
    <Modal open={open} onClose={onCancel} className={PANEL}>
      <div className="mb-4 flex items-start gap-3">
        <Icon icon="mdi:alert-circle" className="mt-1 flex-none text-xl text-danger-ink" />
        <h2 className="text-lg font-semibold text-ink">删除「{agentName}」？</h2>
      </div>

      <p className="mb-4 text-sm text-ink-secondary">
        {guarded
          ? `将同时永久删除该 Agent 下的 ${sessionCount} 个对话及其全部消息，无法恢复。`
          : "该 Agent 还没有任何对话。删除后无法恢复。"}
      </p>

      {guarded && (
        <label className="mb-6 block">
          <span className="mb-1.5 block text-xs text-ink-secondary">请输入 Agent 名称以确认</span>
          <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={agentName} className={NAME_INPUT} />
        </label>
      )}

      <div className="flex gap-3">
        <RippleButton onClick={onCancel} className={CANCEL}>
          取消
        </RippleButton>
        {/* 抄名字这道闸只在有对话时落下；没有对话时删除键一直可用 */}
        <button type="button" onClick={onConfirm} disabled={guarded && typed !== agentName} className={CONFIRM}>
          删除
        </button>
      </div>
    </Modal>
  );
}
