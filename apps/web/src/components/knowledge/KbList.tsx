/**
 * 知识库清单。原来「我的」和「官方」是两段几乎逐字相同的 JSX，卡片本体是 `<div onClick>`、
 * 里面又嵌了「编辑」「删除」两个 `<button>` —— Tab 键根本走不到卡片，读屏也不会念它可点，
 * 而嵌在按钮里的按钮本身就不是合法 HTML（那两个 `stopPropagation` 就是为了压住这个嵌套）。
 *
 * 现在一份实现两处用：卡片本体是 `<button>`，两个动作是它的兄弟节点，事件不用再互相躲。
 */
import { Icon } from "@iconify/react";
import type { KnowledgeBase } from "../../kbApi";
import { Badge, cx } from "../ui";

/** 卡片里那两个小动作按钮的共同造型；配色各自加。 */
const ACTION = "inline-flex h-8 items-center gap-1 rounded-[10px] px-2.5 text-xs font-medium transition-colors";

export interface KbListProps {
  readonly title: string;
  readonly items: readonly KnowledgeBase[];
  readonly selectedId: string | null;
  /** 一条都没有时显示什么。首屏还在加载和真的空库不是一回事，文案由调用方决定 */
  readonly emptyText: string;
  /** 高到什么程度开始内滚。字面类名，不能拼 */
  readonly maxHeight: string;
  /** 官方库：标一个角标，且不给编辑 / 删除 */
  readonly official?: boolean;
  /** 有活在飞：把刷新按钮转起来并锁住 */
  readonly busy?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onRefresh?: () => void;
  readonly onEdit?: (kb: KnowledgeBase) => void;
  readonly onDelete?: (kb: KnowledgeBase) => void;
}

export default function KbList({
  title,
  items,
  selectedId,
  emptyText,
  maxHeight,
  official = false,
  busy = false,
  onSelect,
  onRefresh,
  onEdit,
  onDelete,
}: KbListProps) {
  return (
    <section className="glass-card space-y-4 rounded-xl p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wider text-ink">{title}</h3>
        {onRefresh && (
          <button
            type="button"
            aria-label={`刷新${title}`}
            disabled={busy}
            onClick={onRefresh}
            className="p-1 text-ink-secondary disabled:text-ink-tertiary"
          >
            <Icon icon="mdi:refresh" className={cx("text-lg", busy && "animate-spin")} aria-hidden />
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">{emptyText}</p>
      ) : (
        <ul className={cx("space-y-2 overflow-y-auto", maxHeight)}>
          {items.map((kb) => (
            <li
              key={kb.id}
              className={cx(
                "rounded-lg border p-4 transition-colors",
                kb.id === selectedId ? "border-brand-soft bg-brand-soft" : "border-hairline-subtle bg-surface",
              )}
            >
              {/* 卡片本体是按钮，所以里面只能放 phrasing 内容 —— 一律 <span> + display 类名 */}
              <button
                type="button"
                onClick={() => onSelect(kb.id)}
                aria-current={kb.id === selectedId ? "true" : undefined}
                className="block w-full text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{kb.name}</span>
                  {official && <Badge tone="info">官方</Badge>}
                </span>
                {kb.description && (
                  <span className="mt-1 line-clamp-1 block text-xs text-ink-secondary">{kb.description}</span>
                )}
                <span className="mt-2 block text-xs text-brand-ink">已建立知识晶格数量：{kb.latticeCount ?? 0}</span>
              </button>

              {(onEdit || onDelete) && (
                <div className="mt-3 flex gap-2">
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(kb)}
                      className={cx(ACTION, "bg-surface-muted text-ink hover:bg-hairline-subtle")}
                    >
                      <Icon icon="mdi:pencil-outline" className="text-sm" aria-hidden />
                      编辑
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => onDelete(kb)}
                      className={cx(ACTION, "bg-danger/10 text-danger-ink hover:bg-danger/20")}
                    >
                      <Icon icon="mdi:trash-outline" className="text-sm" aria-hidden />
                      删除
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
