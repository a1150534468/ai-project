import { Icon } from "@iconify/react";
import { fallbackTitle, getMemoryTypeMeta } from "../../memoryGalaxy";
import type { MemoryNode } from "../../memoryTypes";
import { MEMORY_TYPE_STYLES } from "./memoryStyles";

function formatDate(value: string | null): string {
  if (!value) {
    return "尚未使用";
  }

  return new Date(value).toLocaleString("zh-CN");
}

interface MemoryTableProps {
  readonly nodes: readonly MemoryNode[];
  readonly selectedId: string | null;
  readonly highlightedIds: readonly string[];
  readonly loading: boolean;
  readonly error: string;
  readonly onSelectNode: (id: string) => void;
}

export default function MemoryTable({
  nodes,
  selectedId,
  highlightedIds,
  loading,
  error,
  onSelectNode,
}: MemoryTableProps) {
  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center rounded-[14px] border border-[#e8e8ed] bg-white">
        <div className="flex items-center gap-3 text-sm text-[#6e6e73]">
          <Icon icon="mdi:loading" className="animate-spin text-lg text-brand" aria-hidden />
          正在加载记忆表格...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[14px] border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
        <div className="flex items-start gap-3">
          <Icon icon="mdi:alert-circle-outline" className="mt-0.5 text-xl" aria-hidden />
          <div>
            <p className="font-medium">记忆表格加载失败</p>
            <p className="mt-1 text-red-600/90">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="rounded-[14px] border border-[#e8e8ed] bg-white px-5 py-14 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-brand">
          <Icon icon="mdi:table-search" className="text-2xl" aria-hidden />
        </div>
        <p className="mt-4 text-base font-semibold text-[#1d1d1f]">当前筛选下没有记忆</p>
        <p className="mt-2 text-sm leading-6 text-[#6e6e73]">
          调整搜索或类型筛选后再查看。
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-hidden rounded-[14px] border border-[#e8e8ed] bg-white">
      <div className="max-h-full overflow-auto">
        <table className="min-w-[820px] w-full table-fixed border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-[#f7faf9] text-[11px] font-semibold uppercase text-[#8a8a8f]">
            <tr>
              <th className="w-[34%] whitespace-nowrap px-4 py-3">记忆内容</th>
              <th className="w-[13%] whitespace-nowrap px-3 py-3">类型</th>
              <th className="w-[10%] whitespace-nowrap px-4 py-3">重要度</th>
              <th className="w-[14%] whitespace-nowrap px-4 py-3">标签</th>
              <th className="w-[10%] whitespace-nowrap px-4 py-3">使用</th>
              <th className="w-[12%] whitespace-nowrap px-4 py-3">创建时间</th>
              <th className="w-[7%] whitespace-nowrap px-3 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#eef0f2]">
            {nodes.map((node, index) => {
              const typeStyle = MEMORY_TYPE_STYLES[node.type];
              const selected = node.id === selectedId;
              const highlighted = highlightedIds.includes(node.id);
              const title = fallbackTitle(node.title, node.text);

              return (
                <tr
                  key={node.id}
                  className={`cursor-pointer transition ${
                    selected
                      ? "bg-brand/[0.08]"
                      : highlighted
                        ? "bg-brand/5"
                        : ""
                  }`}
                  onClick={() => onSelectNode(node.id)}
                >
                  <td className="px-4 py-4 align-top">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-[#1d1d1f]">{title}</p>
                        {highlighted ? (
                          <span className="inline-flex flex-none items-center rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                            命中
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#6e6e73]">
                        {node.text}
                      </p>
                    </div>
                  </td>
                  <td className="px-3 py-4 align-top">
                    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium ${typeStyle.viewPill}`}>
                      <span className={`h-2 w-2 rounded-full ${typeStyle.viewDot}`} />
                      {getMemoryTypeMeta(node.type).label}
                    </span>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <span className="inline-flex min-w-12 justify-center rounded-full bg-[#f5f5f7] px-2.5 py-1 text-xs font-medium text-[#1d1d1f]">
                      {node.importance}
                    </span>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <div className="flex flex-wrap gap-1.5">
                      {node.tags.length > 0 ? (
                        node.tags.slice(0, 2).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full border border-[#e8e8ed] bg-white px-2 py-0.5 text-[11px] text-[#6e6e73]"
                          >
                            {tag}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-[#8a8a8f]">暂无</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-4 align-top text-xs text-[#6e6e73]">
                    {node.usedCount} 次
                  </td>
                  <td className="px-4 py-4 align-top text-xs leading-5 text-[#6e6e73]">
                    {formatDate(node.createdAt)}
                  </td>
                  <td className="px-3 py-4 text-right align-top">
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[#8a8a8f] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                      aria-label={`查看记忆：${title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectNode(node.id);
                      }}
                    >
                      <Icon icon="mdi:chevron-right" className="text-lg" aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
