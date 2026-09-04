import { Icon } from "@iconify/react";
import type { ReactNode } from "react";
import { fallbackTitle } from "../../memoryGalaxy";
import type { MemoryNode } from "../../memoryTypes";
import { badgeClass, cx } from "../ui";
import { MemoryPlaceholder, MemoryTypePill, formatMemoryTime, memoryListState, type MemoryListCopy } from "./MemoryChrome";

/**
 * 桌面端的记忆表格。六个数据列写成一张表而不是 `<thead>`/`<tbody>` 各排一遍 ——
 * 那两排必须同序同长，加一列要改两处，宽度百分比还得手动凑够 100。
 * 第七列（操作）不在表里：它是交互而不是数据，单独渲染反倒好读。
 */
interface MemoryColumn {
  readonly label: string;
  /** table-fixed 下宽度只能在 `<th>` 上给死。字面类名，不能拼。 */
  readonly width: string;
  readonly cell: (node: MemoryNode, highlighted: boolean) => ReactNode;
}

const COLUMNS: readonly MemoryColumn[] = [
  {
    label: "记忆内容",
    width: "w-[34%]",
    cell: (node, highlighted) => (
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-ink">{fallbackTitle(node.title, node.text)}</p>
          {highlighted && <span className={badgeClass({ tone: "brand" })}>命中</span>}
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-secondary">{node.text}</p>
      </div>
    ),
  },
  { label: "类型", width: "w-[13%]", cell: (node) => <MemoryTypePill type={node.type} size="sm" dot /> },
  {
    label: "重要度",
    width: "w-[10%]",
    cell: (node) => (
      <span className={badgeClass({ size: "md", className: "min-w-12 justify-center" })}>{node.importance}</span>
    ),
  },
  {
    label: "标签",
    width: "w-[14%]",
    // 只露两个：第三个开始这一列就被挤宽了，完整标签在右侧详情面板
    cell: (node) => (
      <div className="flex flex-wrap gap-1.5">
        {node.tags.length === 0 && <span className="text-xs text-ink-tertiary">暂无</span>}
        {node.tags.slice(0, 2).map((tag) => (
          <span key={tag} className={badgeClass({ variant: "outline" })}>
            {tag}
          </span>
        ))}
      </div>
    ),
  },
  {
    label: "使用",
    width: "w-[10%]",
    cell: (node) => <span className="text-xs text-ink-secondary">{node.usedCount} 次</span>,
  },
  {
    label: "创建时间",
    width: "w-[12%]",
    cell: (node) => <span className="text-xs leading-5 text-ink-secondary">{formatMemoryTime(node.createdAt)}</span>,
  },
];

const COPY: MemoryListCopy = {
  loadingHeight: "min-h-[360px]",
  loadingText: "正在加载记忆表格...",
  errorTitle: "记忆表格加载失败",
  emptyIcon: "mdi:table-search",
  emptyHint: "调整搜索或类型筛选后再查看。",
};

interface MemoryTableProps {
  readonly nodes: readonly MemoryNode[];
  readonly selectedId: string | null;
  readonly highlightedIds: ReadonlySet<string>;
  readonly loading: boolean;
  readonly error: string;
  readonly onSelect: (id: string) => void;
}

export default function MemoryTable({ nodes, selectedId, highlightedIds, loading, error, onSelect }: MemoryTableProps) {
  const state = memoryListState(loading, error, nodes.length);
  if (state) return <MemoryPlaceholder state={state} copy={COPY} />;

  return (
    <div className="h-full min-h-0 overflow-hidden rounded-[14px] border border-hairline-subtle bg-surface">
      <div className="max-h-full overflow-auto">
        <table className="min-w-[820px] w-full table-fixed border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-surface-subtle text-[11px] font-semibold uppercase text-ink-tertiary">
            <tr>
              {COLUMNS.map((column) => (
                <th key={column.label} className={cx("whitespace-nowrap px-4 py-3", column.width)}>
                  {column.label}
                </th>
              ))}
              <th className="w-[7%] whitespace-nowrap px-3 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline-subtle">
            {nodes.map((node) => {
              const highlighted = highlightedIds.has(node.id);

              return (
                // 整行可点是主要交互；键盘与读屏走操作列那个按钮
                <tr
                  key={node.id}
                  onClick={() => onSelect(node.id)}
                  aria-selected={node.id === selectedId}
                  className={cx(
                    "cursor-pointer transition",
                    node.id === selectedId ? "bg-brand/[0.08]" : highlighted && "bg-brand/5",
                  )}
                >
                  {COLUMNS.map((column) => (
                    <td key={column.label} className="px-4 py-4 align-top">
                      {column.cell(node, highlighted)}
                    </td>
                  ))}
                  <td className="px-3 py-4 text-right align-top">
                    <button
                      type="button"
                      aria-label={`查看记忆：${fallbackTitle(node.title, node.text)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(node.id);
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-tertiary"
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
