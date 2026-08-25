import { Icon } from "@iconify/react";
import {
  articleWorkflowPlatformConfig,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowImageRole,
  type ArticleWorkflowPlatform,
} from "@ai-assistant/article-workflow";
import {
  articleWorkflowImageFileName,
  articleWorkflowImageRatioLabel,
  downloadArticleWorkflowImage,
} from "./articleWorkflowImageDownload";

interface ArticleWorkflowImageAssetPanelProps {
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly platform: ArticleWorkflowPlatform;
  readonly regeneratingSlot: string | null;
  readonly onRegenerateImage: (slot: string) => void;
  readonly variant?: "compact" | "gallery";
}

interface ImageActionsProps {
  readonly image: ArticleWorkflowImageAsset;
  readonly downloadUrl: string;
  readonly platform: ArticleWorkflowPlatform;
  readonly regeneratingSlot: string | null;
  readonly onRegenerateImage: (slot: string) => void;
}

function ImageActions(props: ImageActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        title="下载配图"
        aria-label={`下载${props.image.alt || props.image.slot}`}
        disabled={!props.downloadUrl}
        onClick={() => {
          void downloadArticleWorkflowImage({
            url: props.downloadUrl,
            fileName: articleWorkflowImageFileName({
              platform: props.platform,
              slot: props.image.slot,
              url: props.downloadUrl,
            }),
          });
        }}
        className="grid h-8 w-8 place-items-center rounded-lg text-ink-secondary hover:bg-[#f5f5f7] disabled:opacity-40"
      >
        <Icon icon="mdi:download-outline" className="text-base" aria-hidden />
      </button>
      <button
        type="button"
        title="重新生成配图"
        aria-label={`重新生成${props.image.alt || props.image.slot}`}
        onClick={() => props.onRegenerateImage(props.image.slot)}
        className="grid h-8 w-8 place-items-center rounded-lg text-ink-secondary hover:bg-[#f5f5f7]"
      >
        <Icon
          icon={props.regeneratingSlot === props.image.slot ? "mdi:loading" : "mdi:refresh"}
          className={`text-base ${props.regeneratingSlot === props.image.slot ? "animate-spin" : ""}`}
          aria-hidden
        />
      </button>
    </div>
  );
}

export function ArticleWorkflowImageAssetPanel(props: ArticleWorkflowImageAssetPanelProps) {
  const config = articleWorkflowPlatformConfig(props.platform);
  const sizeOf = (role: ArticleWorkflowImageRole) => (role === "cover" ? config.coverSize : config.inlineSize);
  const gallery = props.variant === "gallery";
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">配图素材</h3>
        <span className="text-xs text-ink-tertiary">{props.imageManifest.length} 张</span>
      </div>

      <div className={gallery ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "grid gap-2"}>
        {props.imageManifest.length === 0 && (
          <div className="rounded-lg border border-dashed border-hairline bg-[#f7f8fa] px-3 py-5 text-center text-sm text-ink-tertiary">
            暂无配图
          </div>
        )}

        {props.imageManifest.map((image) => {
          const downloadUrl = image.imageUrl || image.thumbnailUrl || "";
          const size = sizeOf(image.role);
          const ratio = articleWorkflowImageRatioLabel(size);
          const [width, height] = size.split("x");
          if (gallery) {
            return (
              <article key={image.slot} className="min-w-0 overflow-hidden rounded-lg border border-[#e5e7eb] bg-white">
                <div
                  className="flex max-h-[520px] items-center justify-center bg-[#f5f5f7]"
                  style={{ aspectRatio: `${width} / ${height}` }}
                >
                  {image.thumbnailUrl || image.imageUrl ? (
                    <img
                      src={image.imageUrl || image.thumbnailUrl}
                      alt={image.alt || "文章配图"}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-sm text-ink-tertiary">待生成</div>
                  )}
                </div>
                <div className="flex min-w-0 items-center gap-3 border-t border-[#e5e7eb] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-ink">{image.alt || "未设置描述"}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-tertiary">
                      <span className="truncate">{image.slot}</span>
                      {ratio && <span className="rounded bg-[#f5f5f7] px-1.5 py-0.5">{ratio}</span>}
                    </div>
                  </div>
                  <ImageActions
                    image={image}
                    downloadUrl={downloadUrl}
                    platform={props.platform}
                    regeneratingSlot={props.regeneratingSlot}
                    onRegenerateImage={props.onRegenerateImage}
                  />
                </div>
              </article>
            );
          }
          return (
            <div key={image.slot} className="flex min-w-0 items-center gap-3 rounded-lg border border-[#e5e7eb] bg-white p-2">
              <div className="h-14 w-[72px] shrink-0 overflow-hidden rounded-md bg-[#f5f5f7]">
                {image.thumbnailUrl || image.imageUrl ? (
                  <img
                    src={image.thumbnailUrl || image.imageUrl}
                    alt={image.alt || "文章配图"}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="grid h-full place-items-center text-xs text-ink-tertiary">待生成</div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[11px] text-ink-tertiary">
                  <span className="truncate">{image.slot}</span>
                  {ratio && <span className="rounded bg-[#f5f5f7] px-1.5 py-0.5">{ratio}</span>}
                </div>
                <div className="mt-1 truncate text-xs font-semibold text-ink">{image.alt || "未设置描述"}</div>
              </div>
              <ImageActions
                image={image}
                downloadUrl={downloadUrl}
                platform={props.platform}
                regeneratingSlot={props.regeneratingSlot}
                onRegenerateImage={props.onRegenerateImage}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
