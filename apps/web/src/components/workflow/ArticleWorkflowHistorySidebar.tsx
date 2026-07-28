import { Icon } from "@iconify/react";
import {
  shortPlatformLabel,
  type ArticleWorkflowBatchEntry,
  type ArticleWorkflowBatchStatus,
} from "./articleWorkflowBatchModel";
import { formatArticleWorkflowTime } from "./articleWorkflowStudioModel";

interface ArticleWorkflowHistorySidebarProps {
  readonly batches: readonly ArticleWorkflowBatchEntry[];
  readonly selectedBatchKey: string | null;
  readonly bootstrapping: boolean;
  readonly onNewProject: () => void;
  readonly onSelectBatch: (entry: ArticleWorkflowBatchEntry) => void;
}

const BATCH_STATUS_TEXT: Record<ArticleWorkflowBatchStatus, string> = {
  busy: "生成中",
  ready: "已完成",
  failed: "失败",
};

export function ArticleWorkflowHistorySidebar(props: ArticleWorkflowHistorySidebarProps) {
  return (
    <aside className="rounded-[18px] border border-[#e7e9f0] bg-white p-3 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <div>
          <h2 className="text-sm font-semibold text-[#14151a]">最近项目</h2>
          <p className="text-xs text-[#8a8f98]">按导入批次分组</p>
        </div>
        <button
          type="button"
          onClick={props.onNewProject}
          className="rounded-[10px] border border-[#d8dde6] px-3 py-1.5 text-xs font-semibold text-[#1d2433]"
        >
          新建
        </button>
      </div>

      <div className="grid gap-2">
        {props.bootstrapping && (
          <div className="rounded-[14px] border border-[#edf0f5] bg-[#fafbfe] px-3 py-4 text-sm text-[#667085]">
            加载中...
          </div>
        )}

        {!props.bootstrapping && props.batches.length === 0 && (
          <div className="rounded-[14px] border border-dashed border-[#dbe1ea] bg-[#fafbfe] px-3 py-5 text-sm text-[#667085]">
            还没有生成过图文。
          </div>
        )}

        {props.batches.map((item) => {
          const selected = item.key === props.selectedBatchKey;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => props.onSelectBatch(item)}
              className={`rounded-[14px] border px-3 py-3 text-left transition ${
                selected
                  ? "border-brand bg-[#eef8f5]"
                  : "border-[#edf0f5] bg-white "
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#14151a]">{item.title || "未命名图文"}</div>
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-[#667085]">{item.summary || "暂无摘要"}</div>
                </div>
                <Icon icon="mdi:chevron-right" className="mt-0.5 shrink-0 text-[#98a2b3]" aria-hidden />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {item.platforms.map((platform) => (
                  <span
                    key={platform}
                    className="rounded-full bg-[#f2f4f8] px-2 py-0.5 text-[11px] text-[#475467]"
                  >
                    {shortPlatformLabel(platform)}
                  </span>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[#8a8f98]">
                <span>{BATCH_STATUS_TEXT[item.status]}</span>
                <span>{formatArticleWorkflowTime(item.updatedAt)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
