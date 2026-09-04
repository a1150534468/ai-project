import type { MemoryNode } from "../../memoryTypes";
import { badgeClass } from "../ui";
import { MEMORY_FIELD_LABEL, MemoryTypePill, formatMemoryTime } from "./MemoryChrome";

/**
 * 摘要行里的中性药丸。底色用 `surface` 而不是 `badgeClass` 的 `surface-muted`：
 * 这一行整体落在 `surface-subtle` 上，药丸得比背景更亮才浮得起来。
 */
const SUMMARY_PILL = "inline-flex items-center rounded-full bg-surface px-3 py-1 text-xs font-medium text-ink-secondary";

/** 底部两张时间卡，除了取哪个字段完全一样。 */
const TIMESTAMPS: readonly { readonly label: string; readonly of: (node: MemoryNode) => string | null }[] = [
  { label: "创建时间", of: (node) => node.createdAt },
  { label: "最近使用", of: (node) => node.lastUsedAt },
];

interface MemoryDetailViewProps {
  readonly node: MemoryNode;
}

export default function MemoryDetailView({ node }: MemoryDetailViewProps) {
  return (
    <div className="space-y-5">
      <div className="rounded-[10px] border border-hairline-subtle bg-surface-subtle p-4">
        <div className="flex flex-wrap items-center gap-2">
          <MemoryTypePill type={node.type} dot />
          <span className={SUMMARY_PILL}>重要度 {node.importance}</span>
          <span className={SUMMARY_PILL}>使用 {node.usedCount} 次</span>
        </div>
        {/* 正文是模型写进去的，换行有意义，不能塌成一段 */}
        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-ink">{node.text}</p>
      </div>

      <div>
        <p className={MEMORY_FIELD_LABEL}>标签</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {node.tags.length === 0 && <span className="text-sm text-ink-tertiary">暂无标签</span>}
          {node.tags.map((tag) => (
            <span key={tag} className={badgeClass({ variant: "outline", size: "md" })}>
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TIMESTAMPS.map((entry) => (
          <div key={entry.label} className="rounded-[10px] border border-hairline-subtle bg-surface p-4">
            <p className={MEMORY_FIELD_LABEL}>{entry.label}</p>
            <p className="mt-2 text-sm text-ink">{formatMemoryTime(entry.of(node))}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
