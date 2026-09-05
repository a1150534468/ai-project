/**
 * 生图工作区的常量、草稿类型与纯函数。P2.4 批次二从 `pages/Workflow.tsx` 原样搬出,
 * 页面本体只留「布局 + Hub tab + 模块分发」,编排逻辑在 `useImageWorkflowStudio`。
 *
 * 四条不能动的规则:
 *  - **`mergeTask` 只保留 12 条,且把刚更新的那条顶到最前**:任务列表的展示顺序就是这个数组顺序,
 *    「最近任务」抽屉靠它排序,截断长度改了会直接改变用户看到的历史条数。
 *  - **`isActiveTask` 只认 `queued` / `running`**:轮询是否继续、剩余张数怎么算、能不能取消,
 *    三处判断共用它,不要在某一处另写一份状态集合。
 *  - **`remainingImageCount` 要用 `Math.max(..., 0)` 兜底**:后端 `completedCount` 可能超过 `count`
 *    (重试补齐时),不兜就会算出负数把总数拉低。
 *  - **参考图的体积 / MIME 限制是前端预检**,后端还会再校验一次;这里放宽不会放宽真实约束,
 *    只会把错误从「点按钮立刻提示」推迟到「上传失败」。
 */
import type { WorkflowImageAsset, WorkflowImageTask } from "../../api";
import type {
  ImageAspectRatio,
  ImageModel,
  ImageResolution,
  ImageTask,
} from "../../workflowState";

export const DEFAULT_PROMPT = "陶瓷浅色餐盘，米白色桌布，绿色植物虚化背景，夏日野餐氛围，品牌感强，现代餐饮视觉设计。";
export const DEFAULT_ASPECT_RATIO: ImageAspectRatio = "1:1";
export const DEFAULT_RESOLUTION: ImageResolution = "1K";
export const DEFAULT_IMAGE_MODEL: ImageModel = "qwen-image-2.0-pro-2026-04-22";
export const TASK_POLL_MS = 3000;
export const IMAGE_MAX_REFERENCE_COUNT = 3;
export const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_REFERENCE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif"]);

export interface ImageDraft {
  readonly prompt: string;
  readonly model: ImageModel;
  readonly aspectRatio: ImageAspectRatio;
  readonly resolution: ImageResolution;
  readonly countInput: string;
  readonly referenceImages: readonly WorkflowImageAsset[];
}

export const DEFAULT_IMAGE_DRAFT: ImageDraft = {
  prompt: DEFAULT_PROMPT,
  model: DEFAULT_IMAGE_MODEL,
  aspectRatio: DEFAULT_ASPECT_RATIO,
  resolution: DEFAULT_RESOLUTION,
  countInput: "1",
  referenceImages: [],
};

export function createRequestId(prefix = "img-"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}${crypto.randomUUID()}`;
  }
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function toImageTask(task: WorkflowImageTask): ImageTask {
  return {
    id: task.requestId,
    prompt: task.prompt,
    model: task.model as ImageModel,
    size: task.size,
    referenceAssetIds: task.referenceAssetIds,
    sourceImageAssetId: task.sourceImageAssetId,
    generationIntent: task.generationIntent,
    count: task.count,
    status: task.status,
    completedCount: task.completedCount,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function mergeTask(tasks: readonly ImageTask[], task: ImageTask): readonly ImageTask[] {
  const withoutCurrent = tasks.filter((item) => item.id !== task.id);
  return [task, ...withoutCurrent].slice(0, 12);
}

export function isActiveTask(task: ImageTask): boolean {
  return task.status === "queued" || task.status === "running";
}

export function remainingImageCount(tasks: readonly ImageTask[]): number {
  return tasks
    .filter(isActiveTask)
    .reduce((sum, task) => sum + Math.max(task.count - (task.completedCount ?? 0), 0), 0);
}
