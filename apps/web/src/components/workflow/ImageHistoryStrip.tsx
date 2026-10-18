import { Icon } from "@iconify/react";
import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { WF_PANEL, WF_PANEL_HEAD } from "./workflowLayout";
import type { WorkflowImageAsset } from "../../api";

export interface WorkflowHistoryItem {
  readonly id: string;
  readonly imageUrl?: string | null;
  readonly alt: string;
  readonly selected?: boolean;
  readonly isLoading?: boolean;
  readonly placeholderIcon?: string;
  readonly onSelect: () => void;
}

export interface WorkflowHistoryGroup {
  readonly id: string;
  readonly title: string;
  readonly meta?: string;
  readonly items: readonly WorkflowHistoryItem[];
}

interface WorkflowHistoryStripProps {
  readonly ariaLabel: string;
  readonly groups: readonly WorkflowHistoryGroup[];
  readonly summary?: string;
  readonly emptyText: string;
  readonly action?: ReactNode;
  /**
   * `strip`＝贴在内容底部的横向条（历史图按请求分组横排）；`rail`＝独立成右栏的竖排版本。
   *
   * 统一规范 v2 的三区是「左=设置、中=工作区、右=历史」，所以有画布的模块用 `rail`。两种形态
   * 都渲染成带名字的 `<section>`（role=region），DOM 只有一份：宽屏上是 grid 的第三列，
   * 窄屏上顺序落到工作区下方 —— 不做「两份 DOM + hidden 二选一」，那会让按 role 取元素取到两个。
   */
  readonly variant?: "strip" | "rail";
}

interface ImageHistoryStripProps {
  readonly images: readonly WorkflowImageAsset[];
  readonly selectedImageId?: string | null;
  readonly onSelectImage: (image: WorkflowImageAsset) => void;
  readonly onDownloadAll: () => void;
  readonly variant?: "strip" | "rail";
}

interface ImageHistoryGroup {
  readonly requestId: string;
  readonly images: readonly WorkflowImageAsset[];
}

function groupImages(images: readonly WorkflowImageAsset[]): readonly ImageHistoryGroup[] {
  const groups = new Map<string, WorkflowImageAsset[]>();
  for (const image of images) {
    const current = groups.get(image.requestId) ?? [];
    current.push(image);
    groups.set(image.requestId, current);
  }
  return Array.from(groups, ([requestId, grouped]) => ({
    requestId,
    images: [...grouped].sort((a, b) => a.requestIndex - b.requestIndex),
  }));
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function WorkflowHistoryStrip({
  ariaLabel,
  groups,
  summary,
  emptyText,
  action,
  variant = "strip",
}: WorkflowHistoryStripProps) {
  const heading = `最近生成${summary ? `（${summary}）` : ""}`;

  if (variant === "rail") {
    return (
      <section
        className={cx(WF_PANEL, "xl:h-full")}
        aria-label={ariaLabel}
      >
        <div className={WF_PANEL_HEAD}>
          <h2 className="min-w-0 truncate text-sm font-semibold text-ink">{heading}</h2>
          {action}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable] [scrollbar-width:thin]">
          {groups.length === 0 ? (
            <p className="py-3 text-sm text-ink-tertiary">{emptyText}</p>
          ) : (
            <div className="grid gap-4">
              {groups.map((group) => (
                <div key={group.id} className="grid gap-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <p className="min-w-0 truncate font-semibold text-ink" title={group.title}>{group.title}</p>
                    {group.meta && <span className="flex-none text-ink-tertiary">{group.meta}</span>}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {group.items.map((item) => (
                      <HistoryThumb key={item.id} item={item} square />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="flex-none border-t border-hairline-subtle bg-surface px-4 py-3 lg:px-6" aria-label={ariaLabel}>
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{heading}</h2>
        {action}
      </div>
      {groups.length === 0 ? (
        <p className="py-3 text-sm text-ink-tertiary">{emptyText}</p>
      ) : (
        <div className="flex gap-5 overflow-x-auto pb-2 [scrollbar-width:thin]">
          {groups.map((group) => (
            <div key={group.id} className="min-w-max border-r border-hairline-subtle pr-5 last:border-r-0 last:pr-0">
              <div className="mb-2 flex max-w-[360px] items-center justify-between gap-3 text-xs">
                <p className="max-w-[220px] truncate font-semibold text-ink" title={group.title}>{group.title}</p>
                {group.meta && <span className="flex-none text-ink-tertiary">{group.meta}</span>}
              </div>
              <div className="flex min-h-[72px] gap-2">
                {group.items.map((item) => (
                  <HistoryThumb key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** 一张历史缩略图。条状是定宽 72px，竖排栏里撑满格子（`square`）。 */
function HistoryThumb({ item, square = false }: { readonly item: WorkflowHistoryItem; readonly square?: boolean }) {
  return (
    <button
      type="button"
      onClick={item.onSelect}
      aria-pressed={item.selected}
      title={item.alt}
      className={cx(
        "relative grid place-items-center overflow-hidden rounded-[10px] border-2 bg-surface-muted text-ink-tertiary outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
        square ? "aspect-square w-full" : "h-[72px] w-[72px] flex-none",
        item.selected ? "border-brand" : "border-transparent",
      )}
    >
      {item.imageUrl ? (
        <img src={item.imageUrl} alt={item.alt} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <Icon icon={item.placeholderIcon ?? "mdi:image-outline"} className={cx("text-2xl", item.isLoading && "animate-spin")} aria-hidden />
      )}
      {item.selected && <Icon icon="mdi:check-circle" className="absolute right-1 top-1 text-base text-white drop-shadow" aria-hidden />}
    </button>
  );
}

export function ImageHistoryStrip(props: ImageHistoryStripProps) {
  const groups = groupImages(props.images);
  return (
    <WorkflowHistoryStrip
      ariaLabel="最近生成历史记录"
      variant={props.variant ?? "strip"}
      summary={`${props.images.length} / 50`}
      emptyText="暂无生成图片"
      action={(
        <button
          type="button"
          onClick={props.onDownloadAll}
          disabled={props.images.length === 0}
          className="inline-flex h-8 items-center gap-1 text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:text-ink-tertiary"
        >
          <Icon icon="mdi:download-multiple" className="text-base" aria-hidden />
          全部原图链接
        </button>
      )}
      groups={groups.map((group) => {
        const first = group.images[0];
        return {
          id: group.requestId,
          title: first.prompt,
          meta: formatTime(first.createdAt),
          items: group.images.map((image) => ({
            id: image.id,
            imageUrl: image.thumbnailUrl || image.originalUrl,
            alt: `${image.prompt} 第 ${image.requestIndex + 1} 张`,
            selected: image.id === props.selectedImageId,
            onSelect: () => props.onSelectImage(image),
          })),
        };
      })}
    />
  );
}
