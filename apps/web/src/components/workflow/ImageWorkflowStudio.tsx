import { Icon } from "@iconify/react";
import type { WorkflowImageAsset } from "../../api";
import type {
  ImageAspectRatio,
  ImageModel,
  ImageResolution,
  ImageTask,
  ImageWorkspaceMode,
} from "../../workflowState";
import { ImageCompareView } from "./ImageCompareView";
import { ImageGenerationControls } from "./ImageGenerationControls";
import { ImageHistoryStrip } from "./ImageHistoryStrip";
import { ImageResultCanvas } from "./ImageResultCanvas";
import { ImageTaskDrawer } from "./ImageTaskDrawer";

export type { ImageWorkspaceMode } from "../../workflowState";

export interface ImageWorkflowStudioProps {
  readonly prompt: string;
  readonly model: ImageModel;
  readonly size: string;
  readonly aspectRatio: ImageAspectRatio;
  readonly resolution: ImageResolution;
  readonly countInput: string;
  readonly selectedQuickCount: number;
  readonly error: string;
  readonly notice: string;
  readonly tasks: readonly ImageTask[];
  readonly images: readonly WorkflowImageAsset[];
  readonly previewImages: readonly WorkflowImageAsset[];
  readonly selectedRequestId?: string | null;
  readonly selectedImageId?: string | null;
  readonly workspaceMode?: ImageWorkspaceMode;
  readonly editBaseImageId?: string | null;
  readonly compareImageIds?: readonly [string, string] | null;
  readonly isTaskDrawerOpen?: boolean;
  readonly isGenerating: boolean;
  readonly generatingCount: number;
  readonly cancellingTaskIds?: readonly string[];
  readonly isOptimizingPrompt: boolean;
  readonly estimatedPointCost?: number | null;
  readonly referenceImages: readonly WorkflowImageAsset[];
  readonly isUploadingReference: boolean;
  readonly onPromptChange: (value: string) => void;
  readonly onModelChange: (value: ImageModel) => void;
  readonly onAspectRatioChange: (value: ImageAspectRatio) => void;
  readonly onResolutionChange: (value: ImageResolution) => void;
  readonly onCountInputChange: (value: string) => void;
  readonly onQuickCountChange: (value: number) => void;
  readonly onSubmit: () => void;
  readonly onCancelTask: (task: ImageTask) => void;
  readonly onSelectTask: (task: ImageTask) => void;
  readonly onSelectHistoryImage: (image: WorkflowImageAsset) => void;
  readonly onSelectImage?: (image: WorkflowImageAsset) => void;
  readonly onModifyImage?: (image: WorkflowImageAsset) => void;
  readonly onVariation?: (image: WorkflowImageAsset) => void;
  readonly onEditImage?: (image: WorkflowImageAsset) => void;
  readonly onCancelEditing?: () => void;
  readonly onOpenTaskDrawer?: () => void;
  readonly onCloseTaskDrawer?: () => void;
  readonly onRetryTask?: (task: ImageTask) => void;
  readonly onSetCurrentVersion?: (image: WorkflowImageAsset) => void;
  readonly onContinueModify?: (image: WorkflowImageAsset) => void;
  readonly onOptimizePrompt: () => void;
  readonly onDownloadOne: (image: WorkflowImageAsset) => void;
  readonly onDownloadAll: () => void;
  readonly onReferenceUpload: (file: File) => void;
  readonly onRemoveReference: (assetId: string) => void;
}

function countTasks(tasks: readonly ImageTask[], status: "queued" | "running"): number {
  return tasks.filter((task) => task.status === status).length;
}

export function ImageWorkflowStudio(props: ImageWorkflowStudioProps) {
  const mode = props.workspaceMode ?? (props.previewImages.length > 0 || props.isGenerating ? "result" : "empty");
  const selectedTask = props.tasks.find((task) => task.id === props.selectedRequestId) ?? null;
  const baseImage = props.images.find((image) => image.id === props.editBaseImageId) ?? null;
  const compareOriginal = props.compareImageIds ? props.images.find((image) => image.id === props.compareImageIds?.[0]) ?? null : null;
  const compareNew = props.compareImageIds ? props.images.find((image) => image.id === props.compareImageIds?.[1]) ?? null : null;
  const selectImage = props.onSelectImage ?? props.onSelectHistoryImage;
  const modifyImage = props.onModifyImage ?? (() => undefined);
  const variation = props.onVariation ?? (() => undefined);
  const editImage = props.onEditImage ?? (() => undefined);
  const runningCount = countTasks(props.tasks, "running");

  return (
    <section className="relative min-h-0 overflow-hidden bg-white xl:grid xl:h-full xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
      <ImageGenerationControls
        prompt={props.prompt}
        model={props.model}
        size={props.size}
        aspectRatio={props.aspectRatio}
        resolution={props.resolution}
        countInput={props.countInput}
        selectedQuickCount={props.selectedQuickCount}
        error={props.error}
        notice={props.notice}
        isOptimizingPrompt={props.isOptimizingPrompt}
        estimatedPointCost={props.estimatedPointCost ?? null}
        referenceImages={props.referenceImages}
        isUploadingReference={props.isUploadingReference}
        isEditing={mode === "editing"}
        lockedReferenceId={props.editBaseImageId}
        onPromptChange={props.onPromptChange}
        onModelChange={props.onModelChange}
        onAspectRatioChange={props.onAspectRatioChange}
        onResolutionChange={props.onResolutionChange}
        onCountInputChange={props.onCountInputChange}
        onQuickCountChange={props.onQuickCountChange}
        onSubmit={props.onSubmit}
        onCancelEditing={props.onCancelEditing}
        onOptimizePrompt={props.onOptimizePrompt}
        onReferenceUpload={props.onReferenceUpload}
        onRemoveReference={props.onRemoveReference}
      />

      <div className="flex min-h-0 min-w-0 flex-col bg-[#f7f8fa] xl:h-full">
        <div className="flex h-14 flex-none items-center justify-between border-b border-[#e5e7eb] bg-white px-4 lg:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {mode === "comparing" ? "版本对比" : selectedTask?.prompt ?? "通用生图工作台"}
            </p>
          </div>
          <button
            type="button"
            onClick={props.onOpenTaskDrawer}
            aria-expanded={props.isTaskDrawerOpen ?? false}
            className="inline-flex h-9 flex-none items-center gap-2 rounded-lg border border-[#d2d2d7] bg-white px-3 text-xs font-semibold text-ink"
          >
            <Icon icon="mdi:format-list-bulleted-square" className="text-base" aria-hidden />
            任务列表{runningCount > 0 ? ` · 生成中 ${runningCount}` : ""}
          </button>
          <span className="sr-only" role="status" aria-live="polite">生成中 {runningCount}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {mode === "comparing" && props.compareImageIds ? (
            <ImageCompareView
              originalImage={compareOriginal}
              newImage={compareNew}
              onSetCurrent={props.onSetCurrentVersion ?? selectImage}
              onContinueModify={props.onContinueModify ?? editImage}
              onDownload={props.onDownloadOne}
            />
          ) : (
            <ImageResultCanvas
              images={props.previewImages}
              baseImage={mode === "editing" ? baseImage : null}
              selectedImageId={props.selectedImageId}
              task={selectedTask}
              isGenerating={props.isGenerating}
              generatingCount={props.generatingCount}
              onSelectImage={selectImage}
              onModify={modifyImage}
              onVariation={variation}
              onEdit={editImage}
              onDownload={props.onDownloadOne}
            />
          )}
        </div>

        <ImageHistoryStrip
          images={props.images}
          selectedImageId={props.selectedImageId}
          onSelectImage={props.onSelectHistoryImage}
          onDownloadAll={props.onDownloadAll}
        />
      </div>

      <ImageTaskDrawer
        open={props.isTaskDrawerOpen ?? false}
        tasks={props.tasks}
        selectedRequestId={props.selectedRequestId}
        cancellingTaskIds={props.cancellingTaskIds ?? []}
        onClose={props.onCloseTaskDrawer ?? (() => undefined)}
        onSelectTask={props.onSelectTask}
        onCancelTask={props.onCancelTask}
        onRetryTask={props.onRetryTask ?? (() => undefined)}
      />
    </section>
  );
}
