/**
 * 生图工作台的外壳：左边参数栏，右边「顶栏 + 结果区 + 历史条」，任务列表是浮层。这一层自己不存
 * 任何状态，只做三件事 —— 判当前是哪一档工作区（`mode`）、把 id 换成对象、把 props 分给四个子
 * 组件。状态全在 `useImageWorkflowStudio`；护栏 `pages/Workflow.behavior.test.tsx` 断言的是这个
 * 组件实际收到的那份 props，所以 `ImageWorkflowStudioProps` 的字段名一个都不能动。
 *
 * 重写时收掉的五处：
 *  - **四处「按 id 找对象」收成一个 `byId`**。原来 selectedTask / baseImage / compareOriginal /
 *    compareNew 各写一遍 `find(...) ?? null`，后两个还在自己的三元里把 `compareImageIds` 重测了
 *    一遍（外层刚判过，里面那个 `?.` 永远短路不到）。顺手补上 id 为空时的短路：`editBaseImageId`
 *    是 null 的那些渲染，原来照样把整条历史（最多 50 张）扫一遍去找 null。
 *  - **「算 workspaceMode 回落」整段是空转**。四档里只有 editing 与 comparing 改变这一层的渲染，
 *    `empty` 与 `result` 走的是同一条路；原来那句「不给 workspaceMode 就按有没有预览图算 result /
 *    empty」算出来的两个值下游一个都不区分。现在直接判那两档，回落连带消失。
 *  - **`countTasks(tasks, status)` 的第二档 `"queued"` 一次都没传过**，全文件只有一个调用点传
 *    `"running"`。留一个假的通用参数不如就地写成一句。
 *  - **四个 `?? (() => undefined)` 收成一个模块级 `noop`**。原来每渲染一次现造四个空函数，
 *    子组件手里的回调每轮都是新的。
 *  - **朗读区不再念「生成中 0」**。这个 `role="status"` 是有用的：按钮上的数字变了屏幕阅读器不会
 *    念，得靠它报一声。但一批任务跑完时它会念一句「生成中 0」—— 没有在跑就留空，什么都不念。
 *
 * 顺带把顶栏与结果区并到同一个判断上：`compareImageIds` 缺失时两边一起退回结果区。原来标题只看
 * mode，于是那种状态下标题写着「版本对比」而下面铺的是结果列表（hook 两个 setter 总是成对调用，
 * 只有直接渲染本组件的调用方能撞上）。
 */
import { Icon } from "@iconify/react";
import type { WorkflowImageAsset } from "../../api";
import type { ImageAspectRatio, ImageModel, ImageResolution, ImageTask, ImageWorkspaceMode } from "../../workflowState";
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

/** 可选回调的缺省值。模块级常量，子组件每轮拿到的是同一个函数。 */
const noop = () => undefined;

/** 选中任务、编辑底图、对比两侧，四处都是这一句：id 为空就不必扫数组了。 */
function byId<T extends { readonly id: string }>(items: readonly T[], id: string | null | undefined): T | null {
  if (!id) return null;
  return items.find((item) => item.id === id) ?? null;
}

export function ImageWorkflowStudio(props: ImageWorkflowStudioProps) {
  /**
   * 四档工作区里只有两档能改变这一层的渲染：editing 换掉左栏的标题与提交按钮、并把底图带进结果区，
   * comparing 换掉整个结果区。`empty` 与 `result` 在这一层是同一件事，所以只判这两档。
   */
  const editing = props.workspaceMode === "editing";
  const comparing = props.workspaceMode === "comparing" && Boolean(props.compareImageIds);
  const selectedTask = byId(props.tasks, props.selectedRequestId);
  const runningCount = props.tasks.filter((task) => task.status === "running").length;
  const selectImage = props.onSelectImage ?? props.onSelectHistoryImage;
  const editImage = props.onEditImage ?? noop;

  return (
    <section className="relative min-h-0 overflow-hidden bg-surface xl:grid xl:h-full xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
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
        referenceImages={props.referenceImages}
        isUploadingReference={props.isUploadingReference}
        isEditing={editing}
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

      <div className="flex min-h-0 min-w-0 flex-col bg-surface-subtle xl:h-full">
        <div className="flex h-14 flex-none items-center justify-between border-b border-hairline-subtle bg-surface px-4 lg:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {comparing ? "版本对比" : selectedTask?.prompt ?? "通用生图工作台"}
            </p>
          </div>
          <button
            type="button"
            onClick={props.onOpenTaskDrawer}
            aria-expanded={props.isTaskDrawerOpen ?? false}
            className="inline-flex h-9 flex-none items-center gap-2 rounded-lg border border-hairline bg-surface px-3 text-xs font-semibold text-ink"
          >
            <Icon icon="mdi:format-list-bulleted-square" className="text-base" aria-hidden />
            {runningCount > 0 ? `任务列表 · 生成中 ${runningCount}` : "任务列表"}
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {runningCount > 0 ? `生成中 ${runningCount}` : ""}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {comparing ? (
            <ImageCompareView
              originalImage={byId(props.images, props.compareImageIds?.[0])}
              newImage={byId(props.images, props.compareImageIds?.[1])}
              onSetCurrent={props.onSetCurrentVersion ?? selectImage}
              onContinueModify={props.onContinueModify ?? editImage}
              onDownload={props.onDownloadOne}
            />
          ) : (
            <ImageResultCanvas
              images={props.previewImages}
              baseImage={editing ? byId(props.images, props.editBaseImageId) : null}
              selectedImageId={props.selectedImageId}
              task={selectedTask}
              isGenerating={props.isGenerating}
              generatingCount={props.generatingCount}
              onSelectImage={selectImage}
              onModify={props.onModifyImage ?? noop}
              onVariation={props.onVariation ?? noop}
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
        onClose={props.onCloseTaskDrawer ?? noop}
        onSelectTask={props.onSelectTask}
        onCancelTask={props.onCancelTask}
        onRetryTask={props.onRetryTask ?? noop}
      />
    </section>
  );
}
