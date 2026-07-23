import { Icon } from "@iconify/react";
import type { ReactNode } from "react";
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
}

interface ImageHistoryStripProps {
  readonly images: readonly WorkflowImageAsset[];
  readonly selectedImageId?: string | null;
  readonly onSelectImage: (image: WorkflowImageAsset) => void;
  readonly onDownloadAll: () => void;
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

export function WorkflowHistoryStrip({ ariaLabel, groups, summary, emptyText, action }: WorkflowHistoryStripProps) {
  return (
    <section className="flex-none border-t border-[#e5e7eb] bg-white px-4 py-3 lg:px-6" aria-label={ariaLabel}>
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[#1d1d1f]">最近生成{summary ? `（${summary}）` : ""}</h2>
        {action}
      </div>
      {groups.length === 0 ? (
        <p className="py-3 text-sm text-[#8a8a8f]">{emptyText}</p>
      ) : (
        <div className="flex gap-5 overflow-x-auto pb-2 [scrollbar-width:thin]">
          {groups.map((group) => (
            <div key={group.id} className="min-w-max border-r border-[#ececf0] pr-5 last:border-r-0 last:pr-0">
              <div className="mb-2 flex max-w-[360px] items-center justify-between gap-3 text-xs">
                <p className="max-w-[220px] truncate font-semibold text-[#1d1d1f]" title={group.title}>{group.title}</p>
                {group.meta && <span className="flex-none text-[#8a8a8f]">{group.meta}</span>}
              </div>
              <div className="flex min-h-[72px] gap-2">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={item.onSelect}
                    aria-pressed={item.selected}
                    title={item.alt}
                    className={`relative grid h-[72px] w-[72px] flex-none place-items-center overflow-hidden rounded-lg border-2 bg-[#f5f5f7] text-[#8a8a8f] outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${item.selected ? "border-brand" : "border-transparent"}`}
                  >
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.alt} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <Icon icon={item.placeholderIcon ?? "mdi:image-outline"} className={`text-2xl ${item.isLoading ? "animate-spin" : ""}`} aria-hidden />
                    )}
                    {item.selected && <Icon icon="mdi:check-circle" className="absolute right-1 top-1 text-base text-white drop-shadow" aria-hidden />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ImageHistoryStrip(props: ImageHistoryStripProps) {
  const groups = groupImages(props.images);
  return (
    <WorkflowHistoryStrip
      ariaLabel="最近生成历史记录"
      summary={`${props.images.length} / 50`}
      emptyText="暂无生成图片"
      action={(
        <button
          type="button"
          onClick={props.onDownloadAll}
          disabled={props.images.length === 0}
          className="inline-flex h-8 items-center gap-1 text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:text-[#8a8a8f]"
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
