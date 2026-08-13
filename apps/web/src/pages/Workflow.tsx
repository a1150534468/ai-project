import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useToast } from "../motion";
import {
  ApiError,
  cancelWorkflowImageTask,
  generateWorkflowImages,
  getImageWorkflowPricing,
  getWorkflowImageState,
  optimizeWorkflowPrompt,
  uploadWorkflowImageReference,
  type ImageWorkflowPricing,
  type WorkflowImageAsset,
  type WorkflowImageTask,
} from "../api";
import { DownloadLinkDialog, type DownloadDialogState } from "../components/ui/DownloadLinkDialog";
import { CommerceImageStudio } from "../components/workflow/CommerceImageStudio";
import { ComicWorkflowStudio } from "../components/workflow/ComicWorkflowStudio";
import { ArticleWorkflowStudio } from "../components/workflow/ArticleWorkflowStudio";
import { ScheduledTaskStudio } from "../components/workflow/ScheduledTaskStudio";
import { ImageWorkflowStudio } from "../components/workflow/ImageWorkflowStudio";
import { PortraitWorkflowStudio } from "../components/workflow/PortraitWorkflowStudio";
import { readFileAsInlineImage } from "../components/workflow/ecomWorkflowStudioModel";
import { LocalBusinessPromoWorkflowStudio } from "../components/workflow/LocalBusinessPromoWorkflowStudio";
import { NovelWorkflowStudio } from "../components/workflow/NovelWorkflowStudio";
import { CodexPetStudio } from "../components/workflow/CodexPetStudio";
import type { EcomMainJob } from "../workflowEcomMainApi";
import type { WorkflowEcomWorkflow } from "../workflowEcomApi";
import { visibleImageHubTabs, type ClientMenuVisibility, type ImageHubTabId } from "../clientMenu";
import {
  WORKFLOW_MODULES,
  advanceImageTaskStatus,
  buildImageSize,
  createImageTask,
  type ImageAspectRatio,
  type ImageGenerationIntent,
  type ImageModel,
  type ImageResolution,
  type ImageWorkspaceMode,
  isImageModel,
  parseImageCount,
  resolveImageSizeSelection,
  resolveImageSubmissionContext,
  resolveImageVersionComparison,
  type ImageTask,
  type WorkflowModuleId,
} from "../workflowState";

const DEFAULT_PROMPT = "陶瓷浅色餐盘，米白色桌布，绿色植物虚化背景，夏日野餐氛围，品牌感强，现代餐饮视觉设计。";
const DEFAULT_ASPECT_RATIO: ImageAspectRatio = "1:1";
const DEFAULT_RESOLUTION: ImageResolution = "1K";
const DEFAULT_IMAGE_MODEL: ImageModel = "qwen-image-2.0-pro-2026-04-22";
const TASK_POLL_MS = 3000;
const IMAGE_MAX_REFERENCE_COUNT = 3;
const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_REFERENCE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif"]);

interface ImageDraft {
  readonly prompt: string;
  readonly model: ImageModel;
  readonly aspectRatio: ImageAspectRatio;
  readonly resolution: ImageResolution;
  readonly countInput: string;
  readonly referenceImages: readonly WorkflowImageAsset[];
}

const DEFAULT_IMAGE_DRAFT: ImageDraft = {
  prompt: DEFAULT_PROMPT,
  model: DEFAULT_IMAGE_MODEL,
  aspectRatio: DEFAULT_ASPECT_RATIO,
  resolution: DEFAULT_RESOLUTION,
  countInput: "1",
  referenceImages: [],
};

interface WorkflowProps {
  readonly token: string;
  readonly activeModuleId: WorkflowModuleId;
  readonly onBalanceRefresh?: () => void;
  readonly initialCodexPetProjectId?: string | null;
  readonly onOpenKnowledgeDocument?: (documentId: string) => void;
  readonly menuVisibility?: ClientMenuVisibility;
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `img-${crypto.randomUUID()}`;
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function toImageTask(task: WorkflowImageTask): ImageTask {
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

function mergeTask(tasks: readonly ImageTask[], task: ImageTask): readonly ImageTask[] {
  const withoutCurrent = tasks.filter((item) => item.id !== task.id);
  return [task, ...withoutCurrent].slice(0, 12);
}

function isActiveTask(task: ImageTask): boolean {
  return task.status === "queued" || task.status === "running";
}

function remainingImageCount(tasks: readonly ImageTask[]): number {
  return tasks
    .filter(isActiveTask)
    .reduce((sum, task) => sum + Math.max(task.count - (task.completedCount ?? 0), 0), 0);
}

const FULLSCREEN_MODULES = new Set<WorkflowModuleId>(["novel", "image", "commerce-long-image", "article-workflow", "codex-pet"]);

export default function Workflow({ token, activeModuleId, onBalanceRefresh, initialCodexPetProjectId, onOpenKnowledgeDocument, menuVisibility }: WorkflowProps) {
  const toast = useToast();
  const [imageDraft, setImageDraft] = useState<ImageDraft>(DEFAULT_IMAGE_DRAFT);
  const [preEditDraft, setPreEditDraft] = useState<ImageDraft | null>(null);
  const [tasks, setTasks] = useState<readonly ImageTask[]>([]);
  const [images, setImages] = useState<readonly WorkflowImageAsset[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<ImageWorkspaceMode>("empty");
  const [editBaseImageId, setEditBaseImageId] = useState<string | null>(null);
  const [compareImageIds, setCompareImageIds] = useState<readonly [string, string] | null>(null);
  const [isTaskDrawerOpen, setIsTaskDrawerOpen] = useState(false);
  const [isEditDirty, setIsEditDirty] = useState(false);
  const [imageGenerationIntent, setImageGenerationIntent] = useState<ImageGenerationIntent>("new");
  const [pendingVersionRequestId, setPendingVersionRequestId] = useState<string | null>(null);
  const hasInitializedImageState = useRef(false);
  const pricingRequestSeq = useRef(0);
  const retryingRequestIds = useRef<Set<string>>(new Set());
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false);
  const [isUploadingReference, setIsUploadingReference] = useState(false);
  const [cancellingTaskIds, setCancellingTaskIds] = useState<readonly string[]>([]);
  const [downloadDialog, setDownloadDialog] = useState<DownloadDialogState | null>(null);
  const [imagePricing, setImagePricing] = useState<ImageWorkflowPricing | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [commerceTab, setCommerceTab] = useState<"main" | "detail">("main");
  const [commerceLoadMainJob, setCommerceLoadMainJob] = useState<EcomMainJob | null>(null);
  const [commerceLoadDetailWorkflow, setCommerceLoadDetailWorkflow] = useState<WorkflowEcomWorkflow | null>(null);
  const [commerceHistoryKey, setCommerceHistoryKey] = useState(0);
  const activeModule = WORKFLOW_MODULES.find((module) => module.id === activeModuleId) ?? WORKFLOW_MODULES[0];
  const isFullscreen = FULLSCREEN_MODULES.has(activeModuleId);
  const showModuleHeader = activeModuleId !== "novel" && activeModuleId !== "codex-pet";
  // 全屏模式下给工作区留出页面级留白：外层满屏铺底，工作室卡片浮在灰色背景上，
  // 保留四周与顶栏之间的间距（原来的 gap / padding）。novel 自带全屏外壳，不额外缩进。
  const studioWrapperClass = isFullscreen
    ? activeModuleId === "novel"
      ? "min-w-0 min-h-0 flex-1 h-full"
      : "min-w-0 min-h-0 flex-1 px-4 py-4 lg:px-6 lg:py-5"
    : showModuleHeader
      ? "min-w-0"
      : "min-w-0 h-full";

  // 生图模块与 AI 电商图、形象照合并为同一个全屏工作区（Hub）：顶部 tab 切换。
  // 各 studio 常驻 DOM，用 hidden 切换，表单内容零丢失；tab 集合由后台菜单开关决定。
  const isImageHub = activeModuleId === "image" || activeModuleId === "commerce-long-image";
  const imageTabs = useMemo(() => visibleImageHubTabs(menuVisibility), [menuVisibility]);
  const [requestedSubMode, setRequestedSubMode] = useState<ImageHubTabId>(
    activeModuleId === "commerce-long-image" ? "ecom" : "general",
  );
  useEffect(() => {
    setRequestedSubMode(activeModuleId === "commerce-long-image" ? "ecom" : "general");
  }, [activeModuleId]);
  // 后台关掉当前 tab 时回落到第一个仍开启的 tab，不用副作用，避免多渲染一帧空白。
  const imageSubMode: ImageHubTabId | null = imageTabs.some((tab) => tab.id === requestedSubMode)
    ? requestedSubMode
    : imageTabs[0]?.id ?? null;
  const setImageSubMode = setRequestedSubMode;
  const hasImageTab = (tabId: ImageHubTabId) => imageTabs.some((tab) => tab.id === tabId);
  const { prompt, model: imageModel, aspectRatio, resolution, countInput, referenceImages } = imageDraft;
  const parsedQuickCount = Number.parseInt(countInput, 10);
  const selectedQuickCount = [1, 2, 4, 8].includes(parsedQuickCount) ? parsedQuickCount : 0;
  const size = buildImageSize(aspectRatio, resolution);
  const estimatedImagePointCost = useMemo(() => {
    const rate = imagePricing?.[resolution]?.rate;
    if (rate == null) return null;
    const parsed = parseImageCount(countInput);
    const count = parsed.ok ? parsed.value : 1;
    return rate * count;
  }, [imagePricing, resolution, countInput]);
  const previewTasks = useMemo(
    () => selectedRequestId ? tasks.filter((task) => task.id === selectedRequestId) : tasks.filter(isActiveTask),
    [selectedRequestId, tasks],
  );
  const previewImages = useMemo(
    () => selectedRequestId ? images.filter((image) => image.requestId === selectedRequestId) : [],
    [images, selectedRequestId],
  );
  const isPreviewGenerating = previewTasks.some(isActiveTask);
  const previewGeneratingCount = useMemo(
    () => remainingImageCount(previewTasks),
    [previewTasks],
  );

  const updateImageDraft = (updates: Partial<ImageDraft>, markDirty = true) => {
    setImageDraft((current) => ({ ...current, ...updates }));
    if (markDirty && workspaceMode === "editing") setIsEditDirty(true);
  };

  const refreshImageState = useCallback(async (showFailureNotice: boolean) => {
    try {
      const state = await getWorkflowImageState(token);
      const nextTasks = state.tasks.map(toImageTask);
      setImages(state.images);
      setTasks(nextTasks);

      if (!hasInitializedImageState.current) {
        hasInitializedImageState.current = true;
        const initialTask = nextTasks.find(isActiveTask) ?? nextTasks[0] ?? null;
        const initialImage = initialTask
          ? state.images.find((image) => image.requestId === initialTask.id) ?? null
          : state.images[0] ?? null;
        if (initialTask || initialImage) {
          setSelectedRequestId(initialTask?.id ?? initialImage?.requestId ?? null);
          setSelectedImageId(initialImage?.id ?? null);
          if (initialTask?.generationIntent !== "new" && initialTask?.sourceImageAssetId && initialTask.status === "completed" && initialImage) {
            setCompareImageIds([initialTask.sourceImageAssetId, initialImage.id]);
            setWorkspaceMode("comparing");
          } else {
            setWorkspaceMode("result");
          }
        }
      }
      if (showFailureNotice) setNotice("");
    } catch {
      if (showFailureNotice) setNotice("生图任务暂时无法加载");
    }
  }, [token]);

  // 模型切换会重新拉取 model 感知价格；请求计数器丢弃乱序返回的旧响应。
  const refreshImagePricing = useCallback(async (pricingModel: ImageModel) => {
    const seq = pricingRequestSeq.current + 1;
    pricingRequestSeq.current = seq;
    try {
      const next = await getImageWorkflowPricing(token, pricingModel);
      if (seq === pricingRequestSeq.current) setImagePricing(next);
    } catch {
      if (seq === pricingRequestSeq.current) setImagePricing(null);
    }
  }, [token]);

  useEffect(() => {
    void refreshImageState(true);
  }, [refreshImageState]);

  useEffect(() => {
    void refreshImagePricing(imageModel);
  }, [refreshImagePricing, imageModel]);

  useEffect(() => {
    if (!tasks.some(isActiveTask)) return undefined;
    const timer = window.setInterval(() => {
      void refreshImageState(false);
    }, TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshImageState, tasks]);

  useEffect(() => {
    if (!pendingVersionRequestId) return;
    const pendingTask = tasks.find((task) => task.id === pendingVersionRequestId);
    const candidate = images
      .filter((image) => image.requestId === pendingVersionRequestId)
      .sort((a, b) => a.requestIndex - b.requestIndex)[0];
    const comparison = resolveImageVersionComparison(pendingTask, candidate?.id);
    if (!comparison || !candidate) return;
    setCompareImageIds(comparison);
    setSelectedRequestId(candidate.requestId);
    setSelectedImageId(candidate.id);
    setWorkspaceMode("comparing");
    setPendingVersionRequestId(null);
  }, [images, pendingVersionRequestId, tasks]);

  const handleQuickCountChange = (count: number) => {
    updateImageDraft({ countInput: String(count) });
    setError("");
  };

  const handleCountInputChange = (value: string) => {
    updateImageDraft({ countInput: value });
    setError("");
  };

  const submitImageDraft = (draft: ImageDraft, intent: ImageGenerationIntent, sourceImageAssetId: string | null) => {
    const trimmedPrompt = draft.prompt.trim();
    if (!trimmedPrompt) {
      setError("请输入提示词");
      return;
    }

    const parsedCount = parseImageCount(draft.countInput);
    if (!parsedCount.ok) {
      setError(parsedCount.error);
      return;
    }
    if (intent !== "new" && !sourceImageAssetId) {
      setError("来源图片已不在最近历史中，无法继续生成新版本");
      return;
    }

    const requestId = createRequestId();
    const draftSize = buildImageSize(draft.aspectRatio, draft.resolution);
    const referenceAssetIds = Array.from(new Set([
      ...(sourceImageAssetId ? [sourceImageAssetId] : []),
      ...draft.referenceImages.map((image) => image.id),
    ])).slice(0, IMAGE_MAX_REFERENCE_COUNT);
    const task: ImageTask = {
      ...createImageTask({
      id: requestId,
      prompt: trimmedPrompt,
      size: draftSize,
      count: parsedCount.value,
      createdAt: new Date().toISOString(),
      }),
      model: draft.model,
      referenceAssetIds,
      sourceImageAssetId,
      generationIntent: intent,
    };

    setError("");
    setNotice("");
    setSelectedRequestId(requestId);
    setSelectedImageId(null);
    setTasks((prev) => mergeTask(prev, advanceImageTaskStatus(task, "running")));
    if (intent === "new") {
      setWorkspaceMode("result");
      setCompareImageIds(null);
      setEditBaseImageId(null);
      setImageGenerationIntent("new");
    } else {
      setWorkspaceMode("editing");
      setEditBaseImageId(sourceImageAssetId);
      setPendingVersionRequestId(requestId);
      setImageGenerationIntent(intent);
    }

    void (async () => {
      try {
        const result = await generateWorkflowImages(token, {
          requestId,
          model: draft.model,
          prompt: trimmedPrompt,
          size: draftSize,
          resolution: draft.resolution,
          referenceAssetIds,
          sourceImageAssetId: sourceImageAssetId ?? undefined,
          generationIntent: intent,
          count: parsedCount.value,
        });
        setImages(result.recent);
        setTasks((prev) => mergeTask(prev, toImageTask(result.task)));
        toast.show("ok", "生图任务已提交，后台生成中");
        onBalanceRefresh?.();
      } catch (err) {
        const message = err instanceof ApiError && err.status === 402 ? "积分不足，请充值" : errorMessage(err, "创建生图任务失败");
        setError(message);
        toast.show("err", message);
        setTasks((prev) => prev.map((item) => (item.id === requestId
          ? { ...item, status: "failed", error: message, updatedAt: new Date().toISOString() }
          : item)));
      }
    })();
  };

  // 每次点击都创建独立 requestId，编辑和变体也不会覆盖来源任务。
  const handleSubmit = () => {
    const context = resolveImageSubmissionContext(workspaceMode, imageGenerationIntent, editBaseImageId);
    submitImageDraft(imageDraft, context.generationIntent, context.sourceImageAssetId);
  };

  const handleReferenceUpload = (file: File) => {
    if (isUploadingReference || referenceImages.length >= IMAGE_MAX_REFERENCE_COUNT) return;
    const mime = file.type.toLowerCase();
    if (!IMAGE_REFERENCE_MIME_TYPES.has(mime)) {
      setError("参考图仅支持 JPG、PNG、WEBP、BMP、TIFF 或 GIF");
      return;
    }
    if (file.size <= 0 || file.size > IMAGE_REFERENCE_MAX_BYTES) {
      setError("参考图大小需在 10MB 以内");
      return;
    }
    setError("");
    setNotice("");
    setIsUploadingReference(true);
    void (async () => {
      try {
        const inlineImage = await readFileAsInlineImage(file);
        const asset = await uploadWorkflowImageReference(token, inlineImage);
        setImageDraft((current) => ({
          ...current,
          referenceImages: current.referenceImages.some((item) => item.id === asset.id)
            ? current.referenceImages
            : [...current.referenceImages, asset].slice(0, IMAGE_MAX_REFERENCE_COUNT),
        }));
        if (workspaceMode === "editing") setIsEditDirty(true);
        setNotice("参考图已上传，生成时将作为画面参考");
        toast.show("ok", "参考图已上传");
      } catch (uploadError) {
        const message = errorMessage(uploadError, "上传参考图失败");
        setError(message);
        toast.show("err", message);
      } finally {
        setIsUploadingReference(false);
      }
    })();
  };

  const handleRemoveReference = (assetId: string) => {
    updateImageDraft({ referenceImages: referenceImages.filter((image) => image.id !== assetId) });
    setError("");
    setNotice("");
  };

  const handleSelectTask = (task: ImageTask) => {
    const firstImage = images
      .filter((image) => image.requestId === task.id)
      .sort((a, b) => a.requestIndex - b.requestIndex)[0] ?? null;
    setSelectedRequestId(task.id);
    setSelectedImageId(firstImage?.id ?? null);
    const comparison = resolveImageVersionComparison(task, firstImage?.id);
    if (comparison) {
      setCompareImageIds(comparison);
      setWorkspaceMode("comparing");
    } else {
      setCompareImageIds(null);
      setWorkspaceMode("result");
    }
    setIsTaskDrawerOpen(false);
    setError("");
    setNotice("");
  };

  const handleOptimizePrompt = () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError("请输入提示词");
      return;
    }
    setError("");
    setNotice("");
    setIsOptimizingPrompt(true);
    void (async () => {
      try {
        const optimized = await optimizeWorkflowPrompt(token, trimmedPrompt);
        updateImageDraft({ prompt: optimized });
        setNotice("提示词已优化");
        toast.show("ok", "提示词已优化");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "优化提示词失败";
        setError(msg);
        toast.show("err", msg);
      } finally {
        setIsOptimizingPrompt(false);
      }
    })();
  };

  const handleCancelTask = (task: ImageTask) => {
    if (!isActiveTask(task) || cancellingTaskIds.includes(task.id)) return;
    setError("");
    setNotice("");
    setCancellingTaskIds((prev) => prev.includes(task.id) ? prev : [...prev, task.id]);
    setTasks((prev) => prev.map((item) =>
      item.id === task.id
        ? { ...item, status: "cancelled", error: "用户已取消" }
        : item
    ));

    void (async () => {
      try {
        const cancelled = await cancelWorkflowImageTask(token, task.id);
        setTasks((prev) => mergeTask(prev, toImageTask(cancelled)));
        setNotice("已取消生图任务");
        toast.show("ok", "任务已取消");
        onBalanceRefresh?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "取消生图任务失败";
        setError(msg);
        toast.show("err", msg);
        await refreshImageState(false);
      } finally {
        setCancellingTaskIds((prev) => prev.filter((id) => id !== task.id));
      }
    })();
  };

  const openSingleDownload = (image: WorkflowImageAsset) => {
    setDownloadDialog({ title: "原图下载链接", links: [image.originalUrl] });
  };

  const handleSelectHistoryImage = (image: WorkflowImageAsset) => {
    setSelectedRequestId(image.requestId);
    setSelectedImageId(image.id);
    setCompareImageIds(null);
    setWorkspaceMode("result");
    setError("");
    setNotice("");
  };

  const draftFromImage = (image: WorkflowImageAsset): ImageDraft => {
    const task = tasks.find((item) => item.id === image.requestId);
    const selection = resolveImageSizeSelection(task?.size ?? image.size)
      ?? { aspectRatio: DEFAULT_ASPECT_RATIO, resolution: DEFAULT_RESOLUTION };
    const inheritedReferences = (task?.referenceAssetIds ?? [])
      .map((id) => [...imageDraft.referenceImages, ...images].find((asset) => asset.id === id))
      .filter((asset): asset is WorkflowImageAsset => Boolean(asset));
    const nextReferences = [image, ...inheritedReferences]
      .filter((asset, index, all) => all.findIndex((candidate) => candidate.id === asset.id) === index)
      .slice(0, IMAGE_MAX_REFERENCE_COUNT);
    const taskModel = task?.model ?? image.model;
    return {
      prompt: task?.prompt ?? image.prompt,
      model: isImageModel(taskModel) ? taskModel : DEFAULT_IMAGE_MODEL,
      aspectRatio: selection.aspectRatio,
      resolution: selection.resolution,
      countInput: String(task?.count ?? 1),
      referenceImages: nextReferences,
    };
  };

  const beginEditingImage = (image: WorkflowImageAsset) => {
    setPreEditDraft(imageDraft);
    setImageDraft(draftFromImage(image));
    setSelectedRequestId(image.requestId);
    setSelectedImageId(image.id);
    setEditBaseImageId(image.id);
    setCompareImageIds(null);
    setImageGenerationIntent("edit");
    setWorkspaceMode("editing");
    setIsEditDirty(false);
    setError("");
    setNotice("");
  };

  const handleVariation = (image: WorkflowImageAsset) => {
    const nextDraft = draftFromImage(image);
    setPreEditDraft(imageDraft);
    setImageDraft(nextDraft);
    setEditBaseImageId(image.id);
    setSelectedImageId(image.id);
    setImageGenerationIntent("variation");
    setIsEditDirty(false);
    submitImageDraft(nextDraft, "variation", image.id);
  };

  const handleCancelEditing = () => {
    if (preEditDraft) setImageDraft(preEditDraft);
    const baseImage = images.find((image) => image.id === editBaseImageId) ?? null;
    setSelectedRequestId(baseImage?.requestId ?? selectedRequestId);
    setSelectedImageId(baseImage?.id ?? selectedImageId);
    setWorkspaceMode(baseImage || selectedRequestId ? "result" : "empty");
    setEditBaseImageId(null);
    setCompareImageIds(null);
    setPendingVersionRequestId(null);
    setImageGenerationIntent("new");
    setPreEditDraft(null);
    setIsEditDirty(false);
    setError("");
    setNotice("");
  };

  // 失败重试严格按原任务参数重建请求，不读取当前表单草稿，也不改动表单状态。
  // 同一个原任务的重试在飞行中直接忽略，避免连点重复预扣费。
  const handleRetryTask = (task: ImageTask) => {
    if (retryingRequestIds.current.has(task.id)) return;
    retryingRequestIds.current.add(task.id);
    const requestId = createRequestId();
    const intent = task.generationIntent ?? "new";
    const model = task.model && isImageModel(task.model) ? task.model : DEFAULT_IMAGE_MODEL;
    const retryTask: ImageTask = {
      ...task,
      id: requestId,
      status: "running",
      completedCount: 0,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setError("");
    setNotice("");
    setSelectedRequestId(requestId);
    setSelectedImageId(null);
    setTasks((prev) => mergeTask(prev, retryTask));
    if (intent === "new") {
      setWorkspaceMode("result");
      setCompareImageIds(null);
    } else {
      setPendingVersionRequestId(requestId);
    }

    void (async () => {
      try {
        const result = await generateWorkflowImages(token, {
          requestId,
          model,
          prompt: task.prompt,
          size: task.size,
          resolution: resolveImageSizeSelection(task.size)?.resolution,
          referenceAssetIds: [...(task.referenceAssetIds ?? [])],
          sourceImageAssetId: task.sourceImageAssetId ?? undefined,
          generationIntent: intent,
          count: task.count,
        });
        setImages(result.recent);
        setTasks((prev) => mergeTask(prev, toImageTask(result.task)));
        toast.show("ok", "已按原参数重新提交");
        onBalanceRefresh?.();
      } catch (err) {
        const message = err instanceof ApiError && err.status === 402 ? "积分不足，请充值" : errorMessage(err, "创建生图任务失败");
        setError(message);
        toast.show("err", message);
        setTasks((prev) => prev.map((item) => (item.id === requestId
          ? { ...item, status: "failed", error: message, updatedAt: new Date().toISOString() }
          : item)));
      } finally {
        retryingRequestIds.current.delete(task.id);
      }
    })();
  };

  const handleSetCurrentVersion = (image: WorkflowImageAsset) => {
    setSelectedRequestId(image.requestId);
    setSelectedImageId(image.id);
    setWorkspaceMode("result");
    setCompareImageIds(null);
    setEditBaseImageId(null);
    setPendingVersionRequestId(null);
    setImageGenerationIntent("new");
  };

  const openAllDownloads = () => {
    if (images.length === 0) return;
    setDownloadDialog({ title: "全部原图下载链接", links: images.map((image) => image.originalUrl) });
  };

  return (
    <div className={`${isFullscreen ? "h-full min-h-0 overflow-y-auto xl:overflow-hidden" : "min-h-full px-4 py-6 lg:px-6 lg:py-6"} bg-[#f5f5f7]`}>
      <div className={`${isFullscreen ? "flex min-h-0 flex-col lg:flex-row xl:h-full" : "mx-auto flex max-w-[1480px] flex-col gap-4 lg:flex-row lg:items-start"}`}>
        <main className={`min-w-0 ${isFullscreen ? "flex min-h-0 flex-1 flex-col" : "flex-1"}`}>
          {showModuleHeader && (
            <header className="flex-none px-4 pb-3 pt-4 lg:px-6">
              <p className="mb-1 text-xs font-bold text-brand-ink">工作流 / {activeModule.title}</p>
              <h1 className="page-title text-[24px] text-[#1d1d1f]">{activeModule.title}</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[#6e6e73]">{activeModule.description}</p>
            </header>
          )}
          {isImageHub && imageTabs.length > 1 && (
            <div className="flex-none px-4 pt-3 lg:px-6">
              <div className="inline-flex rounded-[10px] bg-[#ececf0] p-1">
                {imageTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setImageSubMode(tab.id)}
                    className={`h-9 rounded-[8px] px-4 text-sm font-semibold transition ${imageSubMode === tab.id ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] "}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className={studioWrapperClass}>

          {isImageHub ? (
            <>
              {imageTabs.length === 0 && (
                <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-8 text-center text-[#6e6e73]">
                  <Icon icon="mdi:image-off-outline" className="mx-auto mb-3 text-3xl text-[#8a8a8f]" aria-hidden />
                  <p className="text-sm font-semibold">生图模块暂未开放</p>
                </section>
              )}
              {hasImageTab("general") && (
              <div className={imageSubMode === "general" ? "min-h-0 xl:h-full" : "hidden"}>
          <ImageWorkflowStudio
            prompt={prompt}
            model={imageModel}
            size={size}
            aspectRatio={aspectRatio}
            resolution={resolution}
            countInput={countInput}
            selectedQuickCount={selectedQuickCount}
            error={error}
            notice={notice}
            tasks={tasks}
            images={images}
            previewImages={previewImages}
            selectedRequestId={selectedRequestId}
            selectedImageId={selectedImageId}
            workspaceMode={workspaceMode}
            editBaseImageId={editBaseImageId}
            compareImageIds={compareImageIds}
            isTaskDrawerOpen={isTaskDrawerOpen}
            isGenerating={isPreviewGenerating}
            generatingCount={previewGeneratingCount}
            cancellingTaskIds={cancellingTaskIds}
            isOptimizingPrompt={isOptimizingPrompt}
            estimatedPointCost={estimatedImagePointCost}
            referenceImages={referenceImages}
            isUploadingReference={isUploadingReference}
            onPromptChange={(value) => {
              updateImageDraft({ prompt: value });
              setError("");
            }}
            onModelChange={(value) => {
              updateImageDraft({ model: value });
              setError("");
              setNotice("");
            }}
            onAspectRatioChange={(value) => updateImageDraft({ aspectRatio: value })}
            onResolutionChange={(value) => updateImageDraft({ resolution: value })}
            onCountInputChange={handleCountInputChange}
            onQuickCountChange={handleQuickCountChange}
            onSubmit={handleSubmit}
            onCancelTask={handleCancelTask}
            onSelectTask={handleSelectTask}
            onSelectHistoryImage={handleSelectHistoryImage}
            onSelectImage={(image) => {
              setSelectedRequestId(image.requestId);
              setSelectedImageId(image.id);
            }}
            onModifyImage={beginEditingImage}
            onVariation={handleVariation}
            onEditImage={beginEditingImage}
            onCancelEditing={handleCancelEditing}
            onOpenTaskDrawer={() => setIsTaskDrawerOpen(true)}
            onCloseTaskDrawer={() => setIsTaskDrawerOpen(false)}
            onRetryTask={handleRetryTask}
            onSetCurrentVersion={handleSetCurrentVersion}
            onContinueModify={beginEditingImage}
            onOptimizePrompt={handleOptimizePrompt}
            onDownloadOne={openSingleDownload}
            onDownloadAll={openAllDownloads}
            onReferenceUpload={handleReferenceUpload}
            onRemoveReference={handleRemoveReference}
          />
              </div>
              )}
              {hasImageTab("ecom") && (
              <div className={imageSubMode === "ecom" ? "min-h-0 xl:h-full" : "hidden"}>
          <CommerceImageStudio
            token={token}
            onBalanceRefresh={onBalanceRefresh}
            tab={commerceTab}
            onTabChange={setCommerceTab}
            loadMainJob={commerceLoadMainJob}
            loadDetailWorkflow={commerceLoadDetailWorkflow}
            onActivity={() => setCommerceHistoryKey((k) => k + 1)}
            historyRefreshKey={commerceHistoryKey}
            onSelectMainHistory={(job) => {
              setCommerceTab("main");
              setCommerceLoadMainJob(job);
            }}
            onSelectDetailHistory={(w) => {
              setCommerceTab("detail");
              setCommerceLoadDetailWorkflow(w);
            }}
          />
              </div>
              )}
              {hasImageTab("portrait") && (
              <div className={imageSubMode === "portrait" ? "min-h-0 xl:h-full" : "hidden"}>
                <PortraitWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
              </div>
              )}
            </>
        ) : activeModuleId === "novel" ? (
          <NovelWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "codex-pet" ? (
          <CodexPetStudio
            token={token}
            initialProjectId={initialCodexPetProjectId}
            onBalanceRefresh={onBalanceRefresh}
            onOpenKnowledgeDocument={onOpenKnowledgeDocument}
          />
        ) : activeModuleId === "local-business-promo" ? (
          <LocalBusinessPromoWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "ai-comic" ? (
          <ComicWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "article-workflow" ? (
          <ArticleWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "scheduled-task" ? (
          <ScheduledTaskStudio token={token} />
        ) : (
          <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-8 text-center text-[#6e6e73]">
            <Icon icon="mdi:hammer-wrench" className="mx-auto mb-3 text-3xl text-[#8a8a8f]" aria-hidden />
              <p className="text-sm font-semibold">模块开发中</p>
            </section>
          )}
          </div>
        </main>
      </div>
      {downloadDialog && <DownloadLinkDialog dialog={downloadDialog} onClose={() => setDownloadDialog(null)} />}
    </div>
  );
}
