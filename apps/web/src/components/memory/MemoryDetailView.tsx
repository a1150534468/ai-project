import { getMemoryTypeMeta } from "../../memoryGalaxy";
import type { MemoryNode } from "../../memoryTypes";
import { MEMORY_TYPE_STYLES } from "./memoryStyles";

function formatDate(value: string | null): string {
  if (!value) {
    return "尚未使用";
  }

  return new Date(value).toLocaleString("zh-CN");
}

interface MemoryDetailViewProps {
  readonly node: MemoryNode;
}

export default function MemoryDetailView({ node }: MemoryDetailViewProps) {
  const typeStyle = MEMORY_TYPE_STYLES[node.type];

  return (
    <div className="space-y-5">
      <div className="rounded-[10px] border border-[#e8e8ed] bg-[#f7faf9] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${typeStyle.viewPill}`}>
            <span className={`h-2 w-2 rounded-full ${typeStyle.viewDot}`} />
            {getMemoryTypeMeta(node.type).label}
          </span>
          <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-medium text-[#6e6e73]">
            重要度 {node.importance}
          </span>
          <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-medium text-[#6e6e73]">
            使用 {node.usedCount} 次
          </span>
        </div>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-ink">
          {node.text}
        </p>
      </div>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8a8a8f]">
          标签
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {node.tags.length > 0 ? (
            node.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full border border-[#d2d2d7] bg-white px-3 py-1 text-xs text-[#6e6e73]"
              >
                {tag}
              </span>
            ))
          ) : (
            <span className="text-sm text-[#8a8a8f]">暂无标签</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-[10px] border border-[#e8e8ed] bg-white p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8a8a8f]">
            创建时间
          </p>
          <p className="mt-2 text-sm text-ink">
            {new Date(node.createdAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <div className="rounded-[10px] border border-[#e8e8ed] bg-white p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8a8a8f]">
            最近使用
          </p>
          <p className="mt-2 text-sm text-ink">{formatDate(node.lastUsedAt)}</p>
        </div>
      </div>
    </div>
  );
}
