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
}

export function ArticleWorkflowImageAssetPanel(props: ArticleWorkflowImageAssetPanelProps) {
  const config = articleWorkflowPlatformConfig(props.platform);
  const sizeOf = (role: ArticleWorkflowImageRole) => (role === "cover" ? config.coverSize : config.inlineSize);
  return (
    <section className="rounded-[16px] border border-[#e7e9f0] bg-white p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-[#14151a]">配图素材</h3>
      </div>

      <div className="grid gap-3">
        {props.imageManifest.length === 0 && (
          <div className="rounded-[14px] border border-dashed border-[#d8dde6] bg-[#fafbfe] px-3 py-5 text-sm text-[#667085]">
            暂无配图。
          </div>
        )}

        {props.imageManifest.map((image) => {
          const downloadUrl = image.imageUrl || image.thumbnailUrl || "";
          const ratio = articleWorkflowImageRatioLabel(sizeOf(image.role));
          return (
            <div key={image.slot} className="rounded-[14px] border border-[#edf0f5] bg-[#fafbfe] p-3">
              <div className="overflow-hidden rounded-[12px] bg-white">
                {image.thumbnailUrl || image.imageUrl ? (
                  <img
                    src={image.thumbnailUrl || image.imageUrl}
                    alt={image.alt || "文章配图"}
                    className="block aspect-[4/3] w-full object-cover"
                  />
                ) : (
                  <div className="grid aspect-[4/3] place-items-center text-sm text-[#8a8f98]">待生成</div>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#8a8f98]">
                    <span className="truncate">{image.slot}</span>
                    {ratio && <span className="rounded-full bg-white px-1.5 py-0.5 normal-case tracking-normal">{ratio}</span>}
                  </div>
                  <div className="truncate text-sm text-[#14151a]">{image.alt || "未设置描述"}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!downloadUrl}
                    onClick={() => {
                      void downloadArticleWorkflowImage({
                        url: downloadUrl,
                        fileName: articleWorkflowImageFileName({
                          platform: props.platform,
                          slot: image.slot,
                          url: downloadUrl,
                        }),
                      });
                    }}
                    className="flex h-9 items-center gap-1.5 rounded-[10px] border border-[#d5dae3] px-3 text-xs font-semibold text-[#1d2433] disabled:opacity-40"
                  >
                    <Icon icon="mdi:download-outline" aria-hidden />
                    下载
                  </button>
                  <button
                    type="button"
                    onClick={() => props.onRegenerateImage(image.slot)}
                    className="flex h-9 items-center gap-1.5 rounded-[10px] border border-[#d5dae3] px-3 text-xs font-semibold text-[#1d2433]"
                  >
                    <Icon icon={props.regeneratingSlot === image.slot ? "mdi:loading" : "mdi:refresh"} className={props.regeneratingSlot === image.slot ? "animate-spin" : ""} aria-hidden />
                    重生
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
