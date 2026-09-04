import { useRef } from "react";
import { Icon } from "@iconify/react";
import { InAppSelect } from "../ui/InAppSelect";
import { SubmitBar } from "./SubmitBar";
import type { WorkflowImageAsset } from "../../api";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_MAX_COUNT,
  IMAGE_MODEL_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  isImageAspectRatio,
  isImageModel,
  isImageResolution,
  type ImageAspectRatio,
  type ImageModel,
  type ImageResolution,
} from "../../workflowState";

const QUICK_COUNTS = [1, 2, 4, 8] as const;

export interface ImageGenerationControlsProps {
  readonly prompt: string;
  readonly model: ImageModel;
  readonly size: string;
  readonly aspectRatio: ImageAspectRatio;
  readonly resolution: ImageResolution;
  readonly countInput: string;
  readonly selectedQuickCount: number;
  readonly error: string;
  readonly notice: string;
  readonly isOptimizingPrompt: boolean;
  readonly referenceImages: readonly WorkflowImageAsset[];
  readonly isUploadingReference: boolean;
  readonly isEditing: boolean;
  readonly lockedReferenceId?: string | null;
  readonly onPromptChange: (value: string) => void;
  readonly onModelChange: (value: ImageModel) => void;
  readonly onAspectRatioChange: (value: ImageAspectRatio) => void;
  readonly onResolutionChange: (value: ImageResolution) => void;
  readonly onCountInputChange: (value: string) => void;
  readonly onQuickCountChange: (value: number) => void;
  readonly onSubmit: () => void;
  readonly onCancelEditing?: () => void;
  readonly onOptimizePrompt: () => void;
  readonly onReferenceUpload: (file: File) => void;
  readonly onRemoveReference: (assetId: string) => void;
}

export function ImageGenerationControls(props: ImageGenerationControlsProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const supportsReferenceImages = IMAGE_MODEL_OPTIONS.find((option) => option.value === props.model)?.supportsReferenceImages ?? false;

  return (
    <aside className="flex h-[calc(100dvh-15.5rem)] min-h-[500px] max-h-[720px] flex-col border-b border-hairline-subtle bg-surface xl:h-full xl:min-h-0 xl:max-h-none xl:border-b-0 xl:border-r">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-ink-secondary">生成配置</p>
            <h2 className="mt-1 text-base font-semibold text-ink">{props.isEditing ? "基于结果修改" : "创建图片"}</h2>
          </div>
          {props.isEditing && props.onCancelEditing && (
            <button
              type="button"
              onClick={props.onCancelEditing}
              className="inline-flex h-9 items-center gap-1 px-2 text-sm font-semibold text-ink-secondary"
            >
              <Icon icon="mdi:close" className="text-lg" aria-hidden />
              取消编辑
            </button>
          )}
        </div>

        <label htmlFor="workflow-prompt" className="grid gap-2 text-sm font-semibold text-ink">
          提示词
          <textarea
            id="workflow-prompt"
            aria-label="提示词"
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            className="min-h-[132px] resize-y rounded-lg border border-hairline bg-surface p-3 leading-6 outline-none focus:border-brand focus:ring-2 focus:ring-brand/10"
          />
        </label>

        <button
          type="button"
          onClick={props.onOptimizePrompt}
          disabled={props.isOptimizingPrompt}
          className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-hairline text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-tertiary"
        >
          <Icon icon={props.isOptimizingPrompt ? "mdi:loading" : "mdi:magic-staff"} className={props.isOptimizingPrompt ? "animate-spin text-base" : "text-base"} aria-hidden />
          {props.isOptimizingPrompt ? "优化中" : "优化提示词"}
        </button>

        <div className="mt-5 grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-ink">参考图</p>
            <span className="text-xs text-ink-tertiary">{props.referenceImages.length}/3</span>
          </div>
          <button
            type="button"
            onClick={() => referenceInputRef.current?.click()}
            disabled={!supportsReferenceImages || props.isUploadingReference || props.referenceImages.length >= 3}
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-dashed border-hairline text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-tertiary"
          >
            <Icon icon={props.isUploadingReference ? "mdi:loading" : "mdi:plus"} className={`text-base ${props.isUploadingReference ? "animate-spin" : ""}`} aria-hidden />
            {props.isUploadingReference
              ? "上传中"
              : !supportsReferenceImages
                ? "当前模型不支持参考图"
                : props.referenceImages.length >= 3
                  ? "已达上限"
                  : "上传参考图"}
          </button>
          <input
            ref={referenceInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif"
            hidden
            disabled={!supportsReferenceImages || props.isUploadingReference || props.referenceImages.length >= 3}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) props.onReferenceUpload(file);
              event.currentTarget.value = "";
            }}
          />
          {props.referenceImages.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="已上传参考图">
              {props.referenceImages.map((image, index) => {
                const locked = image.id === props.lockedReferenceId;
                return (
                  <div key={image.id} className="relative h-16 w-16 overflow-hidden rounded-lg border border-hairline bg-surface-muted">
                    <img src={image.thumbnailUrl || image.originalUrl} alt={`参考图 ${index + 1}`} className="h-full w-full object-cover" />
                    {locked ? (
                      <span className="absolute inset-x-0 bottom-0 bg-scrim/65 py-0.5 text-center text-[10px] font-semibold text-white">来源图</span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`移除参考图 ${index + 1}`}
                        onClick={() => props.onRemoveReference(image.id)}
                        className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-scrim/65 text-white"
                      >
                        <Icon icon="mdi:close" className="text-sm" aria-hidden />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-5 grid gap-2 text-sm font-semibold text-ink">
          模型
          <InAppSelect
            icon="mdi:creation-outline"
            label="模型"
            value={props.model}
            options={IMAGE_MODEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => {
              if (isImageModel(value)) props.onModelChange(value);
            }}
          />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="grid gap-2 text-sm font-semibold text-ink">
            比例
            <InAppSelect
              icon="mdi:aspect-ratio"
              label="比例"
              value={props.aspectRatio}
              options={IMAGE_ASPECT_RATIO_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(value) => {
                if (isImageAspectRatio(value)) props.onAspectRatioChange(value);
              }}
            />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink">
            分辨率
            <InAppSelect
              icon="mdi:high-definition"
              label="分辨率"
              value={props.resolution}
              options={IMAGE_RESOLUTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(value) => {
                if (isImageResolution(value)) props.onResolutionChange(value);
              }}
            />
          </div>
        </div>

        <div className="mt-5 grid gap-2">
          <p className="text-sm font-semibold text-ink">批量数量</p>
          <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-hairline bg-surface">
            {QUICK_COUNTS.map((count) => (
              <button
                key={count}
                type="button"
                onClick={() => props.onQuickCountChange(count)}
                className={`h-9 border-r border-hairline-subtle text-sm font-semibold last:border-r-0 ${
                  props.selectedQuickCount === count ? "bg-brand-soft text-brand-ink" : "text-ink-secondary"
                }`}
              >
                {count}
              </button>
            ))}
          </div>
          <input
            id="workflow-image-count"
            aria-label="批量张数"
            value={props.countInput}
            inputMode="numeric"
            max={IMAGE_MAX_COUNT}
            onChange={(event) => props.onCountInputChange(event.target.value)}
            className="h-10 rounded-lg border border-hairline px-3 outline-none focus:border-brand"
          />
        </div>

        {props.error && <p role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger-ink">{props.error}</p>}
        {props.notice && !props.error && <p className="mt-4 rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand-ink">{props.notice}</p>}
      </div>

      <SubmitBar
        submitLabel={props.isEditing ? "生成新版本" : "生成图片"}
        submitIcon={props.isEditing ? "mdi:source-branch" : "mdi:image-plus-outline"}
        onSubmit={props.onSubmit}
      />
    </aside>
  );
}
