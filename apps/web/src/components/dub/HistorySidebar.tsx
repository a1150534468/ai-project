import { Icon } from "@iconify/react";
import type { DubProject } from "../../dubApi";

const STAGE_LABEL: Record<string, { text: string; cls: string }> = {
  draft: { text: "草稿", cls: "bg-gray-100 text-ink-tertiary" },
  analyzed: { text: "已拆解", cls: "bg-gray-100 text-ink-tertiary" },
  scripted: { text: "已洗稿", cls: "bg-gray-100 text-ink-tertiary" },
  voiced: { text: "已配音", cls: "bg-brand/10 text-brand" },
  generating: { text: "成片中", cls: "bg-amber-50 text-amber-600" },
  mixing: { text: "配乐中", cls: "bg-amber-50 text-amber-600" },
  done: { text: "已完成", cls: "bg-brand text-white" },
  failed: { text: "失败", cls: "bg-red-50 text-red-500" },
};

export interface HistorySidebarProps {
  readonly projects: readonly DubProject[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onDelete: (id: string) => void;
}

export function HistorySidebar({ projects, activeId, onSelect, onCreate, onDelete }: HistorySidebarProps) {
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-3 border-r border-gray-100 pr-4">
      <button
        onClick={onCreate}
        className="flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-[13px] font-medium text-white "
      >
        <Icon icon="mdi:plus" className="text-base" /> 新建口播
      </button>

      <p className="px-1 text-[11.5px] font-medium text-ink-tertiary">历史任务</p>

      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {projects.length === 0 && <p className="px-1 text-[12px] text-ink-tertiary">还没有任务</p>}
        {projects.map((p) => {
          const on = p.id === activeId;
          const badge = STAGE_LABEL[p.stage] ?? STAGE_LABEL.draft;
          return (
            <div
              key={p.id}
              className={`group rounded-lg border px-2.5 py-2 transition-colors ${on ? "border-brand bg-brand/5" : "border-transparent "}`}
            >
              <button onClick={() => onSelect(p.id)} className="w-full text-left">
                <div className="flex items-center gap-1.5">
                  {p.finalVideoUrl && <Icon icon="mdi:play-circle-outline" className="shrink-0 text-[15px] text-brand" />}
                  <span className="truncate text-[13px] font-medium text-ink">{p.title}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                  <span className="text-[10.5px] text-ink-tertiary">{new Date(p.createdAt).toLocaleDateString()}</span>
                </div>
              </button>
              <button
                onClick={() => onDelete(p.id)}
                title="删除"
                className="mt-1 text-[11px] text-ink-tertiary opacity-100 transition-opacity "
              >
                <Icon icon="mdi:trash-can-outline" className="text-[13px]" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
