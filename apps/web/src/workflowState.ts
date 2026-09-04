/**
 * 生图工作区与工作流 Hub 的纯状态层：模块表、尺寸与模型选项、张数校验、任务状态机。
 * 一律是纯数据与纯函数（不碰 React、不碰 fetch），页面与 hook 从这里取，测试也直接压这层。
 */

// ── 工作流 Hub ───────────────────────────────────────────────────────────────

export type WorkflowModuleId = "image" | "novel" | "codex-pet" | "article-workflow" | "ppt";

/** `developing` 的模块照样列在导航里，点进去是占位页。 */
export type WorkflowModuleStatus = "available" | "developing";

export interface WorkflowModule {
  readonly id: WorkflowModuleId;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly status: WorkflowModuleStatus;
}

/** 数组顺序就是侧栏与 Hub 卡片的展示顺序。 */
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
    id: "codex-pet",
    title: "Codex 桌宠工坊",
    description: "参考图或文字生成，可直接安装到 Codex",
    icon: "mdi:egg-easter",
    status: "available",
  },
  {
    id: "article-workflow",
    title: "多平台图文工作流",
    description: "一篇原文或一个主题生成公众号 / 小红书 / 抖音三版内容，配图排版后可编辑复制",
    icon: "mdi:newspaper-variant-outline",
    status: "available",
  },
  {
    id: "ppt",
    title: "PPT 助手",
    description: "大纲生成、页面规划、演示文稿",
    icon: "mdi:file-presentation-box-outline",
    status: "developing",
  },
];

// ── 尺寸：比例 × 分辨率 ───────────────────────────────────────────────────────

/** 下拉里的比例。顺序就是选项顺序，值本身也是给用户看的文案。 */
const IMAGE_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"] as const;

/** 分辨率档位，同样是「值即文案」。 */
const IMAGE_RESOLUTIONS = ["1K", "2K"] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];

/**
 * 界面给的是「比例 + 分辨率」，后端只认 `宽x高`，这张表是两者之间唯一的翻译。
 * 数字是挑好的档位而非算出来的（3:2 的 2K 是 2048x1360，并不严格等于 3:2），所以只能列表。
 */
const IMAGE_SIZES = {
  "1:1": { "1K": "1024x1024", "2K": "2048x2048" },
  "4:3": { "1K": "1024x768", "2K": "2048x1536" },
  "3:4": { "1K": "768x1024", "2K": "1536x2048" },
  "3:2": { "1K": "1536x1024", "2K": "2048x1360" },
  "2:3": { "1K": "1024x1536", "2K": "1360x2048" },
  "16:9": { "1K": "1536x864", "2K": "2048x1152" },
  "9:16": { "1K": "864x1536", "2K": "1152x2048" },
  "21:9": { "1K": "2016x864", "2K": "2688x1152" },
} as const satisfies Record<ImageAspectRatio, Record<ImageResolution, string>>;

export interface ImageAspectRatioOption {
  readonly value: ImageAspectRatio;
  readonly label: string;
}

export interface ImageResolutionOption {
  readonly value: ImageResolution;
  readonly label: string;
}

/** 选项从上面两张表派生，不再手抄一遍 —— 抄两份就会有一天只改了一边。 */
export const IMAGE_ASPECT_RATIO_OPTIONS: readonly ImageAspectRatioOption[] = IMAGE_ASPECT_RATIOS.map((value) => ({
  value,
  label: value,
}));

export const IMAGE_RESOLUTION_OPTIONS: readonly ImageResolutionOption[] = IMAGE_RESOLUTIONS.map((value) => ({
  value,
  label: value,
}));

export function buildImageSize(aspectRatio: ImageAspectRatio, resolution: ImageResolution): string {
  return IMAGE_SIZES[aspectRatio][resolution];
}

export interface ImageSizeSelection {
  readonly aspectRatio: ImageAspectRatio;
  readonly resolution: ImageResolution;
}

/** 尺寸串 → 两个下拉的值。表是常量，索引建一次就够，不用每次回填都扫一遍。 */
function indexSizes(): ReadonlyMap<string, ImageSizeSelection> {
  const index = new Map<string, ImageSizeSelection>();

  for (const aspectRatio of IMAGE_ASPECT_RATIOS) {
    for (const resolution of IMAGE_RESOLUTIONS) {
      const size = IMAGE_SIZES[aspectRatio][resolution];
      // 先出现的赢：现在 16 个尺寸串互不重复，这一句只是防以后加档位时撞车
      if (!index.has(size)) index.set(size, { aspectRatio, resolution });
    }
  }

  return index;
}

const SELECTION_BY_SIZE = indexSizes();

/** 任务里存的是尺寸串，重开工作区要倒着解回两个下拉；认不出来（比如后端换了档位）就返回 null。 */
export function resolveImageSizeSelection(size: string): ImageSizeSelection | null {
  return SELECTION_BY_SIZE.get(size) ?? null;
}

// ── 模型 ─────────────────────────────────────────────────────────────────────

/**
 * 可选模型。`value` 是发给后端的模型 id，只此一处；`ImageModel` 也从这里推出来，
 * 加模型只改这张表。
 */
const IMAGE_MODELS = [
  { value: "qwen-image-2.0-pro-2026-04-22", label: "Qwen Image 2.0 Pro", supportsReferenceImages: true },
  { value: "gpt-image-2", label: "GPT Image 2", supportsReferenceImages: true },
  { value: "doubao-seedream-4-5-251128", label: "豆包 Seedream 4.5", supportsReferenceImages: true },
] as const;

export type ImageModel = (typeof IMAGE_MODELS)[number]["value"];

export interface ImageModelOption {
  readonly value: ImageModel;
  readonly label: string;
  /** 不支持参考图的模型，上传区要灰掉（目前三个都支持，字段是为了下一个不支持的模型留的）。 */
  readonly supportsReferenceImages: boolean;
}

export const IMAGE_MODEL_OPTIONS: readonly ImageModelOption[] = IMAGE_MODELS;

// ── 外部值的守卫 ─────────────────────────────────────────────────────────────

/**
 * 三个下拉的值都可能来自 localStorage 或历史任务，当字面量用之前先验一遍。
 * 只读元组不能直接 `includes(string)`，所以在这里放宽一次，省得三处各写一遍断言。
 */
function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return (allowed as readonly string[]).includes(value);
}

export function isImageAspectRatio(value: string): value is ImageAspectRatio {
  return isOneOf(IMAGE_ASPECT_RATIOS, value);
}

export function isImageResolution(value: string): value is ImageResolution {
  return isOneOf(IMAGE_RESOLUTIONS, value);
}

export function isImageModel(value: string): value is ImageModel {
  return IMAGE_MODELS.some((option) => option.value === value);
}

// ── 生图任务 ─────────────────────────────────────────────────────────────────

export type ImageTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** 这次生图是新画、换个花样还是改这张图。改图才需要来源图。 */
export type ImageGenerationIntent = "new" | "variation" | "edit";

export type ImageWorkspaceMode = "empty" | "result" | "editing" | "comparing";

/**
 * 一个生图任务。除 id / 提示词 / 尺寸 / 张数 / 创建时间外都是可选的：
 * 任务先在本地建好排队，模型、参考图、进度、错误这些是后端回来之后才逐步补上的。
 */
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

/** 建任务只要这五样，其余交给 `createImageTask` 与后续更新 —— 从 `ImageTask` 挑而不是另抄一份。 */
export type ImageTaskInput = Pick<ImageTask, "id" | "prompt" | "size" | "count" | "createdAt">;

export const IMAGE_MAX_COUNT = 8;

export type ParseImageCountResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

/**
 * 张数输入框的校验。先卡「是不是纯数字」再卡范围，所以 `-1` 报的是「必须是整数」
 * 而不是「至少为 1」—— 负号、小数点、空串一律先在第一道就被拦掉。
 */
export function parseImageCount(raw: string): ParseImageCountResult {
  const digits = raw.trim();
  if (!/^\d+$/.test(digits)) return { ok: false, error: "张数必须是整数" };

  const value = Number.parseInt(digits, 10);
  if (value < 1) return { ok: false, error: "张数至少为 1" };
  if (value > IMAGE_MAX_COUNT) return { ok: false, error: `最多生成 ${IMAGE_MAX_COUNT} 张` };

  return { ok: true, value };
}

export function createImageTask(input: ImageTaskInput): ImageTask {
  const { id, prompt, size, count, createdAt } = input;

  // 提示词首尾空白不留：它既会原样发给后端，也直接显示在任务卡片上
  return { id, prompt: prompt.trim(), size, count, createdAt, status: "queued" };
}

/** 落到这三个状态就定死了。轮询和本地乐观更新可能乱序到，晚到的一律忽略。 */
const SETTLED_STATUSES: ReadonlySet<ImageTaskStatus> = new Set(["completed", "failed", "cancelled"]);

export function advanceImageTaskStatus(task: ImageTask, status: ImageTaskStatus): ImageTask {
  if (SETTLED_STATUSES.has(task.status)) return task;

  return {
    ...task,
    status,
    // 完成时把进度补满：后端只回一个状态，界面上的「几 / 几张」得自己对上
    completedCount: status === "completed" ? task.count : task.completedCount,
  };
}

// ── 工作区 ───────────────────────────────────────────────────────────────────

export interface ImageSubmissionContext {
  readonly generationIntent: ImageGenerationIntent;
  readonly sourceImageAssetId: string | null;
}

/**
 * 只有正在「改这张图」的时候才把来源图和意图带上，其余模式一律当新画一张 ——
 * 否则退出编辑后再点生成，上一张的来源图会跟着漏进请求里。
 */
export function resolveImageSubmissionContext(
  workspaceMode: ImageWorkspaceMode,
  generationIntent: ImageGenerationIntent,
  sourceImageAssetId: string | null,
): ImageSubmissionContext {
  if (workspaceMode !== "editing") return { generationIntent: "new", sourceImageAssetId: null };

  return { generationIntent, sourceImageAssetId };
}

/**
 * 「改前 / 改后」滑杆要一对图 id：改前的存在任务里，改后的是当前选中的那张。
 * 任务没跑完、本来就是新画、或者两张里缺一张，就没得比。
 */
export function resolveImageVersionComparison(
  task: ImageTask | null | undefined,
  candidateImageId: string | null | undefined,
): readonly [string, string] | null {
  if (task?.status !== "completed" || task.generationIntent === "new") return null;

  const before = task.sourceImageAssetId;
  if (!before || !candidateImageId) return null;

  return [before, candidateImageId];
}

