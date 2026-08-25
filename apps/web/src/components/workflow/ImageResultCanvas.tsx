import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import type { WorkflowImageAsset } from "../../api";
import type { ImageTask } from "../../workflowState";
import { ImageResultActions } from "./ImageResultActions";

interface ImageResultCanvasProps {
  readonly images: readonly WorkflowImageAsset[];
  readonly baseImage?: WorkflowImageAsset | null;
  readonly selectedImageId?: string | null;
  readonly task?: ImageTask | null;
  readonly isGenerating: boolean;
  readonly generatingCount: number;
  readonly onSelectImage: (image: WorkflowImageAsset) => void;
  readonly onModify: (image: WorkflowImageAsset) => void;
  readonly onVariation: (image: WorkflowImageAsset) => void;
  readonly onEdit: (image: WorkflowImageAsset) => void;
  readonly onDownload: (image: WorkflowImageAsset) => void;
}

function imageAlt(image: WorkflowImageAsset): string {
  return image.prompt.length > 80 ? `${image.prompt.slice(0, 80)}...` : image.prompt;
}

export function ImageResultCanvas(props: ImageResultCanvasProps) {
  const [failedImageIds, setFailedImageIds] = useState<readonly string[]>([]);
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({});
  const displayImages = useMemo(() => {
    const all = props.baseImage && !props.images.some((image) => image.id === props.baseImage?.id)
      ? [props.baseImage, ...props.images]
      : [...props.images];
    return all.slice(0, 8);
  }, [props.baseImage, props.images]);
  const selectedImage = displayImages.find((image) => image.id === props.selectedImageId) ?? displayImages[0] ?? null;
  const loadingCount = props.isGenerating ? Math.max(1, props.generatingCount) : 0;
  const isFailed = props.task?.status === "failed";

  const imageTile = (image: WorkflowImageAsset, single: boolean) => {
    const selected = selectedImage?.id === image.id;
    const failed = failedImageIds.includes(image.id);
    return (
      <div
        key={image.id}
        className={`group relative min-w-0 overflow-hidden rounded-lg border-2 bg-[#f5f5f7] text-left ${
          selected ? "border-brand" : "border-transparent"
        } ${single ? "mx-auto flex h-full max-h-[620px] w-full max-w-[860px] items-center justify-center" : "aspect-square"}`}
      >
        {failed ? (
          <div className="grid h-full min-h-52 w-full place-items-center px-4 text-center text-sm font-semibold text-ink-secondary">
            <div>
              <Icon icon="mdi:image-off-outline" className="mx-auto mb-2 text-3xl" aria-hidden />
              图片加载失败
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setFailedImageIds((ids) => ids.filter((id) => id !== image.id));
                  setReloadKeys((keys) => ({ ...keys, [image.id]: (keys[image.id] ?? 0) + 1 }));
                }}
                className="mt-2 block text-brand-ink"
              >
                重新加载
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => props.onSelectImage(image)}
            className={`relative flex h-full w-full items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-brand/30`}
            aria-pressed={selected}
          >
            <img
              key={`${image.id}-${reloadKeys[image.id] ?? 0}`}
              src={single ? image.originalUrl : image.thumbnailUrl || image.originalUrl}
              alt={imageAlt(image)}
              loading="lazy"
              onError={() => setFailedImageIds((ids) => ids.includes(image.id) ? ids : [...ids, image.id])}
              className={`${single ? "max-h-full max-w-full object-contain" : "h-full w-full object-cover"}`}
            />
            {selected && (
              <span className="absolute left-2 top-2 rounded-full bg-brand px-2 py-1 text-[11px] font-semibold text-white">当前版本</span>
            )}
            {props.baseImage?.id === image.id && props.isGenerating && (
              <span className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-1 text-[11px] font-semibold text-white">原图保留中</span>
            )}
          </button>
        )}
      </div>
    );
  };

  return (
    <section className="flex h-full min-h-[420px] flex-col bg-white px-4 py-4 lg:px-6" aria-label="当前生成结果">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-ink-secondary">当前结果</p>
          <h2 className="mt-1 text-base font-semibold text-ink">
            {props.task ? `${props.task.count} 张 · ${props.task.size}` : "等待开始"}
          </h2>
        </div>
        {props.isGenerating && (
          <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-xs font-semibold text-brand-ink">
            <Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />
            正在生成 {Math.max(props.generatingCount, 1)} 张
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {displayImages.length === 0 && loadingCount === 0 ? (
          <div className={`grid h-full min-h-[340px] place-items-center rounded-lg border border-dashed px-6 text-center ${isFailed ? "border-red-200 bg-red-50" : "border-[#d2d2d7] bg-[#f7f8fa]"}`}>
            <div className={isFailed ? "text-red-700" : "text-ink-secondary"}>
              <Icon icon={isFailed ? "mdi:alert-circle-outline" : "mdi:image-plus-outline"} className="mx-auto mb-3 text-4xl" aria-hidden />
              <p className="text-sm font-semibold">{isFailed ? "生成失败" : "填写左侧提示词后开始生成"}</p>
              {isFailed && props.task?.error && <p className="mt-2 max-w-md text-xs leading-5">{props.task.error}</p>}
            </div>
          </div>
        ) : displayImages.length === 1 && loadingCount === 0 ? (
          <div className="h-full">{imageTile(displayImages[0], true)}</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">
            {displayImages.map((image) => imageTile(image, false))}
            {Array.from({ length: loadingCount }, (_value, index) => (
              <div key={`loading-${index}`} className="grid aspect-square min-h-36 place-items-center rounded-lg border border-brand/20 bg-brand-soft text-brand-ink">
                <div className="text-center text-xs font-semibold">
                  <Icon icon="mdi:loading" className="mx-auto mb-2 animate-spin text-2xl" aria-hidden />
                  新结果生成中
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedImage && (
        <div className="mt-4">
          <ImageResultActions
            image={selectedImage}
            onModify={props.onModify}
            onVariation={props.onVariation}
            onEdit={props.onEdit}
            onDownload={props.onDownload}
          />
        </div>
      )}
    </section>
  );
}
