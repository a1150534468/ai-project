import { useState, useEffect } from "react";
import { Icon } from "@iconify/react";
import { Modal, RippleButton } from "../../motion";

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
  const [typed, setTyped] = useState("");
  useEffect(() => { if (open) setTyped(""); }, [open]);

  const needsTyping = sessionCount > 0;
  const canDelete = !needsTyping || typed === agentName;

  return (
    <Modal open={open} onClose={onCancel} className="mx-4 w-full max-w-sm rounded-2xl bg-surface p-6 shadow-lg">
      <div className="mb-4 flex items-start gap-3">
        <Icon icon="mdi:alert-circle" className="mt-1 flex-none text-xl text-red-500" />
        <h2 className="text-lg font-semibold text-ink">删除「{agentName}」？</h2>
      </div>

      <p className="mb-4 text-sm text-ink-secondary">
        {needsTyping
          ? `将同时永久删除该 Agent 下的 ${sessionCount} 个对话及其全部消息，无法恢复。`
          : "该 Agent 还没有任何对话。删除后无法恢复。"}
      </p>

      {needsTyping && (
        <label className="mb-6 block">
          <span className="mb-1.5 block text-xs text-ink-secondary">请输入 Agent 名称以确认</span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={agentName}
            className="h-10 w-full rounded-lg border border-hairline-subtle px-3 text-sm outline-none focus:border-red-400"
          />
        </label>
      )}

      <div className="flex gap-3">
        <RippleButton onClick={onCancel} className="flex-1 rounded-lg border border-hairline-subtle px-4 py-2 text-sm font-medium text-ink transition-colors ">
          取消
        </RippleButton>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canDelete}
          className="flex-1 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          删除
        </button>
      </div>
    </Modal>
  );
}
