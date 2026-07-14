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
import { EcomHistorySidebar } from "../components/workflow/EcomHistorySidebar";
import { ImageWorkflowStudio } from "../components/workflow/ImageWorkflowStudio";
import { LocalBusinessPromoWorkflowStudio } from "../components/workflow/LocalBusinessPromoWorkflowStudio";
import { NovelWorkflowStudio } from "../components/workflow/NovelWorkflowStudio";
import type { EcomMainJob } from "../workflowEcomMainApi";
import type { WorkflowEcomWorkflow } from "../workflowEcomApi";
import {
  WORKFLOW_MODULES,
  advanceImageTaskStatus,
  buildImageSize,
  createImageTask,
  type ImageAspectRatio,
  type ImageResolution,
  parseImageCount,
  type ImageTask,
  type WorkflowModuleId,
} from "../workflowState";

const DEFAULT_PROMPT = "陶瓷浅色餐盘，米白色桌布，绿色植物虚化背景，夏日野餐氛围，品牌感强，现代餐饮视觉设计。";
const DEFAULT_ASPECT_RATIO: ImageAspectRatio = "1:1";
const DEFAULT_RESOLUTION: ImageResolution = "1K";
const TASK_POLL_MS = 3000;

interface WorkflowProps {
  readonly token: string;
  readonly activeModuleId: WorkflowModuleId;
  readonly onBalanceRefresh?: () => void;
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

export default function Workflow({ token, activeModuleId, onBalanceRefresh }: WorkflowProps) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>(DEFAULT_ASPECT_RATIO);
  const [resolution, setResolution] = useState<ImageResolution>(DEFAULT_RESOLUTION);
  const [countInput, setCountInput] = useState("1");
  const [selectedQuickCount, setSelectedQuickCount] = useState(1);
  const [tasks, setTasks] = useState<readonly ImageTask[]>([]);
  const [images, setImages] = useState<readonly WorkflowImageAsset[]>([]);
  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false);
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
          prompt: trimmedPrompt,
          size,
          resolution,
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
    <div className={`min-h-full bg-[#f5f5f7] ${activeModuleId === "novel" ? "" : "px-4 py-6 lg:px-6 lg:py-6"}`}>
      <div className={`mx-auto flex flex-col gap-4 lg:flex-row lg:items-start ${activeModuleId === "novel" ? "max-w-none" : "max-w-[1480px]"}`}>
        {activeModuleId === "commerce-long-image" && (
          <aside className="rounded-[14px] border border-[#e8e8ed] bg-white p-3 lg:sticky lg:top-6 lg:w-[236px] lg:flex-none">
            <EcomHistorySidebar
              token={token}
              refreshKey={commerceHistoryKey}
              onSelectMain={(job) => {
                setCommerceTab("main");
                setCommerceLoadMainJob(job);
              }}
              onSelectDetail={(w) => {
                setCommerceTab("detail");
                setCommerceLoadDetailWorkflow(w);
              }}
            />
          </aside>
        )}

        <main className="min-w-0 flex-1">
          {activeModuleId !== "novel" && <header className="mb-4">
            <p className="mb-1 text-xs font-bold text-brand-ink">工作流 / {activeModule.title}</p>
            <h1 className="page-title text-[24px]">{activeModule.title}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-[#6e6e73]">{activeModule.description}</p>
          </header>}

          {activeModuleId === "image" ? (
          <ImageWorkflowStudio
            prompt={prompt}
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
            onPromptChange={(value) => {
              setPrompt(value);
              setError("");
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
          />
        ) : activeModuleId === "novel" ? (
          <NovelWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "commerce-long-image" ? (
          <CommerceImageStudio
            token={token}
            onBalanceRefresh={onBalanceRefresh}
            tab={commerceTab}
            onTabChange={setCommerceTab}
            loadMainJob={commerceLoadMainJob}
            loadDetailWorkflow={commerceLoadDetailWorkflow}
            onActivity={() => setCommerceHistoryKey((k) => k + 1)}
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
        </main>
      </div>
      {downloadDialog && <DownloadLinkDialog dialog={downloadDialog} onClose={() => setDownloadDialog(null)} />}
    </div>
  );
}
