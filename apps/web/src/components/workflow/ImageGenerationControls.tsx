import { useRef } from "react";
import { Icon } from "@iconify/react";
import { InAppSelect } from "../ui/InAppSelect";
import { SubmitBar } from "./SubmitBar";
import {
  SETTINGS_CONTROL,
  SETTINGS_DROPZONE,
  SETTINGS_SEGMENT,
  SETTINGS_SEGMENT_OFF,
  SETTINGS_SEGMENT_ON,
  SETTINGS_TEXTAREA,
  SettingsField,
  SettingsGroup,
} from "./SettingsSlots";
import { cx } from "../ui/cx";
import { WF_PANEL, WF_PANEL_HEAD } from "./workflowLayout";
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

/**
 * 生图设置栏。改版后按 `SettingsSlots` 那套语言摆：栏头一行标题 + 两组字段。
 *
 * 收掉的两处旧写法：栏头原来是「生成配置」小字压着「创建图片」大字的两行式（英文/中英眉标
 * 是评审点名要删的语法），现在只剩一行；字段名统一 14px/500，控件统一 `rounded-[10px]` 弱底。
 * 字段按「输入 / 参数」分组，和小说、桌宠、图文三栏的分组层级对上。
 */
export function ImageGenerationControls(props: ImageGenerationControlsProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const supportsReferenceImages = IMAGE_MODEL_OPTIONS.find((option) => option.value === props.model)?.supportsReferenceImages ?? false;
  const referenceFull = props.referenceImages.length >= 3;

  return (
    // 卡壳与另外两区共用 `WF_PANEL`。窄屏不再给固定高度（原来是 `h-[calc(100dvh-15.5rem)] min-h-[500px]
    // max-h-[720px]` 的嵌套滚动盒）：三区在窄屏本来就是纵向堆叠、整页滚动，再套一层滚动只会难滚。
    <aside className={cx(WF_PANEL, "xl:h-full")}>
      <div className={WF_PANEL_HEAD}>
        <h2 className="min-w-0 truncate text-sm font-semibold text-ink">
          {props.isEditing ? "基于结果修改" : "创建图片"}
        </h2>
        {props.isEditing && props.onCancelEditing && (
          <button
            type="button"
            onClick={props.onCancelEditing}
            className="inline-flex h-8 flex-none items-center gap-1 rounded-[10px] px-2 text-sm font-medium text-ink-secondary"
          >
            <Icon icon="mdi:close" className="text-base" aria-hidden />
            取消编辑
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
        <SettingsGroup title="输入">
          <SettingsField label="提示词" htmlFor="workflow-prompt">
            <textarea
              id="workflow-prompt"
              aria-label="提示词"
              value={props.prompt}
              onChange={(event) => props.onPromptChange(event.target.value)}
              className={cx(SETTINGS_TEXTAREA, "min-h-[132px]")}
            />
          </SettingsField>

          <button
            type="button"
            onClick={props.onOptimizePrompt}
            disabled={props.isOptimizingPrompt}
            className={cx(SETTINGS_CONTROL, "inline-flex items-center justify-center gap-2 font-medium")}
          >
            <Icon
              icon={props.isOptimizingPrompt ? "mdi:loading" : "mdi:magic-staff"}
              className={cx("text-base", props.isOptimizingPrompt && "animate-spin")}
              aria-hidden
            />
            {props.isOptimizingPrompt ? "优化中" : "优化提示词"}
          </button>

          <SettingsField label="参考图" hint={`${props.referenceImages.length}/3`}>
            <button
              type="button"
              onClick={() => referenceInputRef.current?.click()}
              disabled={!supportsReferenceImages || props.isUploadingReference || referenceFull}
              className={cx(SETTINGS_DROPZONE, "h-10")}
            >
              <Icon
                icon={props.isUploadingReference ? "mdi:loading" : "mdi:plus"}
                className={cx("text-base", props.isUploadingReference && "animate-spin")}
                aria-hidden
              />
              {props.isUploadingReference
                ? "上传中"
                : !supportsReferenceImages
                  ? "当前模型不支持参考图"
                  : referenceFull
                    ? "已达上限"
                    : "上传参考图"}
            </button>
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif"
              hidden
              disabled={!supportsReferenceImages || props.isUploadingReference || referenceFull}
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
                    <div key={image.id} className="relative h-16 w-16 overflow-hidden rounded-[10px] border border-hairline bg-surface-subtle">
                      <img src={image.thumbnailUrl || image.originalUrl} alt={`参考图 ${index + 1}`} className="h-full w-full object-cover" />
                      {locked ? (
                        <span className="absolute inset-x-0 bottom-0 bg-scrim/65 py-0.5 text-center text-xs font-semibold text-white">来源图</span>
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
          </SettingsField>
        </SettingsGroup>

        <SettingsGroup title="参数" className="mt-5">
          <SettingsField label="模型">
            <InAppSelect
              icon="mdi:creation-outline"
              label="模型"
              value={props.model}
              options={IMAGE_MODEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(value) => {
                if (isImageModel(value)) props.onModelChange(value);
              }}
            />
          </SettingsField>

          <div className="grid grid-cols-2 gap-3">
            <SettingsField label="比例">
              <InAppSelect
                icon="mdi:aspect-ratio"
                label="比例"
                value={props.aspectRatio}
                options={IMAGE_ASPECT_RATIO_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => {
                  if (isImageAspectRatio(value)) props.onAspectRatioChange(value);
                }}
              />
            </SettingsField>
            <SettingsField label="分辨率">
              <InAppSelect
                icon="mdi:high-definition"
                label="分辨率"
                value={props.resolution}
                options={IMAGE_RESOLUTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => {
                  if (isImageResolution(value)) props.onResolutionChange(value);
                }}
              />
            </SettingsField>
          </div>

          <SettingsField label="批量数量" htmlFor="workflow-image-count" hint={`上限 ${IMAGE_MAX_COUNT}`}>
            <div className={cx(SETTINGS_SEGMENT, "grid-cols-4")}>
              {QUICK_COUNTS.map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => props.onQuickCountChange(count)}
                  className={cx(
                    "h-9 border-r border-hairline-subtle text-sm last:border-r-0",
                    props.selectedQuickCount === count ? SETTINGS_SEGMENT_ON : SETTINGS_SEGMENT_OFF,
                  )}
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
              className={SETTINGS_CONTROL}
            />
          </SettingsField>
        </SettingsGroup>

        {props.error && <p role="alert" className="mt-4 rounded-[10px] bg-danger/10 px-3 py-2 text-sm text-danger-ink">{props.error}</p>}
        {props.notice && !props.error && <p className="mt-4 rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{props.notice}</p>}
      </div>

      <SubmitBar
        submitLabel={props.isEditing ? "生成新版本" : "生成图片"}
        submitIcon={props.isEditing ? "mdi:source-branch" : "mdi:image-plus-outline"}
        onSubmit={props.onSubmit}
      />
    </aside>
  );
}
