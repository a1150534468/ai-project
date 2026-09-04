import { Icon } from "@iconify/react";
import { fallbackTitle } from "../../memoryGalaxy";
import type { MemoryNode } from "../../memoryTypes";
import { badgeClass, cx } from "../ui";
import { MemoryPlaceholder, MemoryTypePill, memoryListState, type MemoryListCopy } from "./MemoryChrome";
import { memoryEdgeClass } from "./memoryStyles";

const COPY: MemoryListCopy = {
  loadingHeight: "min-h-[260px]",
  loadingText: "正在加载记忆列表...",
  errorTitle: "记忆列表加载失败",
  emptyIcon: "mdi:atom-variant",
  emptyHint: "调整类型筛选或开始更多对话，让新的内容进入你的长期记忆。",
};

/**
 * 卡片的三种状态各自换掉描边（左边那条类型色竖条一直在，由 `memoryEdgeClass` 给）。
 * 选中 > 命中 > 普通，只取最靠前的那一档。
 */
function cardEdge(selected: boolean, highlighted: boolean): string {
  if (selected) return "border-brand shadow-[0_12px_28px_rgba(0,102,204,0.10)]";

  return highlighted ? "border-brand/60 bg-brand/5" : "border-hairline";
}

interface MemoryMobileListProps {
  readonly nodes: readonly MemoryNode[];
  readonly selectedId: string | null;
  readonly highlightedIds: ReadonlySet<string>;
  readonly loading: boolean;
  readonly error: string;
  readonly onSelect: (id: string) => void;
}

export default function MemoryMobileList({
  nodes,
  selectedId,
  highlightedIds,
  loading,
  error,
  onSelect,
}: MemoryMobileListProps) {
  const state = memoryListState(loading, error, nodes.length);
  if (state) return <MemoryPlaceholder state={state} copy={COPY} />;

  return (
    // pb-28 给底部抽屉留出空档，否则最后一张卡会被弹起来的详情面板压住
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-28">
      {nodes.map((node) => {
        const highlighted = highlightedIds.has(node.id);

        return (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelect(node.id)}
            aria-pressed={node.id === selectedId}
            className={cx(
              "w-full rounded-[14px] border border-l-4 bg-surface p-4 text-left transition",
              memoryEdgeClass(node.type),
              cardEdge(node.id === selectedId, highlighted),
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <MemoryTypePill type={node.type} size="md" />
                  <span className={badgeClass({ size: "md" })}>重要度 {node.importance}</span>
                  {highlighted && <span className={badgeClass({ tone: "brand", size: "md" })}>搜索命中</span>}
                </div>
                <p className="mt-3 text-base font-semibold text-ink">{fallbackTitle(node.title, node.text)}</p>
                <p className="mt-2 line-clamp-3 text-sm leading-6 text-ink-secondary">{node.text}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {node.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className={badgeClass({ variant: "outline", size: "md" })}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <Icon icon="mdi:chevron-right" className="mt-1 text-lg text-ink-tertiary" aria-hidden />
            </div>
          </button>
        );
      })}
    </div>
  );
}
