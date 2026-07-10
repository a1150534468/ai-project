import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import { RippleButton, spring } from "../../motion";
import { InAppSelect } from "../agent-teams/InAppSelect";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_MAX_COUNT,
  IMAGE_RESOLUTION_OPTIONS,
  isImageAspectRatio,
  isImageResolution,
  type ImageAspectRatio,
  type ImageResolution,
  type ImageTask,
  type ImageTaskStatus,
} from "../../workflowState";
import type { WorkflowImageAsset } from "../../api";

interface ImageWorkflowStudioProps {
  readonly prompt: string;
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
  readonly isGenerating: boolean;
  readonly generatingCount: number;
  readonly cancellingTaskIds?: readonly string[];
  readonly isOptimizingPrompt: boolean;
  readonly estimatedPointCost?: number | null;
  readonly onPromptChange: (value: string) => void;
  readonly onAspectRatioChange: (value: ImageAspectRatio) => void;
  readonly onResolutionChange: (value: ImageResolution) => void;
  readonly onCountInputChange: (value: string) => void;
  readonly onQuickCountChange: (value: number) => void;
  readonly onSubmit: () => void;
  readonly onCancelTask: (task: ImageTask) => void;
  readonly onSelectTask: (task: ImageTask) => void;
  readonly onSelectHistoryImage: (image: WorkflowImageAsset) => void;
  readonly onOptimizePrompt: () => void;
  readonly onDownloadOne: (image: WorkflowImageAsset) => void;
  readonly onDownloadAll: () => void;
}

const QUICK_COUNTS = [1, 2, 4, 8] as const;

const STATUS_LABELS: Record<ImageTaskStatus, string> = {
  queued: "排队中",
  running: "正在生成",
  completed: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
};

const TASK_PILL_CLASSES: Record<ImageTaskStatus, string> = {
  queued: "bg-orange-50 text-orange-700",
  running: "bg-brand-soft text-brand-ink",
  completed: "bg-gray-100 text-gray-600",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

function formatTaskTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function promptSummary(prompt: string): string {
  return prompt.length > 34 ? `${prompt.slice(0, 34)}...` : prompt;
}

function countByStatus(tasks: readonly ImageTask[], status: ImageTaskStatus): number {
  return tasks.filter((task) => task.status === status).length;
}

export function ImageWorkflowStudio({
  prompt,
  size,
  aspectRatio,
  resolution,
  countInput,
  selectedQuickCount,
  error,
  notice,
  tasks,
  images,
  previewImages,
  selectedRequestId = null,
  isGenerating,
  generatingCount,
  cancellingTaskIds = [],
  isOptimizingPrompt,
  estimatedPointCost = null,
  onPromptChange,
  onAspectRatioChange,
  onResolutionChange,
  onCountInputChange,
  onQuickCountChange,
  onSubmit,
  onCancelTask,
  onSelectTask,
  onSelectHistoryImage,
  onOptimizePrompt,
  onDownloadOne,
  onDownloadAll,
}: ImageWorkflowStudioProps) {
  const loadingSlots = isGenerating ? Array.from({ length: Math.max(generatingCount, 1) }, (_value, index) => index) : [];
  const visiblePreviewImages = previewImages.slice(0, 6);
  const emptySlots = !isGenerating && visiblePreviewImages.length === 0 ? Array.from({ length: 6 }, (_value, index) => index) : [];
  const cancellingTaskSet = new Set(cancellingTaskIds);

  const activeTaskCount = tasks.filter((task) => task.status === "queued" || task.status === "running").length;

  return (
    <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(300px,400px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)_minmax(280px,320px)]">
      <aside className="rounded-[14px] border border-[#e8e8ed] bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-[#1d1d1f]">生图配置</h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            比例
            <InAppSelect
              icon="mdi:aspect-ratio"
              label="比例"
              value={aspectRatio}
              options={IMAGE_ASPECT_RATIO_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(value) => {
                if (isImageAspectRatio(value)) onAspectRatioChange(value);
              }}
            />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            分辨率
            <InAppSelect
              icon="mdi:high-definition"
              label="分辨率"
              value={resolution}
              options={IMAGE_RESOLUTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(value) => {
                if (isImageResolution(value)) onResolutionChange(value);
              }}
            />
          </div>
        </div>
        <p className="mt-2 rounded-[9px] bg-[#f7faf9] px-3 py-2 text-xs font-semibold text-[#6e6e73]">
          输出尺寸 {size}
        </p>

        <div className="mt-4 grid gap-2">
          <p className="text-sm font-semibold text-[#1d1d1f]">批量张数（最多 8 张并发）</p>
          <div className="grid grid-cols-4 overflow-hidden rounded-[10px] border border-[#d2d2d7] bg-white">
            {QUICK_COUNTS.map((count) => (
              <button
                key={count}
                type="button"
                onClick={() => onQuickCountChange(count)}
                className={`h-9 border-r border-[#e8e8ed] text-sm font-semibold last:border-r-0 ${
                  selectedQuickCount === count ? "bg-brand-soft text-brand-ink" : "text-[#6e6e73]"
                }`}
              >
                {count}
              </button>
            ))}
          </div>
          <input
            id="workflow-image-count"
            aria-label="批量张数"
            value={countInput}
            inputMode="numeric"
            max={IMAGE_MAX_COUNT}
            onChange={(event) => onCountInputChange(event.target.value)}
            className="h-11 px-3"
          />
        </div>

        <label htmlFor="workflow-prompt" className="mt-4 grid gap-2 text-sm font-semibold text-[#1d1d1f]">
          提示词
          <textarea
            id="workflow-prompt"
            aria-label="提示词"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            className="min-h-[122px] resize-y p-3 leading-6"
          />
        </label>

        {error && <p className="mt-3 rounded-[10px] bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {notice && !error && <p className="mt-3 rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{notice}</p>}

        {estimatedPointCost !== null && (
          <p className="mt-3 flex items-center gap-1.5 rounded-[10px] bg-[#f7faf9] px-3 py-2 text-xs font-semibold text-[#6e6e73]">
            <Icon icon="mdi:diamond-stone" className="text-sm text-brand-ink" aria-hidden />
            生成图片约消耗 <span className="text-brand-ink">{estimatedPointCost}</span> 算力点
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <RippleButton
            type="button"
            onClick={onSubmit}
            className="h-11 rounded-[10px] bg-brand text-sm font-semibold text-white hover:bg-brand-hover"
          >
            生成图片
          </RippleButton>
          <RippleButton
            type="button"
            onClick={onOptimizePrompt}
            disabled={isOptimizingPrompt}
            className="h-11 rounded-[10px] border border-[#d2d2d7] text-sm font-semibold text-[#1d1d1f] hover:border-brand/40 hover:text-brand-ink disabled:cursor-not-allowed disabled:bg-[#f5f5f7] disabled:text-[#8a8a8f]"
          >
            {isOptimizingPrompt ? "优化中" : "优化提示词"}
          </RippleButton>
          <button type="button" className="h-11 rounded-[10px] border border-[#d2d2d7] text-sm font-semibold text-[#1d1d1f] hover:border-brand/40 hover:text-brand-ink">
            收藏夹
          </button>
          <button type="button" className="h-11 rounded-[10px] border border-[#d2d2d7] text-sm font-semibold text-[#1d1d1f] hover:border-brand/40 hover:text-brand-ink">
            收藏当前
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          <p className="text-sm font-semibold text-[#1d1d1f]">参考图 (0/5)</p>
          <button type="button" className="flex h-10 items-center justify-center gap-2 rounded-[10px] border border-dashed border-[#d2d2d7] text-sm font-semibold text-[#1d1d1f]">
            <Icon icon="mdi:plus" className="text-base" aria-hidden />
            上传参考图
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[#1d1d1f]">最近生成（{images.length} / 50）</p>
            <button
              type="button"
              onClick={onDownloadAll}
              disabled={images.length === 0}
              className="text-xs font-semibold text-brand-ink hover:text-brand-hover disabled:cursor-not-allowed disabled:text-[#8a8a8f]"
            >
              全部原图链接
            </button>
          </div>
          <div
            aria-label="最近生成历史记录"
            className="grid max-h-64 gap-2 overflow-y-auto pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]"
          >
            {images.length > 0 ? (
              images.map((image) => {
                const selected = selectedRequestId === image.requestId;
                return (
                  <button
                    key={image.id}
                    type="button"
                    onClick={() => onSelectHistoryImage(image)}
                    className={`grid min-h-[70px] grid-cols-[54px_minmax(0,1fr)] items-center gap-3 rounded-[10px] border p-2 text-left transition ${
                      selected
                        ? "border-brand bg-brand-soft text-brand-ink"
                        : "border-[#e8e8ed] bg-white text-[#1d1d1f] hover:border-brand/40 hover:bg-[#f7faf9] hover:text-brand-ink"
                    }`}
                    title={image.prompt}
                  >
                    <span className="block h-[54px] w-[54px] overflow-hidden rounded-[8px] bg-[#f7faf9]">
                      <img src={image.thumbnailUrl} alt={promptSummary(image.prompt)} className="h-full w-full object-cover" loading="lazy" />
                    </span>
                    <span className="min-w-0">
                      <span className="block overflow-hidden text-xs font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                        {image.prompt}
                      </span>
                      <span className={`mt-1 block truncate text-[11px] font-medium ${selected ? "text-brand-ink/75" : "text-[#8a8a8f]"}`}>
                        {image.size} · 第 {image.requestIndex + 1} 张 · {formatTaskTime(image.createdAt)}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-[9px] border border-dashed border-[#d2d2d7] bg-[#f7faf9] px-3 py-3 text-center text-xs text-[#8a8a8f]">
                暂无生成图片
              </div>
            )}
          </div>
        </div>
      </aside>

      <section className="min-w-0 rounded-[14px] border border-[#e8e8ed] bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-[#1d1d1f]">生成预览</h2>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-[#e8e8ed] bg-[#f7faf9] px-3 py-1 text-xs font-semibold text-[#6e6e73]">
              队列中 {countByStatus(tasks, "queued")}
            </span>
            <span className="rounded-full border border-[#e8e8ed] bg-[#f7faf9] px-3 py-1 text-xs font-semibold text-[#6e6e73]">
              生成中 {isGenerating ? generatingCount : countByStatus(tasks, "running")}
            </span>
            <span className="rounded-full border border-[#e8e8ed] bg-[#f7faf9] px-3 py-1 text-xs font-semibold text-[#6e6e73]">
              已完成 {previewImages.length}
            </span>
          </div>
        </div>

        <div className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          {loadingSlots.map((index) => (
            <div
              key={`loading-${index}`}
              className="grid min-h-[172px] place-items-center overflow-hidden rounded-[10px] bg-brand-soft text-brand-ink"
            >
              <div className="grid justify-items-center gap-2 text-xs font-semibold">
                <span className="relative grid h-12 w-12 place-items-center">
                  <span className="absolute inset-0 rounded-full border-2 border-brand/20 border-t-brand animate-spin" />
                  <Icon icon="mdi:image-plus-outline" className="text-2xl" aria-hidden />
                </span>
                <span>正在生成</span>
              </div>
            </div>
          ))}
          {visiblePreviewImages.map((image) => (
            <article key={image.id} className="group relative aspect-[4/3] min-h-[172px] overflow-hidden rounded-[10px] bg-[#f7faf9]">
              <img src={image.thumbnailUrl} alt={promptSummary(image.prompt)} className="h-full w-full object-cover" loading="lazy" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent p-3 text-xs font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                <p className="truncate">{promptSummary(image.prompt)}</p>
              </div>
              <button
                type="button"
                onClick={() => onDownloadOne(image)}
                className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-[8px] bg-white/95 text-[#1d1d1f] opacity-0 shadow-[0_8px_18px_rgba(15,23,42,0.12)] transition-opacity hover:text-brand-ink focus-visible:opacity-100 group-hover:opacity-100"
                aria-label="查看原图下载链接"
              >
                <Icon icon="mdi:download-outline" className="text-lg" aria-hidden />
              </button>
            </article>
          ))}
          {emptySlots.map((index) => (
            <div key={`empty-${index}`} className="grid min-h-[172px] place-items-center overflow-hidden rounded-[10px] bg-[#eceff3] text-[#9aa3af]">
              <div className="grid justify-items-center gap-2 text-xs font-semibold">
                <Icon icon="mdi:image-plus-outline" className="text-3xl" aria-hidden />
                <span>等待生成</span>
              </div>
            </div>
          ))}
        </div>

      </section>

      <aside className="rounded-[14px] border border-[#e8e8ed] bg-white p-4 shadow-[0_16px_44px_rgba(15,23,42,0.055)] 2xl:sticky 2xl:top-6 2xl:self-start">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-[#1d1d1f]">任务队列</h2>
          {activeTaskCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand-ink">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
              </span>
              {activeTaskCount} 个生成中
            </span>
          )}
        </div>

        <div className="grid max-h-[72vh] gap-3 overflow-y-auto pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]">
          {tasks.length > 0 ? (
            <AnimatePresence mode="popLayout" initial={false}>
              {tasks.map((task) => {
                const active = task.status === "queued" || task.status === "running";
                const selected = selectedRequestId === task.id;
                const done = Math.min(task.completedCount ?? 0, task.count);
                const progressPercent = task.count > 0 ? (done / task.count) * 100 : 0;
                const barPercent = task.status === "running" ? Math.max(progressPercent, 8) : progressPercent;
                return (
                  <motion.div
                    layout
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectTask(task)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectTask(task);
                      }
                    }}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={spring.smooth}
                    title={task.prompt}
                    className={`relative cursor-pointer overflow-hidden rounded-[11px] border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                      selected
                        ? "border-brand bg-brand-soft"
                        : active
                          ? "border-brand/40 bg-white"
                          : "border-[#e8e8ed] bg-[#f7faf9] hover:border-brand/40"
                    }`}
                  >
                    {active && (
                      <motion.span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-brand/10 to-transparent"
                        initial={{ x: "-100%" }}
                        animate={{ x: "100%" }}
                        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                      />
                    )}
                    <div className="relative flex items-start justify-between gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#1d1d1f]">{promptSummary(task.prompt)}</h3>
                      <span className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-semibold ${TASK_PILL_CLASSES[task.status]}`}>
                        {task.status === "running" && task.error ? "正在重试" : STATUS_LABELS[task.status]}
                      </span>
                    </div>
                    <p className="relative mt-1 text-[11px] text-[#8a8a8f]">
                      {task.size} · {done}/{task.count} 张 · {formatTaskTime(task.createdAt)}
                    </p>
                    {active && (
                      <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-[#e8e8ed]">
                        <motion.span
                          className="block h-full rounded-full bg-brand"
                          initial={false}
                          animate={{ width: `${barPercent}%` }}
                          transition={spring.smooth}
                        />
                        {task.status === "running" && (
                          <motion.span
                            aria-hidden
                            className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/70 to-transparent"
                            initial={{ x: "-100%" }}
                            animate={{ x: "260%" }}
                            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                          />
                        )}
                      </div>
                    )}
                    {task.error && <p className="relative mt-1 truncate text-[11px] text-red-600">{task.error}</p>}
                    {active && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCancelTask(task);
                        }}
                        disabled={cancellingTaskSet.has(task.id)}
                        className="relative mt-2 inline-flex h-7 items-center rounded-[7px] border border-red-200 px-2.5 text-[11px] font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-[#e8e8ed] disabled:bg-[#f5f5f7] disabled:text-[#8a8a8f]"
                        aria-label={`取消生图任务 ${promptSummary(task.prompt)}`}
                      >
                        {cancellingTaskSet.has(task.id) ? "取消中" : "取消任务"}
                      </button>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          ) : (
            <div className="rounded-[11px] border border-dashed border-[#d2d2d7] bg-[#f7faf9] p-5 text-center text-sm text-[#8a8a8f]">
              暂无生图任务
            </div>
          )}
        </div>
      </aside>
    </section>
  );
}
