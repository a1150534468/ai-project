/**
 * 生图工作区的全部编排:19 个状态、2 个 ref、3 个副作用,以及提交 / 重试 / 取消 / 编辑 / 下载每个动作。
 * P2.4 批次二从 `pages/Workflow.tsx` 原样搬出 —— 页面只留「布局 + Hub tab + 模块分发」。
 *
 * 四条不能动的规则:
 *  - **返回的 `studioProps` 必须逐字覆盖 `ImageWorkflowStudioProps`**:护栏
 *    `pages/Workflow.behavior.test.tsx` 用探针抓住 `<ImageWorkflowStudio>` 实际收到的那份 props,
 *    改名或改算法都会被照出来;这里显式标注返回类型,就是把这份契约钉在类型层面。
 *  - **首屏只自动选一次**:`hasInitializedImageState` 置位之后,后续每轮轮询都不许再动用户的选中项。
 *  - **重试严格按原任务参数重建**,既不读当前草稿也不改草稿;同一个原任务在飞行中直接忽略
 *    (`retryingRequestIds`),不然连点会重复下单。
 *  - **轮询只在有活跃任务时挂定时器**,并随 `tasks` 变化重建 —— 任务全部结束必须停下来。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelWorkflowImageTask,
  generateWorkflowImages,
  getWorkflowImageState,
  optimizeWorkflowPrompt,
  uploadWorkflowImageReference,
  type WorkflowImageAsset,
} from "../../api";
import { useToast } from "../../motion";
import {
  advanceImageTaskStatus,
  buildImageSize,
  createImageTask,
  isImageModel,
  parseImageCount,
  resolveImageSizeSelection,
  resolveImageSubmissionContext,
  resolveImageVersionComparison,
  type ImageGenerationIntent,
  type ImageTask,
  type ImageWorkspaceMode,
} from "../../workflowState";
import type { DownloadDialogState } from "../ui/DownloadLinkDialog";
import { readFileAsInlineImage } from "./inlineImage";
import { downloadImageFile, imageDownloadFileName } from "./imageDownload";
import type { ImageWorkflowStudioProps } from "./ImageWorkflowStudio";
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_DRAFT,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RESOLUTION,
  IMAGE_MAX_REFERENCE_COUNT,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  TASK_POLL_MS,
  createRequestId,
  errorMessage,
  isActiveTask,
  mergeTask,
  remainingImageCount,
  toImageTask,
  type ImageDraft,
} from "./imageWorkflowStudioModel";

export interface ImageWorkflowStudioController {
  readonly studioProps: ImageWorkflowStudioProps;
  readonly downloadDialog: DownloadDialogState | null;
  readonly closeDownloadDialog: () => void;
}

const includeEveryRequest = (_requestId: string): boolean => true;
const preservePrompt = (prompt: string): string => prompt;

export function useImageWorkflowStudio(args: {
  readonly token: string;
  readonly initialDraft?: ImageDraft;
  readonly requestIdPrefix?: string;
  readonly requestFilter?: (requestId: string) => boolean;
  readonly buildSubmissionPrompt?: (prompt: string) => string;
  readonly requiredReferenceCount?: number;
  readonly maxReferenceCount?: number;
  readonly emptyPromptMessage?: string;
  readonly referenceRequiredMessage?: string;
  readonly submittedMessage?: string;
  readonly downloadPrefix?: string;
}): ImageWorkflowStudioController {
  const { token } = args;
  const requestIdPrefix = args.requestIdPrefix ?? "img-";
  const requestFilter = args.requestFilter ?? includeEveryRequest;
  const buildSubmissionPrompt = args.buildSubmissionPrompt ?? preservePrompt;
  const requiredReferenceCount = args.requiredReferenceCount ?? 0;
  const maxReferenceCount = Math.min(Math.max(args.maxReferenceCount ?? IMAGE_MAX_REFERENCE_COUNT, 1), IMAGE_MAX_REFERENCE_COUNT);
  const emptyPromptMessage = args.emptyPromptMessage ?? "请输入提示词";
  const referenceRequiredMessage = args.referenceRequiredMessage ?? "请先上传参考图";
  const submittedMessage = args.submittedMessage ?? "生图任务已提交，后台生成中";
  const downloadPrefix = args.downloadPrefix ?? "generated-image";
  const toast = useToast();
  const [imageDraft, setImageDraft] = useState<ImageDraft>(() => args.initialDraft ?? DEFAULT_IMAGE_DRAFT);
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
  const retryingRequestIds = useRef<Set<string>>(new Set());
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false);
  const [isUploadingReference, setIsUploadingReference] = useState(false);
  const [cancellingTaskIds, setCancellingTaskIds] = useState<readonly string[]>([]);
  const [downloadDialog, setDownloadDialog] = useState<DownloadDialogState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { prompt, model: imageModel, aspectRatio, resolution, countInput, referenceImages } = imageDraft;
  const parsedQuickCount = Number.parseInt(countInput, 10);
  const selectedQuickCount = [1, 2, 4, 8].includes(parsedQuickCount) ? parsedQuickCount : 0;
  const size = buildImageSize(aspectRatio, resolution);
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
      const scopedImages = state.images.filter((image) => requestFilter(image.requestId));
      const nextTasks = state.tasks.filter((task) => requestFilter(task.requestId)).map(toImageTask);
      setImages(scopedImages);
      setTasks(nextTasks);

      if (!hasInitializedImageState.current) {
        hasInitializedImageState.current = true;
        const initialTask = nextTasks.find(isActiveTask) ?? nextTasks[0] ?? null;
        const initialImage = initialTask
          ? scopedImages.find((image) => image.requestId === initialTask.id) ?? null
          : scopedImages[0] ?? null;
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
  }, [requestFilter, token]);

  useEffect(() => {
    void refreshImageState(true);
  }, [refreshImageState]);

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
      setError(emptyPromptMessage);
      return;
    }
    if (draft.referenceImages.length < requiredReferenceCount) {
      setError(referenceRequiredMessage);
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

    const effectivePrompt = buildSubmissionPrompt(trimmedPrompt);
    const requestId = createRequestId(requestIdPrefix);
    const draftSize = buildImageSize(draft.aspectRatio, draft.resolution);
    const referenceAssetIds = Array.from(new Set([
      ...(sourceImageAssetId ? [sourceImageAssetId] : []),
      ...draft.referenceImages.map((image) => image.id),
    ])).slice(0, maxReferenceCount);
    const task: ImageTask = {
      ...createImageTask({
      id: requestId,
      prompt: effectivePrompt,
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
          prompt: effectivePrompt,
          size: draftSize,
          resolution: draft.resolution,
          referenceAssetIds,
          sourceImageAssetId: sourceImageAssetId ?? undefined,
          generationIntent: intent,
          count: parsedCount.value,
        });
        setImages(result.recent.filter((image) => requestFilter(image.requestId)));
        setTasks((prev) => mergeTask(prev, toImageTask(result.task)));
        toast.show("ok", submittedMessage);
      } catch (err) {
        const message = errorMessage(err, "创建生图任务失败");
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
    if (isUploadingReference || referenceImages.length >= maxReferenceCount) return;
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
            : [...current.referenceImages, asset].slice(0, maxReferenceCount),
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
    void downloadImageFile({
      url: image.originalUrl,
      fileName: imageDownloadFileName({ prefix: downloadPrefix, url: image.originalUrl, mime: image.mime, index: image.requestIndex }),
    }).then(() => toast.show("ok", "已开始下载原图")).catch((downloadError) => {
      const message = errorMessage(downloadError, "下载原图失败");
      setError(message);
      toast.show("err", message);
    });
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
  // 同一个原任务的重试在飞行中直接忽略，避免连点重复下单。
  const handleRetryTask = (task: ImageTask) => {
    if (retryingRequestIds.current.has(task.id)) return;
    retryingRequestIds.current.add(task.id);
    const requestId = createRequestId(requestIdPrefix);
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
        setImages(result.recent.filter((image) => requestFilter(image.requestId)));
        setTasks((prev) => mergeTask(prev, toImageTask(result.task)));
        toast.show("ok", "已按原参数重新提交");
      } catch (err) {
        const message = errorMessage(err, "创建生图任务失败");
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
  return {
    downloadDialog,
    closeDownloadDialog: () => setDownloadDialog(null),
    // 顺序与拆分前 `<ImageWorkflowStudio>` 上的 props 一一对应，方便和护栏断言对读。
    studioProps: {
      prompt,
      model: imageModel,
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
      selectedRequestId,
      selectedImageId,
      workspaceMode,
      editBaseImageId,
      compareImageIds,
      isTaskDrawerOpen,
      isGenerating: isPreviewGenerating,
      generatingCount: previewGeneratingCount,
      cancellingTaskIds,
      isOptimizingPrompt,
      referenceImages,
      isUploadingReference,
      onPromptChange: (value) => {
        updateImageDraft({ prompt: value });
        setError("");
      },
      onModelChange: (value) => {
        updateImageDraft({ model: value });
        setError("");
        setNotice("");
      },
      onAspectRatioChange: (value) => updateImageDraft({ aspectRatio: value }),
      onResolutionChange: (value) => updateImageDraft({ resolution: value }),
      onCountInputChange: handleCountInputChange,
      onQuickCountChange: handleQuickCountChange,
      onSubmit: handleSubmit,
      onCancelTask: handleCancelTask,
      onSelectTask: handleSelectTask,
      onSelectHistoryImage: handleSelectHistoryImage,
      onSelectImage: (image) => {
        setSelectedRequestId(image.requestId);
        setSelectedImageId(image.id);
      },
      onModifyImage: beginEditingImage,
      onVariation: handleVariation,
      onEditImage: beginEditingImage,
      onCancelEditing: handleCancelEditing,
      onOpenTaskDrawer: () => setIsTaskDrawerOpen(true),
      onCloseTaskDrawer: () => setIsTaskDrawerOpen(false),
      onRetryTask: handleRetryTask,
      onSetCurrentVersion: handleSetCurrentVersion,
      onContinueModify: beginEditingImage,
      onOptimizePrompt: handleOptimizePrompt,
      onDownloadOne: openSingleDownload,
      onDownloadAll: openAllDownloads,
      onReferenceUpload: handleReferenceUpload,
      onRemoveReference: handleRemoveReference,
    },
  };
}
