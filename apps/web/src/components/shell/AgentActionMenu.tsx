import { useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { AgentAvatar } from "../AgentAvatar";
import type { AgentRailItem } from "../../shellState";

interface AgentActionMenuProps {
  agent: AgentRailItem;
  busy: boolean;
  onRegenerate: () => void;
  onUpload: (file: File) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

/** ⋯ 面板。只对 type === "custom" 的 Agent 渲染——预设助手的图标是全局资源，只读。 */
export function AgentActionMenu({ agent, busy, onRegenerate, onUpload, onRename, onDelete }: AgentActionMenuProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(agent.name);

  const submitRename = () => {
    const next = draft.trim();
    if (next && next !== agent.name) onRename(next);
    setRenaming(false);
  };

  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-600 transition-colors  disabled:opacity-40";

  return (
    <div className="min-w-[172px] rounded-xl border border-gray-100 bg-surface p-2 shadow-[0_8px_28px_rgba(0,0,0,0.13)]">
      <div className="flex justify-center py-2">
        <AgentAvatar avatarUrl={agent.avatarUrl} avatarSvg={agent.avatarSvg} icon={agent.icon} size={64} name={agent.name} />
      </div>

      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => { if (e.key === "Enter") submitRename(); if (e.key === "Escape") setRenaming(false); }}
          maxLength={40}
          className="mb-1 h-8 w-full rounded-md border border-gray-200 px-2 text-xs outline-none focus:border-brand"
        />
      ) : (
        <p className="mb-1 truncate px-2 text-center text-xs font-semibold text-gray-800">{agent.name}</p>
      )}

      <button type="button" className={row} disabled={busy} onClick={onRegenerate}>
        <Icon icon="mdi:refresh" className={`flex-none text-base ${busy ? "animate-spin" : ""}`} aria-hidden />
        <span>换一个 AI 头像</span>
      </button>

      <button type="button" className={row} disabled={busy} onClick={() => fileRef.current?.click()}>
        <Icon icon="mdi:tray-arrow-up" className="flex-none text-base" aria-hidden />
        <span>上传图片</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // 允许连续选同一个文件
          if (file) onUpload(file);
        }}
      />

      <button type="button" className={row} disabled={busy} onClick={() => { setDraft(agent.name); setRenaming(true); }}>
        <Icon icon="mdi:pencil-outline" className="flex-none text-base" aria-hidden />
        <span>重命名</span>
      </button>

      <div className="my-1 h-px bg-gray-100" />

      <button type="button" className={`${row} text-red-600 `} disabled={busy} onClick={onDelete}>
        <Icon icon="mdi:trash-can-outline" className="flex-none text-base" aria-hidden />
        <span>删除 Agent</span>
      </button>
    </div>
  );
}
