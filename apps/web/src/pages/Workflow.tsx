import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useToast, RippleButton } from "../motion";
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
import { FanoutStudio } from "../components/workflow/FanoutStudio";
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
import {
  WORKFLOW_MODULES,
  advanceImageTaskStatus,
  buildImageSize,
  createImageTask,
  type ImageAspectRatio,
  type ImageModel,
  type ImageResolution,
  parseImageCount,
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

interface WorkflowProps {
  readonly token: string;
  readonly activeModuleId: WorkflowModuleId;
  readonly onBalanceRefresh?: () => void;
  readonly initialCodexPetProjectId?: string | null;
  readonly onOpenKnowledgeDocument?: (documentId: string) => void;
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
    size: task.size,
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

const FULLSCREEN_MODULES = new Set<WorkflowModuleId>(["novel", "image", "commerce-long-image", "codex-pet"]);

export default function Workflow({ token, activeModuleId, onBalanceRefresh, initialCodexPetProjectId, onOpenKnowledgeDocument }: WorkflowProps) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>(DEFAULT_ASPECT_RATIO);
  const [resolution, setResolution] = useState<ImageResolution>(DEFAULT_RESOLUTION);
  const [imageModel, setImageModel] = useState<ImageModel>(DEFAULT_IMAGE_MODEL);
  const [countInput, setCountInput] = useState("1");
  const [selectedQuickCount, setSelectedQuickCount] = useState(1);
  const [tasks, setTasks] = useState<readonly ImageTask[]>([]);
  const [images, setImages] = useState<readonly WorkflowImageAsset[]>([]);
  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false);
  const [referenceImages, setReferenceImages] = useState<readonly WorkflowImageAsset[]>([]);
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
  // 三套 studio 同时常驻 DOM，用 hidden 切换，表单内容零丢失。
  const isImageHub = activeModuleId === "image" || activeModuleId === "commerce-long-image";
  const [imageSubMode, setImageSubMode] = useState<"general" | "ecom" | "portrait">(
    activeModuleId === "commerce-long-image" ? "ecom" : "general",
  );
  useEffect(() => {
    setImageSubMode(activeModuleId === "commerce-long-image" ? "ecom" : "general");
  }, [activeModuleId]);
  const size = buildImageSize(aspectRatio, resolution);
  const estimatedImagePointCost = useMemo(() => {
    const rate = imagePricing?.[resolution]?.rate;
    if (rate == null) return null;
    const parsed = parseImageCount(countInput);
    const count = parsed.ok ? parsed.value : 1;
    return rate * count;
  }, [imagePricing, resolution, countInput]);
  const previewTasks = useMemo(
    () => previewRequestId ? tasks.filter((task) => task.id === previewRequestId) : tasks.filter(isActiveTask),
    [previewRequestId, tasks],
  );
  const previewImages = useMemo(
    () => previewRequestId ? images.filter((image) => image.requestId === previewRequestId) : [],
    [images, previewRequestId],
  );
  const isPreviewGenerating = previewTasks.some(isActiveTask);
  const previewGeneratingCount = useMemo(
    () => remainingImageCount(previewTasks),
    [previewTasks],
  );

  const refreshImageState = useCallback(async (showFailureNotice: boolean) => {
    try {
      const state = await getWorkflowImageState(token);
      const nextTasks = state.tasks.map(toImageTask);
      setImages(state.images);
      setTasks(nextTasks);
      setPreviewRequestId((current) => current ?? nextTasks.find(isActiveTask)?.id ?? null);
      if (showFailureNotice) setNotice("");
    } catch {
      if (showFailureNotice) setNotice("生图任务暂时无法加载");
    }
  }, [token]);

  const refreshImagePricing = useCallback(async () => {
    try {
      setImagePricing(await getImageWorkflowPricing(token));
    } catch {
      setImagePricing(null);
    }
  }, [token]);

  useEffect(() => {
    void refreshImageState(true);
  }, [refreshImageState]);

  useEffect(() => {
    void refreshImagePricing();
  }, [refreshImagePricing]);

  useEffect(() => {
    if (!tasks.some(isActiveTask)) return undefined;
    const timer = window.setInterval(() => {
      void refreshImageState(false);
    }, TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshImageState, tasks]);

  const handleQuickCountChange = (count: number) => {
    setSelectedQuickCount(count);
    setCountInput(String(count));
    setError("");
  };

  const handleCountInputChange = (value: string) => {
    setCountInput(value);
    const parsed = Number.parseInt(value, 10);
    setSelectedQuickCount([1, 2, 4, 8].includes(parsed) ? parsed : 0);
    setError("");
  };

  // 每次点击 = 一个独立任务，未完成也可继续并发提交（后端按 requestId 独立排队）
  const handleSubmit = () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError("请输入提示词");
      return;
    }

    const parsedCount = parseImageCount(countInput);
    if (!parsedCount.ok) {
      setError(parsedCount.error);
      return;
    }

    const requestId = createRequestId();
    const task = createImageTask({
      id: requestId,
      prompt: trimmedPrompt,
      size,
      count: parsedCount.value,
      createdAt: new Date().toISOString(),
    });

    setError("");
    setNotice("");
    setPreviewRequestId(requestId);
    setTasks((prev) => mergeTask(prev, advanceImageTaskStatus(task, "running")));

    void (async () => {
      try {
        const result = await generateWorkflowImages(token, {
          requestId,
          model: imageModel,
          prompt: trimmedPrompt,
          size,
          resolution,
          referenceAssetIds: referenceImages.map((image) => image.id),
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
        setTasks((prev) => prev.map((item) => (item.id === requestId ? advanceImageTaskStatus(item, "failed") : item)));
      }
    })();
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
        setReferenceImages((current) => current.some((item) => item.id === asset.id)
          ? current
          : [...current, asset].slice(0, IMAGE_MAX_REFERENCE_COUNT));
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
    setReferenceImages((current) => current.filter((image) => image.id !== assetId));
    setError("");
    setNotice("");
  };

  // 点击任务卡片：切到该任务的预览
  const handleSelectTask = (task: ImageTask) => {
    setPreviewRequestId(task.id);
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
        setPrompt(optimized);
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
    setPreviewRequestId(image.requestId);
    setError("");
    setNotice("");
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
              <h1 className="page-title text-[24px]">{activeModule.title}</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[#6e6e73]">{activeModule.description}</p>
            </header>
          )}
          {isImageHub && (
            <div className="flex-none px-4 pt-3 lg:px-6">
              <div className="inline-flex rounded-[10px] bg-[#ececf0] p-1">
                <button
                  type="button"
                  onClick={() => setImageSubMode("general")}
                  className={`h-9 rounded-[8px] px-4 text-sm font-semibold transition ${imageSubMode === "general" ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] "}`}
                >
                  通用生图
                </button>
                <button
                  type="button"
                  onClick={() => setImageSubMode("ecom")}
                  className={`h-9 rounded-[8px] px-4 text-sm font-semibold transition ${imageSubMode === "ecom" ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] "}`}
                >
                  电商生图
                </button>
                <button
                  type="button"
                  onClick={() => setImageSubMode("portrait")}
                  className={`h-9 rounded-[8px] px-4 text-sm font-semibold transition ${imageSubMode === "portrait" ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] "}`}
                >
                  形象照
                </button>
              </div>
            </div>
          )}
          <div className={studioWrapperClass}>

          {isImageHub ? (
            <>
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
            selectedRequestId={previewRequestId}
            isGenerating={isPreviewGenerating}
            generatingCount={previewGeneratingCount}
            cancellingTaskIds={cancellingTaskIds}
            isOptimizingPrompt={isOptimizingPrompt}
            estimatedPointCost={estimatedImagePointCost}
            referenceImages={referenceImages}
            isUploadingReference={isUploadingReference}
            onPromptChange={(value) => {
              setPrompt(value);
              setError("");
            }}
            onModelChange={(value) => {
              setImageModel(value);
              setError("");
              setNotice("");
            }}
            onAspectRatioChange={setAspectRatio}
            onResolutionChange={setResolution}
            onCountInputChange={handleCountInputChange}
            onQuickCountChange={handleQuickCountChange}
            onSubmit={handleSubmit}
            onCancelTask={handleCancelTask}
            onSelectTask={handleSelectTask}
            onSelectHistoryImage={handleSelectHistoryImage}
            onOptimizePrompt={handleOptimizePrompt}
            onDownloadOne={openSingleDownload}
            onDownloadAll={openAllDownloads}
            onReferenceUpload={handleReferenceUpload}
            onRemoveReference={handleRemoveReference}
          />
              </div>
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
              <div className={imageSubMode === "portrait" ? "min-h-0 xl:h-full" : "hidden"}>
                <PortraitWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
              </div>
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
        ) : activeModuleId === "fanout" ? (
          <FanoutStudio token={token} onBalanceRefresh={onBalanceRefresh} />
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
