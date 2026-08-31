/**
 * 素材库的展示层：两个分区 Tab + module 筛选 + 素材网格 + 「加载更多」。
 *
 * 只做展示与回调，数据与弹窗都在 `pages/Assets.tsx`。翻页故意用一个按钮而不是滚动到底自动加载：
 * 键集分页每页都要带游标，按钮让「什么时候发第二次请求」这件事在测试里是可控的，
 * 也免得网格在窄屏上抖一下就多请求一页。
 */
import { Icon } from "@iconify/react";
import type { AssetItem, AssetMediaType, AssetOrigin, AssetSourceModule } from "../../assetApi";
import {
  ASSET_MODULE_LABELS,
  ASSET_ORIGIN_TABS,
  formatAssetDuration,
  formatAssetSize,
  moduleFiltersForOrigin,
} from "../../assetLibrary";

const MEDIA_ICONS: Readonly<Record<AssetMediaType, string>> = {
  image: "mdi:image-outline",
  video: "mdi:video-outline",
  audio: "mdi:music-note-outline",
  archive: "mdi:folder-zip-outline",
};

const MEDIA_LABELS: Readonly<Record<AssetMediaType, string>> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  archive: "压缩包",
};

export interface AssetLibraryViewProps {
  readonly items: readonly AssetItem[];
  readonly origin: AssetOrigin;
  /** null = 该分区下不筛 module（「全部」）。 */
  readonly module: AssetSourceModule | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: string;
  readonly onOriginChange: (origin: AssetOrigin) => void;
  readonly onModuleChange: (module: AssetSourceModule | null) => void;
  readonly onLoadMore: () => void;
  readonly onOpen: (item: AssetItem) => void;
  readonly onRetry: () => void;
}

function AssetCard({ item, onOpen }: { readonly item: AssetItem; readonly onOpen: (item: AssetItem) => void }) {
  // 缩略图优先，没有缩略图时图片可以直接拿原图顶上；视频/音频/压缩包一律占位图标。
  const preview = item.mediaType === "image" ? (item.thumbnailUrl ?? item.url) : item.thumbnailUrl;
  const size = formatAssetSize(item.sizeBytes);
  const duration = formatAssetDuration(item.durationSec);
  const meta = [MEDIA_LABELS[item.mediaType], size, duration].filter(Boolean).join(" · ");

  return (
    <article
      data-testid="asset-card"
      data-asset-id={item.id}
      className="flex flex-col overflow-hidden rounded-[14px] border border-hairline-subtle bg-surface"
    >
      <div className="relative grid aspect-square place-items-center bg-surface-subtle">
        {preview ? (
          <img src={preview} alt={item.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <Icon icon={MEDIA_ICONS[item.mediaType]} className="text-3xl text-ink-tertiary" aria-hidden />
        )}
        <span className="absolute left-2 top-2 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
          {ASSET_MODULE_LABELS[item.sourceModule]}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <h3 className="truncate text-sm font-semibold text-ink" title={item.title}>{item.title}</h3>
        <p className="truncate text-xs text-ink-tertiary">{meta}</p>
        {item.groupLabel && <p className="truncate text-xs text-ink-tertiary">来自：{item.groupLabel}</p>}
        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <span className="text-[11px] text-ink-tertiary">{new Date(item.createdAt).toLocaleDateString("zh-CN")}</span>
          <button
            type="button"
            disabled={item.url === null}
            onClick={() => onOpen(item)}
            title={item.url === null ? "这条素材没有可用的取件链接" : undefined}
            className="h-8 rounded-[9px] border border-hairline px-3 text-xs font-medium text-ink transition disabled:cursor-not-allowed disabled:text-ink-tertiary"
          >
            获取链接
          </button>
        </div>
      </div>
    </article>
  );
}

export function AssetLibraryView({
  items,
  origin,
  module,
  loading,
  loadingMore,
  hasMore,
  error,
  onOriginChange,
  onModuleChange,
  onLoadMore,
  onOpen,
  onRetry,
}: AssetLibraryViewProps) {
  const tab = ASSET_ORIGIN_TABS.find((entry) => entry.origin === origin) ?? ASSET_ORIGIN_TABS[0]!;
  const modules = moduleFiltersForOrigin(origin);

  return (
    <div className="min-h-full bg-surface-muted px-4 py-5 lg:px-8 lg:py-7">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <section className="rounded-[14px] border border-hairline-subtle bg-surface p-5">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-hairline-subtle bg-surface-subtle px-3 py-1 text-xs font-medium text-ink-secondary">
            <Icon icon="mdi:folder-multiple-image" className="text-base" aria-hidden />
            <span data-testid="asset-count">已加载 {items.length} 条</span>
          </div>
          <h1 className="text-2xl font-bold tracking-normal text-ink">素材库</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">
            各个工作流产出的图片、视频、音频，以及你上传过的参考图与音色样本，都汇总在这里。
            素材直接读自各模块自己的数据，不另存一份 —— 在原模块删掉，这里就跟着消失。
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {ASSET_ORIGIN_TABS.map((entry) => (
              <button
                key={entry.origin}
                type="button"
                data-testid={`asset-origin-${entry.origin}`}
                aria-pressed={entry.origin === origin}
                onClick={() => onOriginChange(entry.origin)}
                className={`inline-flex h-9 items-center gap-2 rounded-full px-4 text-xs font-medium transition ${
                  entry.origin === origin ? "bg-surface-inverse text-ink-inverse" : "bg-surface-subtle text-ink-secondary"
                }`}
              >
                <Icon icon={entry.icon} className="text-base" aria-hidden />
                {entry.label}
              </button>
            ))}
          </div>
        </section>

        <section className="flex flex-wrap items-center gap-2 rounded-[14px] border border-hairline-subtle bg-surface p-4">
          <button
            type="button"
            data-testid="asset-module-all"
            aria-pressed={module === null}
            onClick={() => onModuleChange(null)}
            className={`h-8 rounded-full border px-3 text-xs font-medium transition ${
              module === null ? "border-brand/30 bg-brand-soft text-brand-ink" : "border-hairline bg-surface text-ink-secondary"
            }`}
          >
            全部
          </button>
          {modules.map((entry) => (
            <button
              key={entry}
              type="button"
              data-testid={`asset-module-${entry}`}
              aria-pressed={module === entry}
              onClick={() => onModuleChange(module === entry ? null : entry)}
              className={`h-8 rounded-full border px-3 text-xs font-medium transition ${
                module === entry ? "border-brand/30 bg-brand-soft text-brand-ink" : "border-hairline bg-surface text-ink-secondary"
              }`}
            >
              {ASSET_MODULE_LABELS[entry]}
            </button>
          ))}
        </section>

        {error && (
          <div
            data-testid="asset-error"
            className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger-ink"
          >
            <span>{error}</span>
            <button type="button" onClick={onRetry} className="h-8 rounded-[9px] border border-danger/30 px-3 text-xs font-medium">
              重试
            </button>
          </div>
        )}

        {items.length > 0 ? (
          <section className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {items.map((item) => (
                <AssetCard key={item.id} item={item} onOpen={onOpen} />
              ))}
            </div>
            {hasMore && (
              <div className="flex justify-center">
                <button
                  type="button"
                  data-testid="asset-load-more"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                  className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-hairline bg-surface px-5 text-sm font-medium text-ink transition disabled:cursor-not-allowed disabled:text-ink-tertiary"
                >
                  {loadingMore && <Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />}
                  {loadingMore ? "加载中" : "加载更多"}
                </button>
              </div>
            )}
          </section>
        ) : (
          <section
            data-testid="asset-empty"
            className="flex min-h-[24rem] flex-col items-center justify-center rounded-[14px] border border-dashed border-hairline-subtle bg-surface px-6 text-center"
          >
            <Icon
              icon={loading ? "mdi:loading" : "mdi:folder-open-outline"}
              className={`text-3xl text-ink-tertiary ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
            <p className="mt-3 text-sm font-semibold text-ink">{loading ? "正在加载" : "这里还没有素材"}</p>
            {!loading && <p className="mt-1 max-w-md text-xs leading-6 text-ink-secondary">{tab.emptyText}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
