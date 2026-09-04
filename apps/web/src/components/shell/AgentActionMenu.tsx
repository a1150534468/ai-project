import { Fragment, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { cx } from "../ui";
import { AgentAvatar } from "../AgentAvatar";
import type { AgentRailItem } from "../../shellState";

const CARD = "min-w-[172px] rounded-xl border border-hairline-subtle bg-surface p-2 shadow-[0_8px_28px_rgba(0,0,0,0.13)]";
const ROW = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-secondary transition-colors disabled:opacity-40";
const NAME_INPUT = "mb-1 h-8 w-full rounded-md border border-hairline-subtle px-2 text-xs outline-none focus:border-brand";

/** 重命名输入框的上限，与后端 agent 名长度校验对齐 */
const NAME_MAX = 40;

const UPLOAD_TYPES = "image/png,image/jpeg,image/webp";

interface AgentActionMenuProps {
  agent: AgentRailItem;
  busy: boolean;
  onRegenerate: () => void;
  onUpload: (file: File) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

/** 一行操作。列表化是为了让「图标 + 文案 + 回调」三件事只在一个地方对齐。 */
interface MenuAction {
  readonly icon: string;
  readonly label: string;
  readonly run: () => void;
  /** 危险操作的额外配色 */
  readonly tone?: string;
  /** 图标是否随 busy 转圈 */
  readonly spins?: boolean;
  /** 这一行之前压一条分隔线 */
  readonly ruled?: boolean;
}

/** ⋯ 面板。只对 type === "custom" 的 Agent 渲染——预设助手的图标是全局资源，只读。 */
export function AgentActionMenu({ agent, busy, onRegenerate, onUpload, onRename, onDelete }: AgentActionMenuProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);

  // draft 为 null 表示不在重命名态 —— 开合与草稿是同一份状态，不会出现「在编辑但草稿是旧名字」
  const commitRename = () => {
    const next = draft?.trim();
    if (next && next !== agent.name) onRename(next);
    setDraft(null);
  };

  const actions: readonly MenuAction[] = [
    { icon: "mdi:refresh", label: "换一个 AI 头像", run: onRegenerate, spins: true },
    { icon: "mdi:tray-arrow-up", label: "上传图片", run: () => fileRef.current?.click() },
    { icon: "mdi:pencil-outline", label: "重命名", run: () => setDraft(agent.name) },
    { icon: "mdi:trash-can-outline", label: "删除 Agent", run: onDelete, tone: "text-danger-ink", ruled: true },
  ];

  return (
    <div className={CARD}>
      <div className="flex justify-center py-2">
        <AgentAvatar avatarUrl={agent.avatarUrl} avatarSvg={agent.avatarSvg} icon={agent.icon} size={64} name={agent.name} />
      </div>

      {draft === null ? (
        <p className="mb-1 truncate px-2 text-center text-xs font-semibold text-ink">{agent.name}</p>
      ) : (
        <input
          autoFocus
          value={draft}
          maxLength={NAME_MAX}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") setDraft(null);
          }}
          className={NAME_INPUT}
        />
      )}

      {actions.map((action) => (
        <Fragment key={action.label}>
          {action.ruled && <div className="my-1 h-px bg-surface-muted" />}
          <button type="button" className={cx(ROW, action.tone)} disabled={busy} onClick={action.run}>
            <Icon icon={action.icon} className={cx("flex-none text-base", action.spins && busy && "animate-spin")} aria-hidden />
            <span>{action.label}</span>
          </button>
        </Fragment>
      ))}

      <input
        ref={fileRef}
        type="file"
        accept={UPLOAD_TYPES}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // 清空才能连着选同一个文件
          if (file) onUpload(file);
        }}
      />
    </div>
  );
}
