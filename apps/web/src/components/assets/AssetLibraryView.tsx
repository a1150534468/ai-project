/**
 * 素材库的展示层：两个分区 Tab + module 筛选 + 素材网格 + 「加载更多」。
 *
 * 只做展示与回调，数据与弹窗都在 `pages/Assets.tsx`。翻页故意用一个按钮而不是滚动到底自动加载：
 * 键集分页每页都要带游标，按钮让「什么时候发第二次请求」这件事在测试里是可控的，
 * 也免得网格在窄屏上抖一下就多请求一页。
 */
import { Icon } from "@iconify/react";
import type { AssetItem, AssetMediaType, AssetOrigin, AssetSourceModule } from "../../assetApi";
import { Button, PageHeader, SegmentedControl } from "../ui";
import {
  ASSET_MODULE_LABELS,
  ASSET_ORIGIN_TABS,
  moduleFiltersForOrigin,
  formatAssetDuration,
  formatAssetSize,
} from "../../assetLibrary";

/** 「全部」在 UI 里是分段控件的一项，落到接口是 `sourceModule: null`。 */
const ALL_MODULES = "all";

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
  /** 空态里「去创作」的去处（工作流）。没给就只留那句话，不给按钮。 */
  readonly onCreate?: () => void;
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
      className="flex flex-col overflow-hidden rounded-xl border border-hairline-subtle bg-surface"
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
  onCreate,
}: AssetLibraryViewProps) {
  const modules = moduleFiltersForOrigin(origin);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-muted">
      {/* 页头原来是一张卡：胶囊眉标「已加载 N 条」+ H1 + 一段三行设计说明 —— 三样都在替这屏做
          自我解释。现在报数进条带右侧，说明句删掉（页面不解释自己）。
          两条筛选也在这一条上、紧挨页名 —— 规范里「上下文条 = 页名 + 就地控件」就是它，
          原来那版把筛选放在正文里另起一张卡，等于给工具栏又套了一层容器。 */}
      <PageHeader
        title="素材库"
        maxWidth="max-w-7xl"
        meta={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <SegmentedControl
              ariaLabel="素材分区"
              value={origin}
              onChange={onOriginChange}
              options={ASSET_ORIGIN_TABS.map((entry) => ({
                value: entry.origin,
                label: entry.label,
                icon: entry.icon,
                testId: `asset-origin-${entry.origin}`,
              }))}
            />
            <span className="h-5 w-px flex-none bg-hairline-subtle" aria-hidden />
            <SegmentedControl
              ariaLabel="素材类型"
              value={module ?? ALL_MODULES}
              onChange={(next) => onModuleChange(next === ALL_MODULES ? null : next)}
              options={[
                { value: ALL_MODULES, label: "全部", testId: "asset-module-all" },
                ...modules.map((entry) => ({
                  value: entry,
                  label: ASSET_MODULE_LABELS[entry],
                  testId: `asset-module-${entry}`,
                })),
              ]}
            />
          </div>
        }
      >
        <span data-testid="asset-count">已加载 {items.length} 条</span>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
          {error && (
            <div
              data-testid="asset-error"
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger-ink"
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
            /* 空态只留一句 + 一个去处：原来这里还挂着一个 3xl 图标和一段按分区区分的说明句，
               两样都在替这屏解释自己。分区那句说明进分段控件就够了。 */
            <section
              data-testid="asset-empty"
              className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-hairline-subtle bg-surface px-6 py-16 text-center"
            >
              <p className="text-sm text-ink-secondary">{loading ? "正在加载…" : "这里还没有素材"}</p>
              {!loading && onCreate && (
                <Button variant="primary" size="md" shape="rounded" className="mt-4" onClick={onCreate}>
                  去创作
                </Button>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
