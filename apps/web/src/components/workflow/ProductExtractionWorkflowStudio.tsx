import { useMemo, useRef } from "react";
import { Icon } from "@iconify/react";
import { InAppSelect } from "../ui/InAppSelect";
import { cx } from "../ui/cx";
import { DownloadLinkDialog } from "../ui/DownloadLinkDialog";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_MODEL_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  isImageAspectRatio,
  isImageModel,
  isImageResolution,
  type ImageTask,
} from "../../workflowState";
import { ImageHistoryStrip } from "./ImageHistoryStrip";
import { ImageResultCanvas } from "./ImageResultCanvas";
import { ImageTaskDrawer } from "./ImageTaskDrawer";
import { SubmitBar } from "./SubmitBar";
import { SETTINGS_TEXTAREA, SettingsField, SettingsGroup } from "./SettingsSlots";
import { usePanelVisibility } from "./panelVisibility";
import { WF_PANEL, WF_PANEL_HEAD, wfShell, WF_WORKSPACE } from "./workflowLayout";
import {
  buildProductExtractionPrompt,
  isProductExtractionRequestId,
  PRODUCT_EXTRACTION_INITIAL_DRAFT,
  PRODUCT_EXTRACTION_REQUEST_PREFIX,
  productDescriptionFromPrompt,
} from "./productExtractionWorkflowModel";
import { useImageWorkflowStudio } from "./useImageWorkflowStudio";

interface ProductExtractionWorkflowStudioProps {
  readonly token: string;
}

const PRODUCT_DESCRIPTION_MAX_LENGTH = 1200;

export function ProductExtractionWorkflowStudio({ token }: ProductExtractionWorkflowStudioProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controller = useImageWorkflowStudio({
    token,
    initialDraft: PRODUCT_EXTRACTION_INITIAL_DRAFT,
    requestIdPrefix: PRODUCT_EXTRACTION_REQUEST_PREFIX,
    requestFilter: isProductExtractionRequestId,
    buildSubmissionPrompt: buildProductExtractionPrompt,
    requiredReferenceCount: 1,
    maxReferenceCount: 1,
    emptyPromptMessage: "请填写商品描述",
    referenceRequiredMessage: "请先上传商品原图",
    submittedMessage: "商品提取任务已提交",
    downloadPrefix: "product-extraction",
  });
  const props = controller.studioProps;
  const originalImage = props.referenceImages[0] ?? null;
  const selectedTask = props.tasks.find((task) => task.id === props.selectedRequestId) ?? null;
  const runningCount = props.tasks.filter((task) => task.status === "queued" || task.status === "running").length;
  const hasActiveTask = runningCount > 0;
  const selectImage = props.onSelectImage ?? props.onSelectHistoryImage;
  const displayImages = useMemo(
    () => props.images.map((image) => ({ ...image, prompt: productDescriptionFromPrompt(image.prompt) })),
    [props.images],
  );
  const displayTasks = useMemo(
    () => props.tasks.map((task) => ({ ...task, prompt: productDescriptionFromPrompt(task.prompt) })),
    [props.tasks],
  );
  const originalTask = (displayTask: ImageTask): ImageTask =>
    props.tasks.find((task) => task.id === displayTask.id) ?? displayTask;
  const panels = usePanelVisibility();

  /**
   * 骨架与「通用生图」共用一套三区几何（`WF_SHELL`：左设置 360 / 中工作区 / 右历史 300，
   * 留缝 14px + 圆角卡）。改版前这里是「通栏直角两栏 + 历史条贴底」，与隔壁通用生图一个圆角
   * 一个直角 —— 同一个生图模块里切场景就要重新认一遍边界，这次一并收掉。
   */
  return (
    <section data-testid="product-extraction-studio" className={wfShell(panels.left, panels.right)}>
      {/* 左栏由顶栏「面板开关」控制：收起的那一列连缝一起从栅格里消失，工作区直接吃掉那份宽度。 */}
      {panels.left && (
        <aside className={cx(WF_PANEL, "xl:h-full")}>
        <div className={WF_PANEL_HEAD}>
          <h2 className="min-w-0 truncate text-sm font-semibold text-ink">提取商品</h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
          <SettingsGroup title="输入">
            <SettingsField label={<>商品原图 <span className="text-danger-ink">*</span></>} hint="1 张">
              <div className="relative aspect-[4/3] overflow-hidden rounded-[10px] border border-dashed border-hairline bg-surface-subtle">
                {originalImage ? (
                  <>
                    <img
                      src={originalImage.thumbnailUrl || originalImage.originalUrl}
                      alt="商品原图"
                      className="h-full w-full object-contain"
                    />
                    <button
                      type="button"
                      onClick={() => props.onRemoveReference(originalImage.id)}
                      disabled={props.isUploadingReference || hasActiveTask}
                      aria-label="删除商品原图"
                      title="删除商品原图"
                      className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-scrim/65 text-white disabled:opacity-40"
                    >
                      <Icon icon="mdi:close" className="text-lg" aria-hidden />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={props.isUploadingReference || hasActiveTask}
                    className="flex h-full w-full flex-col items-center justify-center text-ink-secondary disabled:opacity-50"
                  >
                    <Icon
                      icon={props.isUploadingReference ? "mdi:loading" : "mdi:image-plus-outline"}
                      className={`text-3xl ${props.isUploadingReference ? "animate-spin" : ""}`}
                      aria-hidden
                    />
                    <span className="mt-2 text-sm font-semibold">
                      {props.isUploadingReference ? "上传中" : "上传商品原图"}
                    </span>
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                data-testid="product-extraction-file-input"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif"
                hidden
                disabled={props.isUploadingReference || hasActiveTask || Boolean(originalImage)}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) props.onReferenceUpload(file);
                  event.currentTarget.value = "";
                }}
              />
            </SettingsField>

            <SettingsField
              label={<>商品描述 <span className="sr-only">必填</span></>}
              htmlFor="product-extraction-description"
            >
              <textarea
                id="product-extraction-description"
                aria-label="商品描述"
                value={props.prompt}
                maxLength={PRODUCT_DESCRIPTION_MAX_LENGTH}
                onChange={(event) => props.onPromptChange(event.target.value)}
                placeholder="例如：黑色皮质单肩包，保留金色搭扣和正面品牌标识"
                className={cx(SETTINGS_TEXTAREA, "min-h-[112px]")}
              />
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
              <SettingsField label="画面比例">
                <InAppSelect
                  icon="mdi:aspect-ratio"
                  label="画面比例"
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
          </SettingsGroup>
        </div>

        <SubmitBar
          submitLabel="提取商品"
          submitIcon="mdi:package-variant-closed"
          busy={hasActiveTask || props.isUploadingReference}
          busyLabel={props.isUploadingReference ? "上传中" : "提取中"}
          onSubmit={props.onSubmit}
        >
          {props.error && (
            <p role="alert" className="mb-3 rounded-[10px] bg-danger/10 px-3 py-2 text-sm text-danger-ink">
              {props.error}
            </p>
          )}
          {props.notice && !props.error && (
            <p className="mb-3 rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{props.notice}</p>
          )}
        </SubmitBar>
      </aside>
      )}

      <div className={WF_WORKSPACE}>
        <div className={WF_PANEL_HEAD}>
          <p className="truncate text-sm font-semibold text-ink">商品白底平铺图</p>
          <button
            type="button"
            onClick={props.onOpenTaskDrawer}
            aria-expanded={props.isTaskDrawerOpen ?? false}
            className="inline-flex h-9 flex-none items-center gap-2 rounded-[10px] border border-hairline bg-surface px-3 text-xs font-semibold text-ink"
          >
            <Icon icon="mdi:format-list-bulleted-square" className="text-base" aria-hidden />
            任务列表{runningCount > 0 ? ` · 生成中 ${runningCount}` : ""}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ImageResultCanvas
            images={props.previewImages}
            selectedImageId={props.selectedImageId}
            task={selectedTask}
            isGenerating={props.isGenerating}
            generatingCount={props.generatingCount}
            onSelectImage={selectImage}
            onModify={props.onModifyImage ?? (() => undefined)}
            onVariation={props.onVariation ?? (() => undefined)}
            onEdit={props.onEditImage ?? (() => undefined)}
            onDownload={props.onDownloadOne}
            actionMode="download-only"
            emptyText="等待商品提取"
          />
        </div>
      </div>

      {/* 历史从「工作区底部的横条」搬到右栏（统一规范 v2：左=设置、中=工作区、右=历史）。 */}
      {panels.right && (
        <ImageHistoryStrip
          variant="rail"
          images={displayImages}
          selectedImageId={props.selectedImageId}
          onSelectImage={props.onSelectHistoryImage}
          onDownloadAll={props.onDownloadAll}
        />
      )}

      <ImageTaskDrawer
        open={props.isTaskDrawerOpen ?? false}
        tasks={displayTasks}
        selectedRequestId={props.selectedRequestId}
        cancellingTaskIds={props.cancellingTaskIds ?? []}
        onClose={props.onCloseTaskDrawer ?? (() => undefined)}
        onSelectTask={(task) => props.onSelectTask(originalTask(task))}
        onCancelTask={(task) => props.onCancelTask(originalTask(task))}
        onRetryTask={(task) => props.onRetryTask?.(originalTask(task))}
      />

      {controller.downloadDialog && (
        <DownloadLinkDialog dialog={controller.downloadDialog} onClose={controller.closeDownloadDialog} />
      )}
    </section>
  );
}
