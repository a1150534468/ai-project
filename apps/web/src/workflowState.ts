export type WorkflowModuleId =
  | "image"
  | "novel"
  | "commerce-long-image"
  | "codex-pet"
  | "local-business-promo"
  | "article-workflow"
  | "ai-comic"
  | "scheduled-task"
  | "ppt";

export type WorkflowModuleStatus = "available" | "developing";

export interface WorkflowModule {
  readonly id: WorkflowModuleId;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly status: WorkflowModuleStatus;
}

export interface ImageSizeOption {
  readonly value: string;
  readonly label: string;
}

export interface ImageAspectRatioOption {
  readonly value: ImageAspectRatio;
  readonly label: string;
}

export interface ImageResolutionOption {
  readonly value: ImageResolution;
  readonly label: string;
}

export interface ImageModelOption {
  readonly value: ImageModel;
  readonly label: string;
  readonly supportsReferenceImages: boolean;
}

const IMAGE_ASPECT_RATIO_VALUES = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"] as const;
const IMAGE_RESOLUTION_VALUES = ["1K", "2K"] as const;
const IMAGE_MODEL_VALUES = ["qwen-image-2.0-pro-2026-04-22", "gpt-image-2", "doubao-seedream-4-5-251128"] as const;

export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIO_VALUES[number];
export type ImageResolution = typeof IMAGE_RESOLUTION_VALUES[number];
export type ImageModel = typeof IMAGE_MODEL_VALUES[number];

export type ImageTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ImageGenerationIntent = "new" | "variation" | "edit";
export type ImageWorkspaceMode = "empty" | "result" | "editing" | "comparing";

export interface ImageSubmissionContext {
  readonly generationIntent: ImageGenerationIntent;
  readonly sourceImageAssetId: string | null;
}

export interface ImageTask {
  readonly id: string;
  readonly prompt: string;
  readonly model?: ImageModel;
  readonly size: string;
  readonly referenceAssetIds?: readonly string[];
  readonly sourceImageAssetId?: string | null;
  readonly generationIntent?: ImageGenerationIntent;
  readonly count: number;
  readonly status: ImageTaskStatus;
  readonly completedCount?: number;
  readonly error?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface ImageTaskInput {
  readonly id: string;
  readonly prompt: string;
  readonly size: string;
  readonly count: number;
  readonly createdAt: string;
}

export type ParseImageCountResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

export interface ImageTaskSummary {
  readonly runningTasks: number;
  readonly completedImages: number;
  readonly failedTasks: number;
}

export const IMAGE_MAX_COUNT = 8;

export const IMAGE_ASPECT_RATIO_OPTIONS: readonly ImageAspectRatioOption[] = [
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "21:9", label: "21:9" },
] as const;

export const IMAGE_RESOLUTION_OPTIONS: readonly ImageResolutionOption[] = [
  { value: "1K", label: "1K" },
  { value: "2K", label: "2K" },
] as const;

export const IMAGE_MODEL_OPTIONS: readonly ImageModelOption[] = [
  { value: "qwen-image-2.0-pro-2026-04-22", label: "Qwen Image 2.0 Pro", supportsReferenceImages: true },
  { value: "gpt-image-2", label: "GPT Image 2", supportsReferenceImages: true },
  { value: "doubao-seedream-4-5-251128", label: "豆包 Seedream 4.5", supportsReferenceImages: true },
] as const;

const IMAGE_SIZE_BY_RATIO_AND_RESOLUTION = {
  "1:1": { "1K": "1024x1024", "2K": "2048x2048" },
  "4:3": { "1K": "1024x768", "2K": "2048x1536" },
  "3:4": { "1K": "768x1024", "2K": "1536x2048" },
  "3:2": { "1K": "1536x1024", "2K": "2048x1360" },
  "2:3": { "1K": "1024x1536", "2K": "1360x2048" },
  "16:9": { "1K": "1536x864", "2K": "2048x1152" },
  "9:16": { "1K": "864x1536", "2K": "1152x2048" },
  "21:9": { "1K": "2016x864", "2K": "2688x1152" },
} as const satisfies Record<ImageAspectRatio, Record<ImageResolution, string>>;

export const IMAGE_SIZE_OPTIONS: readonly ImageSizeOption[] = IMAGE_ASPECT_RATIO_OPTIONS.flatMap((ratioOption) =>
  IMAGE_RESOLUTION_OPTIONS.map((resolutionOption) => {
    const size = IMAGE_SIZE_BY_RATIO_AND_RESOLUTION[ratioOption.value][resolutionOption.value];
    return {
      value: size,
      label: `${resolutionOption.label} · ${ratioOption.label} · ${size}`,
    };
  })
);

export function buildImageSize(aspectRatio: ImageAspectRatio, resolution: ImageResolution): string {
  return IMAGE_SIZE_BY_RATIO_AND_RESOLUTION[aspectRatio][resolution];
}

export function resolveImageSizeSelection(size: string): { readonly aspectRatio: ImageAspectRatio; readonly resolution: ImageResolution } | null {
  for (const aspectRatio of IMAGE_ASPECT_RATIO_VALUES) {
    for (const resolution of IMAGE_RESOLUTION_VALUES) {
      if (IMAGE_SIZE_BY_RATIO_AND_RESOLUTION[aspectRatio][resolution] === size) {
        return { aspectRatio, resolution };
      }
    }
  }
  return null;
}

export function resolveImageSubmissionContext(
  workspaceMode: ImageWorkspaceMode,
  generationIntent: ImageGenerationIntent,
  sourceImageAssetId: string | null,
): ImageSubmissionContext {
  return workspaceMode === "editing"
    ? { generationIntent, sourceImageAssetId }
    : { generationIntent: "new", sourceImageAssetId: null };
}

export function resolveImageVersionComparison(
  task: ImageTask | null | undefined,
  candidateImageId: string | null | undefined,
): readonly [string, string] | null {
  if (task?.status !== "completed" || task.generationIntent === "new" || !task.sourceImageAssetId || !candidateImageId) {
    return null;
  }
  return [task.sourceImageAssetId, candidateImageId];
}

export function isImageAspectRatio(value: string): value is ImageAspectRatio {
  return IMAGE_ASPECT_RATIO_OPTIONS.some((option) => option.value === value);
}

export function isImageResolution(value: string): value is ImageResolution {
  return IMAGE_RESOLUTION_OPTIONS.some((option) => option.value === value);
}

export function isImageModel(value: string): value is ImageModel {
  return IMAGE_MODEL_OPTIONS.some((option) => option.value === value);
}

export const WORKFLOW_MODULES: readonly WorkflowModule[] = [
  {
    id: "image",
    title: "生图模块",
    description: "批量生图、提示词优化、参考图管理",
    icon: "mdi:image-multiple-outline",
    status: "available",
  },
  {
    id: "novel",
    title: "小说模块",
    description: "长篇结构、章节生成、人物设定",
    icon: "mdi:book-open-page-variant-outline",
    status: "available",
  },
  {
    id: "commerce-long-image",
    title: "AI 电商图",
    description: "电商主图 + 详情长图，一次出图",
    icon: "mdi:view-agenda-outline",
    status: "available",
  },
  {
    id: "codex-pet",
    title: "Codex 桌宠工坊",
    description: "参考图或文字生成，可直接安装到 Codex",
    icon: "mdi:egg-easter",
    status: "available",
  },
  {
    id: "article-workflow",
    title: "多平台图文工作流",
    description: "一篇原文生成公众号 / 小红书 / 抖音三版图文，配图排版后可编辑复制",
    icon: "mdi:newspaper-variant-outline",
    status: "available",
  },
  {
    id: "local-business-promo",
    title: "本地商家宣传剪辑",
    description: "商家资料、口播文案、多段生成、成片拼接",
    icon: "mdi:movie-open-play-outline",
    status: "available",
  },
  {
    id: "ai-comic",
    title: "AI 漫剧",
    description: "项目设定、脚本、资产、分镜、视频渲染",
    icon: "mdi:filmstrip-box-multiple",
    status: "available",
  },
  {
    id: "scheduled-task",
    title: "定时任务",
    description: "定时运行、周期触发、结果追踪",
    icon: "mdi:calendar-clock-outline",
    status: "available",
  },
  {
    id: "ppt",
    title: "PPT 助手",
    description: "大纲生成、页面规划、演示文稿",
    icon: "mdi:file-presentation-box-outline",
    status: "developing",
  },
] as const;

export function parseImageCount(raw: string): ParseImageCountResult {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "张数必须是整数" };
  }

  const value = Number.parseInt(trimmed, 10);
  if (value < 1) {
    return { ok: false, error: "张数至少为 1" };
  }
  if (value > IMAGE_MAX_COUNT) {
    return { ok: false, error: `最多生成 ${IMAGE_MAX_COUNT} 张` };
  }
  return { ok: true, value };
}

export function createImageTask(input: ImageTaskInput): ImageTask {
  return {
    id: input.id,
    prompt: input.prompt.trim(),
    size: input.size,
    count: input.count,
    status: "queued",
    createdAt: input.createdAt,
  };
}

export function advanceImageTaskStatus(task: ImageTask, status: ImageTaskStatus): ImageTask {
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return task;
  }
  return {
    ...task,
    status,
    completedCount: status === "completed" ? task.count : task.completedCount,
  };
}

export function summarizeImageTasks(tasks: readonly ImageTask[]): ImageTaskSummary {
  let runningTasks = 0;
  let completedImages = 0;
  let failedTasks = 0;

  for (const task of tasks) {
    if (task.status === "queued" || task.status === "running") {
      runningTasks += 1;
    }
    completedImages += task.completedCount ?? (task.status === "completed" ? task.count : 0);
    if (task.status === "failed") {
      failedTasks += 1;
    }
  }

  return { runningTasks, completedImages, failedTasks };
}
