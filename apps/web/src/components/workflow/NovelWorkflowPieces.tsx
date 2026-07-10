import { Icon } from "@iconify/react";
import type { NovelProjectSummary, NovelSection, NovelStageKind } from "../../api";

export const STAGE_OPTIONS: readonly { kind: NovelStageKind; label: string; icon: string }[] = [
  { kind: "settings", label: "设定", icon: "mdi:tune-variant" },
  { kind: "macro", label: "宏观", icon: "mdi:graph-outline" },
  { kind: "world", label: "世界观", icon: "mdi:earth" },
  { kind: "chars", label: "角色", icon: "mdi:account-group-outline" },
  { kind: "volumes", label: "卷纲", icon: "mdi:bookshelf" },
  { kind: "outline", label: "拆章", icon: "mdi:format-list-numbered" },
  { kind: "draft", label: "正文", icon: "mdi:file-document-edit-outline" },
  { kind: "style", label: "写法", icon: "mdi:feather" },
];

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ProjectList({
  projects,
  activeProjectId,
  onSelect,
}: {
  readonly projects: readonly NovelProjectSummary[];
  readonly activeProjectId?: string;
  readonly onSelect: (projectId: string) => void;
}) {
  return (
    <div className="grid max-h-[420px] gap-3 overflow-y-auto pr-1 [scrollbar-width:thin]">
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          onClick={() => onSelect(project.id)}
          className={`min-h-[76px] rounded-[12px] border px-4 py-3 text-left transition ${
            project.id === activeProjectId
              ? "border-brand/45 bg-brand-soft text-brand-ink shadow-[0_8px_24px_rgba(0,184,169,0.10)]"
              : "border-[#e8e8ed] bg-white text-[#1d1d1f] hover:border-brand/30 hover:bg-[#fbfefd]"
          }`}
        >
          <span className="flex min-w-0 items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold">{project.title}</span>
              <span className="mt-1 block truncate text-xs text-[#6e6e73]">{project.genre || "未设题材"} · {formatTime(project.updatedAt)}</span>
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${project.status === "active" ? "bg-brand-soft text-brand-ink" : "bg-gray-100 text-gray-500"}`}>
              {project.status === "active" ? "创作中" : project.status}
            </span>
          </span>
        </button>
      ))}
      {projects.length === 0 && (
        <div className="rounded-[10px] border border-dashed border-[#d2d2d7] bg-[#f7faf9] px-3 py-6 text-center text-xs text-[#8a8a8f]">
          暂无小说项目
        </div>
      )}
    </div>
  );
}

export function StageList({
  sections,
  selectedStage,
  onSelect,
}: {
  readonly sections: readonly NovelSection[];
  readonly selectedStage: NovelStageKind;
  readonly onSelect: (kind: NovelStageKind) => void;
}) {
  return (
    <div className="grid gap-2">
      {STAGE_OPTIONS.map((stage) => {
        const section = sections.find((item) => item.kind === stage.kind);
        const active = selectedStage === stage.kind;
        return (
          <button
            key={stage.kind}
            type="button"
            onClick={() => onSelect(stage.kind)}
            className={`flex min-h-14 items-center gap-3 rounded-[10px] border px-3 text-left transition ${
              active ? "border-brand/40 bg-brand-soft text-brand-ink" : "border-[#e8e8ed] bg-white hover:border-brand/30"
            }`}
          >
            <Icon icon={stage.icon} className="text-xl" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{stage.label}</span>
              <span className="block truncate text-xs text-[#6e6e73]">{section?.billableChars ?? 0} 字 · {section?.status ?? "empty"}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
