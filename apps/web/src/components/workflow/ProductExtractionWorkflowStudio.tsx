import { useMemo, useRef } from "react";
import { Icon } from "@iconify/react";
import { InAppSelect } from "../agent-teams/InAppSelect";
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
import { SubmitCostBar } from "./SubmitCostBar";
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
  readonly onBalanceRefresh?: () => void;
}

const PRODUCT_DESCRIPTION_MAX_LENGTH = 1200;

export function ProductExtractionWorkflowStudio({ token, onBalanceRefresh }: ProductExtractionWorkflowStudioProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controller = useImageWorkflowStudio({
    token,
    onBalanceRefresh,
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

  return (
    <section
      data-testid="product-extraction-studio"
      className="relative min-h-0 overflow-hidden bg-surface xl:grid xl:h-full xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]"
    >
      <aside className="flex h-[calc(100dvh-15.5rem)] min-h-[500px] max-h-[720px] flex-col border-b border-hairline-subtle bg-surface xl:h-full xl:min-h-0 xl:max-h-none xl:border-b-0 xl:border-r">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
          <div className="mb-4">
            <p className="text-xs font-semibold text-ink-secondary">商品处理</p>
            <h2 className="mt-1 text-base font-semibold text-ink">提取白底平铺图</h2>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-ink">
                商品原图 <span className="text-danger-ink">*</span>
              </p>
              <span className="text-xs text-ink-tertiary">1 张</span>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-dashed border-hairline bg-surface-subtle">
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
          </div>

          <label htmlFor="product-extraction-description" className="mt-5 grid gap-2 text-sm font-semibold text-ink">
            商品描述 <span className="sr-only">必填</span>
            <textarea
              id="product-extraction-description"
              aria-label="商品描述"
              value={props.prompt}
              maxLength={PRODUCT_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => props.onPromptChange(event.target.value)}
              placeholder="例如：黑色皮质单肩包，保留金色搭扣和正面品牌标识"
              className="min-h-[112px] resize-y rounded-lg border border-hairline bg-surface p-3 leading-6 outline-none focus:border-brand focus:ring-2 focus:ring-brand/10"
            />
          </label>

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
              画面比例
              <InAppSelect
                icon="mdi:aspect-ratio"
                label="画面比例"
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
        </div>

        <SubmitCostBar
          estimatedPointCost={props.estimatedPointCost ?? null}
          submitLabel="提取商品"
          submitIcon="mdi:package-variant-closed"
          busy={hasActiveTask || props.isUploadingReference}
          busyLabel={props.isUploadingReference ? "上传中" : "提取中"}
          onSubmit={props.onSubmit}
        >
          {props.error && (
            <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger-ink">
              {props.error}
            </p>
          )}
          {props.notice && !props.error && (
            <p className="mb-3 rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand-ink">{props.notice}</p>
          )}
        </SubmitCostBar>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col bg-surface-subtle xl:h-full">
        <div className="flex h-14 flex-none items-center justify-between border-b border-hairline-subtle bg-surface px-4 lg:px-6">
          <p className="truncate text-sm font-semibold text-ink">商品白底平铺图</p>
          <button
            type="button"
            onClick={props.onOpenTaskDrawer}
            aria-expanded={props.isTaskDrawerOpen ?? false}
            className="inline-flex h-9 flex-none items-center gap-2 rounded-lg border border-hairline bg-surface px-3 text-xs font-semibold text-ink"
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

        <ImageHistoryStrip
          images={displayImages}
          selectedImageId={props.selectedImageId}
          onSelectImage={props.onSelectHistoryImage}
          onDownloadAll={props.onDownloadAll}
        />
      </div>

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
