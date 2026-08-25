import { Icon } from "@iconify/react";
import { fallbackTitle, getMemoryTypeMeta } from "../../memoryGalaxy";
import type { MemoryNode } from "../../memoryTypes";
import { MEMORY_TYPE_STYLES } from "./memoryStyles";

interface MemoryMobileListProps {
  readonly nodes: readonly MemoryNode[];
  readonly selectedId: string | null;
  readonly highlightedIds: readonly string[];
  readonly loading: boolean;
  readonly error: string;
  readonly onSelectNode: (id: string) => void;
}

export default function MemoryMobileList({
  nodes,
  selectedId,
  highlightedIds,
  loading,
  error,
  onSelectNode,
}: MemoryMobileListProps) {
  if (loading) {
    return (
      <div className="flex min-h-[260px] items-center justify-center rounded-[14px] border border-hairline bg-surface px-4 py-8">
        <div className="flex items-center gap-3 text-sm text-ink-secondary">
          <Icon icon="mdi:loading" className="animate-spin text-lg text-brand" />
          正在加载记忆列表...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[14px] border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700">
        <div className="flex items-start gap-3">
          <Icon icon="mdi:alert-circle-outline" className="mt-0.5 text-xl" />
          <div>
            <p className="font-medium">记忆列表加载失败</p>
            <p className="mt-1 text-red-600/90">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="rounded-[14px] border border-hairline bg-surface px-4 py-10 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-brand">
          <Icon icon="mdi:atom-variant" className="text-2xl" />
        </div>
        <p className="mt-4 text-base font-semibold text-ink">当前筛选下没有记忆</p>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          调整类型筛选或开始更多对话，让新的内容进入你的长期记忆。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-28">
      {nodes.map((node) => {
        const tone = MEMORY_TYPE_STYLES[node.type];
        const isSelected = node.id === selectedId;
        const isHighlighted = highlightedIds.includes(node.id);
        const displayTitle = fallbackTitle(node.title, node.text);

        return (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
            className={`w-full rounded-[14px] border border-l-4 bg-surface p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
              tone.mobileAccent
            } ${
              isSelected
                ? "border-brand shadow-[0_12px_28px_rgba(0,102,204,0.10)]"
                : isHighlighted
                  ? "border-brand/60 bg-brand/5"
                  : "border-hairline "
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone.mobilePill}`}>
                    {getMemoryTypeMeta(node.type).label}
                  </span>
                  <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
                    重要度 {node.importance}
                  </span>
                  {isHighlighted ? (
                    <span className="rounded-full bg-brand/10 px-2.5 py-1 text-[11px] font-semibold text-brand">
                      搜索命中
                    </span>
                  ) : null}
                </div>
                <p className="mt-3 text-base font-semibold text-ink">{displayTitle}</p>
                <p className="mt-2 line-clamp-3 text-sm leading-6 text-ink-secondary">{node.text}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {node.tags.slice(0, 3).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-hairline-subtle bg-surface px-2.5 py-1 text-[11px] text-ink-secondary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <Icon icon="mdi:chevron-right" className="mt-1 text-lg text-ink-tertiary" />
            </div>
          </button>
        );
      })}
    </div>
  );
}
