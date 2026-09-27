/**
 * 美甲试甲台工作台：生图模块下的一个页内 tab。与万物试穿共用 human-image 档位与异步任务模式，
 * 但把「上传主体图」换成「本地手部照片 + 指甲蒙版画笔」——只把指甲圈进蒙版，手部像素永不进入
 * AI 重绘，从构造上锁手。手照是隐私主体：仅本地处理，提交时才按档位合成上传，且每次生成都需授权。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@iconify/react";
import { DownloadOverlayButton } from "./DownloadOverlayButton";
import { downloadImageFile, imageDownloadFileName } from "./imageDownload";
import { readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import { WorkflowHistoryStrip } from "./ImageHistoryStrip";
import { SubmitBar } from "./SubmitBar";
import { HumanImageGenerationFields, HUMAN_RESOLUTION_OPTIONS } from "./HumanImageGenerationFields";
import { buildNailSubmission, humanTierDimensions, loadImageFromFile } from "../../nailMaskCanvas";
import {
  cancelNailTryOnTask,
  createNailTryOnTask,
  deleteNailTryOnReference,
  deleteNailTryOnTask,
  getNailTryOnOptions,
  getNailTryOnState,
  uploadNailTryOnReference,
  type NailAspectRatio,
  type NailModel,
  type NailOptions,
  type NailOutput,
  type NailReference,
  type NailResolution,
  type NailTask,
  type NailTaskStatus,
} from "../../nailTryOnApi";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const POLL_MS = 3000;
const URL_REFRESH_MS = 10 * 60 * 1000;
const EDIT_MAX_SIDE = 480;
const DEFAULT_CONSENT_VERSION = "nail-try-on-consent-v1";
// 默认 gpt-image-2：只有 openai 协议吃 mask，能从构造上锁手；豆包不支持 mask，仅兜底。
const DEFAULT_MODEL = "gpt-image-2";
const FALLBACK_MODELS: readonly NailModel[] = [
  { value: DEFAULT_MODEL, label: "GPT Image 2", supports1K: true, supports4K: false, supportsMask: true },
  { value: "doubao-seedream-5-0-260128", label: "豆包 Seedream 5.0", supports1K: false, supports4K: true, supportsMask: false },
];

const STATUS_LABEL: Record<NailTaskStatus, string> = {
  pending: "准备中",
  running: "生成中",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

// 编辑画布用「标称比例」的整数框，contain 时与档位框比例一致（9:16/16:9 有约 0.1% 偏差，
// 对手绘指甲蒙版可忽略）；手照与蒙版最终都在 buildNailSubmission 里按精确档位尺寸合成。
const ASPECT_RATIO: Record<NailAspectRatio, readonly [number, number]> = {
  "1:1": [1, 1],
  "3:4": [3, 4],
  "4:3": [4, 3],
  "9:16": [9, 16],
  "16:9": [16, 9],
};
interface NailTryOnWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `nail-try-on-${crypto.randomUUID()}`
    : `nail-try-on-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isActive(task: NailTask): boolean {
  return task.status === "pending" || task.status === "running";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formattedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
interface NailDesignSlotProps {
  readonly reference?: NailReference;
  readonly isUploading: boolean;
  readonly isDeleting: boolean;
  readonly disabled: boolean;
  readonly onFile: (file: File) => void;
  readonly onDelete: (reference: NailReference) => void;
}

/** 可选的美甲款式参考图（单槽）。与万物试穿的 ReferenceSlot 同构，但只有一个 kind。 */
function NailDesignSlot(props: NailDesignSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = props.isUploading || props.isDeleting;
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-ink-secondary">
        <span className="truncate">美甲款式</span>
        <span className="text-ink-tertiary">可选</span>
      </div>
      <div className="group relative aspect-square w-24 overflow-hidden rounded-lg border border-dashed border-hairline bg-surface-subtle">
        {props.reference ? (
          <>
            <img src={props.reference.previewUrl} alt="美甲款式" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => props.onDelete(props.reference!)}
              disabled={props.disabled || busy}
              aria-label="删除美甲款式"
              className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-scrim/65 text-white disabled:opacity-40"
            >
              <Icon icon={props.isDeleting ? "mdi:loading" : "mdi:close"} className={props.isDeleting ? "animate-spin" : ""} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={props.disabled || busy}
              className="absolute inset-x-1 bottom-1 h-7 rounded-[6px] bg-scrim/65 text-[11px] font-semibold text-white disabled:opacity-40"
            >
              更换
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={props.disabled || busy}
            aria-label="上传美甲款式"
            className="flex h-full w-full flex-col items-center justify-center text-ink-secondary disabled:opacity-40"
          >
            <Icon icon={props.isUploading ? "mdi:loading" : "mdi:plus"} className={`text-2xl ${props.isUploading ? "animate-spin" : ""}`} aria-hidden />
            <span className="mt-1 text-[11px]">{props.isUploading ? "上传中" : "上传"}</span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        data-testid="nail-file-nail_design"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif"
        className="hidden"
        disabled={props.disabled || busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) props.onFile(file);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
export function NailTryOnWorkflowStudio({ token, onBalanceRefresh }: NailTryOnWorkflowStudioProps) {
  const [options, setOptions] = useState<NailOptions | null>(null);
  const [references, setReferences] = useState<readonly NailReference[]>([]);
  const [tasks, setTasks] = useState<readonly NailTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(0);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [aspectRatio, setAspectRatio] = useState<NailAspectRatio>("3:4");
  const [resolution, setResolution] = useState<NailResolution>("2K");
  const [count, setCount] = useState(1);
  const [description, setDescription] = useState("");
  const [authorizationAccepted, setAuthorizationAccepted] = useState(false);
  const [handImage, setHandImage] = useState<HTMLImageElement | null>(null);
  const [isLoadingHand, setIsLoadingHand] = useState(false);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [brushSize, setBrushSize] = useState(14);
  const [hasMask, setHasMask] = useState(false);
  const [uploadingDesign, setUploadingDesign] = useState(false);
  const [deletingReferenceId, setDeletingReferenceId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [isTaskDrawerOpen, setIsTaskDrawerOpen] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const handInputRef = useRef<HTMLInputElement | null>(null);
  const handUrlRef = useRef<string | null>(null);
  const drawingRef = useRef(false);

  const editSize = useMemo(() => {
    const [rw, rh] = ASPECT_RATIO[aspectRatio];
    const scale = EDIT_MAX_SIDE / Math.max(rw, rh);
    return { width: Math.round(rw * scale), height: Math.round(rh * scale) };
  }, [aspectRatio]);
  const repaint = useCallback(() => {
    const disp = displayCanvasRef.current;
    const ctx = disp?.getContext("2d");
    if (!disp || !ctx) return; // jsdom 无 2d context：静默跳过，逻辑仍可测
    ctx.clearRect(0, 0, disp.width, disp.height);
    if (handImage) {
      const scale = Math.min(disp.width / handImage.naturalWidth, disp.height / handImage.naturalHeight);
      const dw = Math.round(handImage.naturalWidth * scale);
      const dh = Math.round(handImage.naturalHeight * scale);
      ctx.drawImage(handImage, Math.round((disp.width - dw) / 2), Math.round((disp.height - dh) / 2), dw, dh);
    }
    const sel = selectionCanvasRef.current;
    if (sel) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.drawImage(sel, 0, 0);
      ctx.restore();
    }
  }, [handImage]);

  const resetMask = useCallback(() => {
    const sel = selectionCanvasRef.current;
    sel?.getContext("2d")?.clearRect(0, 0, sel.width, sel.height);
    setHasMask(false);
  }, []);

  // 比例变更 → contain 变换变了，旧蒙版失效：重置画布尺寸并清空标注。
  useEffect(() => {
    const sel = selectionCanvasRef.current;
    const disp = displayCanvasRef.current;
    if (sel) {
      sel.width = editSize.width;
      sel.height = editSize.height;
    }
    if (disp) {
      disp.width = editSize.width;
      disp.height = editSize.height;
    }
    resetMask();
    repaint();
  }, [editSize, resetMask, repaint]);

  useEffect(() => {
    repaint();
  }, [repaint]);

  useEffect(() => () => {
    if (handUrlRef.current) URL.revokeObjectURL(handUrlRef.current);
  }, []);
  const refreshState = useCallback(async () => {
    const state = await getNailTryOnState(token);
    setReferences(state.references);
    setTasks(state.tasks);
    setSelectedTaskId((current) =>
      current && state.tasks.some((task) => task.id === current) ? current : (state.tasks[0]?.id ?? null),
    );
    return state;
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextOptions, state] = await Promise.all([getNailTryOnOptions(token), getNailTryOnState(token)]);
        if (cancelled) return;
        setOptions(nextOptions);
        setModel(nextOptions.model);
        setReferences(state.references);
        setTasks(state.tasks);
        setSelectedTaskId(state.tasks[0]?.id ?? null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError, "试甲台工作台加载失败"));
      } finally {
        if (!cancelled) setIsBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);

  const hasActiveTask = tasks.some(isActive);
  useEffect(() => {
    if (!hasActiveTask) return;
    const timer = window.setInterval(() => void refreshState().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveTask, refreshState]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshState().catch(() => undefined), URL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshState]);

  useEffect(() => setSelectedOutputIndex(0), [selectedTaskId]);
  const nailDesignReference = useMemo(() => references.find((item) => item.kind === "nail_design"), [references]);
  const models = options?.models.length ? options.models : FALLBACK_MODELS;
  const selectedModel = models.find((item) => item.value === model) ?? models[0];
  const maskUnsupported = selectedModel?.supportsMask === false;
  const resolutionOptions = HUMAN_RESOLUTION_OPTIONS.filter(
    (item) => item.value === "2K" || (item.value === "1K" ? selectedModel?.supports1K : selectedModel?.supports4K),
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null,
    [selectedTaskId, tasks],
  );
  const selectedOutput = selectedTask?.outputs[selectedOutputIndex] ?? selectedTask?.outputs[0] ?? null;
  const busyInputs = Boolean(isLoadingHand || uploadingDesign || deletingReferenceId || hasActiveTask);
  const canSubmit =
    Boolean(handImage) &&
    hasMask &&
    authorizationAccepted &&
    !isSubmitting &&
    !isLoadingHand &&
    !uploadingDesign &&
    !hasActiveTask;

  const paintFromEvent = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const sel = selectionCanvasRef.current;
      const ctx = sel?.getContext("2d");
      if (!sel || !ctx) return;
      const rect = sel.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = ((event.clientX - rect.left) / rect.width) * sel.width;
      const y = ((event.clientY - rect.top) / rect.height) * sel.height;
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.fillStyle = "rgba(244,63,94,1)"; // 不透明玫红：合成时只取 alpha，颜色无所谓
      ctx.beginPath();
      ctx.arc(x, y, brushSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      if (tool === "brush") setHasMask(true);
      repaint();
    },
    [tool, brushSize, repaint],
  );
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!handImage || hasActiveTask) return;
    event.preventDefault();
    drawingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    paintFromEvent(event);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current) paintFromEvent(event);
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleClearMask = () => {
    if (hasActiveTask) return;
    resetMask();
    repaint();
  };

  const handleHandFile = (file: File) => {
    if (isLoadingHand || hasActiveTask) return;
    if (file.size > MAX_REFERENCE_BYTES) {
      setError(`${file.name} 超过 10MB`);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError(`${file.name} 不是支持的图片`);
      return;
    }
    setIsLoadingHand(true);
    setError("");
    void (async () => {
      try {
        const { image, url } = await loadImageFromFile(file);
        if (handUrlRef.current) URL.revokeObjectURL(handUrlRef.current);
        handUrlRef.current = url;
        setHandImage(image);
        resetMask(); // 换手照 → 旧标注失效
        setAuthorizationAccepted(false); // 换手照 → 需重新授权
      } catch (loadError) {
        setError(errorMessage(loadError, "无法读取手部照片"));
      } finally {
        setIsLoadingHand(false);
      }
    })();
  };
  const handleModelChange = (value: string) => {
    setModel(value);
    const next = models.find((item) => item.value === value);
    if (resolution === "1K" && !next?.supports1K) setResolution("2K");
    if (resolution === "4K" && !next?.supports4K) setResolution("2K");
  };

  const handleDesignFile = (file: File) => {
    if (uploadingDesign || hasActiveTask) return;
    if (file.size > MAX_REFERENCE_BYTES) {
      setError(`${file.name} 超过 10MB`);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError(`${file.name} 不是支持的图片`);
      return;
    }
    const previous = nailDesignReference;
    setUploadingDesign(true);
    setError("");
    void (async () => {
      try {
        const inline = await readFileAsInlineImage(file);
        const response = await uploadNailTryOnReference(token, "nail_design", inline);
        if (previous) await deleteNailTryOnReference(token, previous.id).catch(() => undefined);
        setReferences((current) => [response.asset, ...current.filter((item) => item.kind !== "nail_design")]);
      } catch (uploadError) {
        setError(errorMessage(uploadError, "上传美甲款式失败"));
      } finally {
        setUploadingDesign(false);
      }
    })();
  };

  const handleDeleteDesign = (reference: NailReference) => {
    if (deletingReferenceId || hasActiveTask) return;
    setDeletingReferenceId(reference.id);
    setError("");
    void (async () => {
      try {
        await deleteNailTryOnReference(token, reference.id);
        setReferences((current) => current.filter((item) => item.id !== reference.id));
      } catch (deleteError) {
        setError(errorMessage(deleteError, "删除美甲款式失败"));
      } finally {
        setDeletingReferenceId(null);
      }
    })();
  };
  const handleSubmit = () => {
    if (!handImage) {
      setError("请先上传手部照片");
      return;
    }
    if (!hasMask) {
      setError("请用画笔标注需要重绘的指甲区域");
      return;
    }
    if (!authorizationAccepted) {
      setError("请确认手部照片使用授权");
      return;
    }
    const selection = selectionCanvasRef.current;
    if (!selection || !canSubmit) return;
    setIsSubmitting(true);
    setError("");
    void (async () => {
      try {
        const tier = humanTierDimensions(resolution, aspectRatio);
        const submission = buildNailSubmission({
          handImage,
          handWidth: handImage.naturalWidth,
          handHeight: handImage.naturalHeight,
          selection,
          tierWidth: tier.width,
          tierHeight: tier.height,
        });
        const handUpload = await uploadNailTryOnReference(token, "hand", { b64: submission.handB64, mime: "image/jpeg" });
        const response = await createNailTryOnTask(token, {
          requestId: requestId(),
          model,
          aspectRatio,
          resolution,
          count,
          handAssetId: handUpload.asset.id,
          ...(nailDesignReference ? { nailDesignAssetId: nailDesignReference.id } : {}),
          mask: { b64: submission.maskB64 },
          description,
          authorizationAccepted: true,
          consentVersion: options?.consentVersion ?? DEFAULT_CONSENT_VERSION,
        });
        setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
        setSelectedTaskId(response.task.id);
        onBalanceRefresh?.();
      } catch (submitError) {
        setError(errorMessage(submitError, "试甲生成失败"));
      } finally {
        setIsSubmitting(false);
      }
    })();
  };
  const handleCancel = (task: NailTask) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    void (async () => {
      try {
        await cancelNailTryOnTask(token, task.requestId);
        await refreshState();
        onBalanceRefresh?.();
      } catch (cancelError) {
        setError(errorMessage(cancelError, "取消试甲任务失败"));
      } finally {
        setBusyTaskId(null);
      }
    })();
  };

  const handleDeleteTask = (task: NailTask) => {
    if (busyTaskId || isActive(task)) return;
    setBusyTaskId(task.id);
    void (async () => {
      try {
        await deleteNailTryOnTask(token, task.requestId);
        await refreshState();
      } catch (deleteError) {
        setError(errorMessage(deleteError, "删除试甲任务失败"));
      } finally {
        setBusyTaskId(null);
      }
    })();
  };

  const handleDownload = (output: NailOutput) => {
    void downloadImageFile({
      url: output.originalUrl,
      fileName: imageDownloadFileName({ prefix: "nail-try-on", url: output.originalUrl, mime: output.mime, index: output.index }),
    }).catch((downloadError) => setError(errorMessage(downloadError, "下载原图失败")));
  };
  return (
    <section data-testid="nail-try-on-studio" className="relative flex min-h-0 flex-col overflow-hidden bg-surface xl:h-full">
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
        <aside className="flex h-[calc(100dvh-15.5rem)] min-h-[500px] max-h-[720px] flex-col border-b border-hairline-subtle bg-surface xl:h-full xl:min-h-0 xl:max-h-none xl:border-b-0 xl:border-r">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-ink-secondary">生成配置</p>
                <h2 className="mt-1 text-base font-semibold text-ink">试甲台设置</h2>
              </div>
              <Icon icon="mdi:hand-back-right-outline" className="text-xl text-ink-tertiary" aria-hidden />
            </div>

            <div className="mt-5">
              <p className="mb-2 text-sm font-semibold text-ink">手部照片与指甲标注</p>
              <div
                className="relative overflow-hidden rounded-lg border border-hairline bg-surface-inverse"
                style={{ aspectRatio: `${editSize.width} / ${editSize.height}` }}
              >
                <canvas
                  ref={displayCanvasRef}
                  data-testid="nail-mask-canvas"
                  className="h-full w-full touch-none"
                  style={{ cursor: handImage ? "crosshair" : "default" }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerUp}
                />
                <canvas ref={selectionCanvasRef} className="hidden" aria-hidden />
                {!handImage && (
                  <button
                    type="button"
                    onClick={() => handInputRef.current?.click()}
                    disabled={isLoadingHand || hasActiveTask}
                    aria-label="上传手部照片"
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80 disabled:opacity-50"
                  >
                    <Icon icon={isLoadingHand ? "mdi:loading" : "mdi:hand-back-right-outline"} className={`text-3xl ${isLoadingHand ? "animate-spin" : ""}`} aria-hidden />
                    <span className="text-xs">{isLoadingHand ? "读取中" : "上传手部照片"}</span>
                  </button>
                )}
              </div>
              <input
                ref={handInputRef}
                data-testid="nail-file-hand"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif"
                className="hidden"
                disabled={isLoadingHand || hasActiveTask}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) handleHandFile(file);
                  event.currentTarget.value = "";
                }}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="inline-flex overflow-hidden rounded-lg border border-hairline">
                  <button
                    type="button"
                    onClick={() => setTool("brush")}
                    aria-pressed={tool === "brush"}
                    disabled={!handImage || hasActiveTask}
                    className={`inline-flex h-8 items-center gap-1 px-3 text-xs font-semibold disabled:opacity-40 ${tool === "brush" ? "bg-brand-soft text-brand-ink" : "bg-surface text-ink-secondary"}`}
                  >
                    <Icon icon="mdi:brush" aria-hidden />画笔
                  </button>
                  <button
                    type="button"
                    onClick={() => setTool("eraser")}
                    aria-pressed={tool === "eraser"}
                    disabled={!handImage || hasActiveTask}
                    className={`inline-flex h-8 items-center gap-1 border-l border-hairline px-3 text-xs font-semibold disabled:opacity-40 ${tool === "eraser" ? "bg-brand-soft text-brand-ink" : "bg-surface text-ink-secondary"}`}
                  >
                    <Icon icon="mdi:eraser" aria-hidden />橡皮
                  </button>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                  粗细
                  <input type="range" min={4} max={40} value={brushSize} disabled={!handImage || hasActiveTask} aria-label="画笔粗细" onChange={(event) => setBrushSize(Number(event.target.value))} />
                </label>
                <button type="button" onClick={handleClearMask} disabled={!hasMask || hasActiveTask} className="ml-auto inline-flex h-8 items-center gap-1 rounded-lg border border-hairline px-2.5 text-xs font-semibold text-ink-secondary disabled:opacity-40">
                  清除标注
                </button>
                {handImage && (
                  <button type="button" onClick={() => handInputRef.current?.click()} disabled={isLoadingHand || hasActiveTask} className="inline-flex h-8 items-center gap-1 rounded-lg border border-hairline px-2.5 text-xs font-semibold text-ink-secondary disabled:opacity-40">
                    更换照片
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-ink-tertiary">
                只涂抹指甲：涂过的区域交给 AI 重绘，其余（手指、皮肤、背景）严格锁定不变。
              </p>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-tertiary">
                <Icon icon="mdi:shield-lock-outline" aria-hidden />
                手部照片仅本地处理，提交时才上传，任务结束 24 小时后自动清理
              </p>
            </div>
            <div className="mt-5">
              <NailDesignSlot
                reference={nailDesignReference}
                isUploading={uploadingDesign}
                isDeleting={deletingReferenceId === nailDesignReference?.id}
                disabled={busyInputs}
                onFile={handleDesignFile}
                onDelete={handleDeleteDesign}
              />
              <p className="mt-2 text-[11px] leading-4 text-ink-tertiary">上传想要的美甲款式作参考；不上传则由描述文字与 AI 自由发挥。</p>
            </div>

            <label className="mt-5 grid gap-2 text-sm font-semibold text-ink">
              补充描述 <span className="text-xs font-normal text-ink-tertiary">可选</span>
              <textarea
                aria-label="试甲补充描述"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setError("");
                }}
                disabled={hasActiveTask}
                maxLength={1200}
                placeholder="想要的颜色、款式、图案、光泽或风格"
                className="min-h-[92px] resize-y rounded-lg border border-hairline p-3 text-sm font-normal leading-5 disabled:bg-surface-muted"
              />
              <span className="text-right text-[10px] font-normal text-ink-tertiary">{description.length}/1200</span>
            </label>

            <HumanImageGenerationFields
              models={models}
              model={model}
              aspectRatio={aspectRatio}
              resolution={resolution}
              resolutionOptions={resolutionOptions}
              count={count}
              disabled={hasActiveTask}
              onModelChange={handleModelChange}
              onAspectRatioChange={(value) => setAspectRatio(value as NailAspectRatio)}
              onResolutionChange={(value) => setResolution(value as NailResolution)}
              onCountChange={setCount}
            />
            {maskUnsupported && (
              <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-[11px] leading-4 text-warning-ink">
                <Icon icon="mdi:alert-outline" className="mt-0.5 flex-none" aria-hidden />
                <span>所选模型不支持蒙版，无法保证「只改指甲、锁定手部」，建议改用 GPT Image 2。</span>
              </p>
            )}

            <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline-subtle bg-surface-subtle p-3 text-xs leading-5 text-ink-secondary">
              <input
                aria-label="试甲手部照片授权确认"
                type="checkbox"
                checked={authorizationAccepted}
                disabled={hasActiveTask}
                onChange={(event) => {
                  setAuthorizationAccepted(event.target.checked);
                  setError("");
                }}
                className="mt-0.5 h-4 w-4 accent-ink"
              />
              <span>我确认手部照片由本人拍摄或已获得本人明确授权，并同意用于本次 AI 试甲生成。</span>
            </label>

            {error && (
              <p ref={errorRef} role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger-ink">
                {error}
              </p>
            )}
            {isBootstrapping && !error && <p className="mt-3 text-xs text-ink-tertiary">正在加载试甲配置…</p>}
          </div>
          <SubmitBar
            submitLabel="生成试甲效果"
            submitIcon="mdi:hand-back-right-outline"
            submitDisabled={!canSubmit}
            busy={isSubmitting}
            busyLabel="提交中"
            onSubmit={handleSubmit}
          />
        </aside>
        <main className="flex min-h-[520px] min-w-0 flex-col overflow-hidden bg-surface-subtle xl:h-full">
          <header className="flex h-14 flex-none items-center justify-between border-b border-hairline-subtle bg-surface px-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-surface-inverse text-ink-inverse">
                <Icon icon="mdi:hand-back-right-outline" className="text-lg" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-ink">试甲台</h2>
                <p className="text-[11px] text-ink-tertiary">只重绘指甲 · 锁定手部</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {selectedTask && (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${selectedTask.status === "completed" ? "bg-success/10 text-success-ink" : selectedTask.status === "failed" ? "bg-danger/10 text-danger-ink" : "bg-surface-muted text-ink-secondary"}`}
                >
                  {STATUS_LABEL[selectedTask.status]}
                </span>
              )}
              <button
                type="button"
                onClick={() => setIsTaskDrawerOpen(true)}
                aria-expanded={isTaskDrawerOpen}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline bg-surface px-3 text-xs font-semibold text-ink"
              >
                <Icon icon="mdi:format-list-bulleted-square" className="text-base" aria-hidden />
                任务 {tasks.filter(isActive).length}
              </button>
            </div>
          </header>
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5 lg:p-8">
            {selectedOutput ? (
              <>
                <img
                  data-testid="nail-try-on-preview"
                  src={selectedOutput.originalUrl}
                  alt="AI 试甲预览"
                  className="max-h-full max-w-full rounded-[8px] object-contain shadow-[0_22px_70px_rgba(0,0,0,0.18)]"
                />
                <DownloadOverlayButton positionClassName="right-4 top-4" onClick={() => handleDownload(selectedOutput)} />
              </>
            ) : selectedTask && isActive(selectedTask) ? (
              <div className="grid max-w-sm place-items-center text-center">
                <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-surface shadow-sm">
                  <Icon icon="mdi:hand-back-right-outline" className="text-4xl text-brand-ink" aria-hidden />
                  <span className="absolute inset-0 animate-ping rounded-full border border-brand/30" />
                </span>
                <p className="mt-5 text-base font-semibold text-ink">正在生成试甲效果</p>
                <p className="mt-2 text-sm text-ink-secondary">已完成 {selectedTask.completedCount}/{selectedTask.count}</p>
                <button
                  type="button"
                  onClick={() => handleCancel(selectedTask)}
                  disabled={busyTaskId === selectedTask.id}
                  className="mt-5 h-9 rounded-[8px] border border-hairline bg-surface px-4 text-sm font-semibold text-ink-secondary"
                >
                  取消任务
                </button>
              </div>
            ) : (
              <div className="grid max-w-sm place-items-center text-center">
                <span className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed border-hairline bg-surface/70">
                  <Icon icon="mdi:hand-back-right-outline" className="text-4xl text-ink-tertiary" aria-hidden />
                </span>
                <p className="mt-5 text-base font-semibold text-ink-secondary">试甲效果预览</p>
                <p className="mt-2 text-sm text-ink-tertiary">上传手部照片、标注指甲并提交后，结果将在这里显示</p>
              </div>
            )}
            {selectedTask?.error && !isActive(selectedTask) && (
              <div className="absolute bottom-4 left-4 right-4 rounded-[8px] border border-danger/30 bg-surface/95 px-3 py-2 text-center text-xs text-danger-ink shadow-sm">
                {selectedTask.error}
              </div>
            )}
          </div>
          {selectedTask && selectedTask.outputs.length > 0 && (
            <footer className="flex flex-none items-center gap-3 border-t border-hairline-subtle bg-surface px-4 py-3">
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
                {selectedTask.outputs.map((output, index) => (
                  <button
                    key={output.id}
                    type="button"
                    onClick={() => setSelectedOutputIndex(index)}
                    className={`h-12 w-10 flex-none overflow-hidden rounded-[6px] border-2 ${selectedOutput?.id === output.id ? "border-brand" : "border-transparent"}`}
                  >
                    <img src={output.originalUrl} alt={`试甲结果 ${index + 1}`} className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            </footer>
          )}
          <WorkflowHistoryStrip
            ariaLabel="试甲生成历史"
            summary={`${tasks.length} 个任务`}
            emptyText="暂无生成记录"
            groups={tasks.map((task) => ({
              id: task.id,
              title: task.description || "试甲效果",
              meta: `${STATUS_LABEL[task.status]} · ${formattedDate(task.createdAt)}`,
              items: task.outputs.length
                ? task.outputs.map((output, index) => ({
                    id: output.id,
                    imageUrl: output.originalUrl,
                    alt: `试甲结果 ${index + 1}`,
                    selected: selectedTask?.id === task.id && selectedOutputIndex === index,
                    onSelect: () => {
                      setSelectedTaskId(task.id);
                      setSelectedOutputIndex(index);
                    },
                  }))
                : [
                    {
                      id: `${task.id}-placeholder`,
                      alt: `${STATUS_LABEL[task.status]}的试甲任务`,
                      selected: selectedTask?.id === task.id,
                      isLoading: isActive(task),
                      placeholderIcon: isActive(task) ? "mdi:loading" : "mdi:hand-back-right-outline",
                      onSelect: () => {
                        setSelectedTaskId(task.id);
                        setSelectedOutputIndex(0);
                      },
                    },
                  ],
            }))}
          />
        </main>
      </div>
      {isTaskDrawerOpen && (
        <div className="fixed inset-0 z-50 bg-scrim/20" onClick={() => setIsTaskDrawerOpen(false)}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="试甲任务队列"
            onClick={(event) => event.stopPropagation()}
            className="ml-auto flex h-full w-full flex-col bg-surface shadow-2xl sm:w-[320px]"
          >
            <div className="flex h-16 items-center justify-between border-b border-hairline-subtle px-4">
              <div>
                <p className="text-xs font-semibold text-ink-secondary">任务状态</p>
                <h2 className="text-base font-semibold text-ink">试甲任务</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsTaskDrawerOpen(false)}
                aria-label="关闭试甲任务队列"
                className="grid h-9 w-9 place-items-center rounded-lg hover:bg-surface-muted"
              >
                <Icon icon="mdi:close" className="text-xl" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {tasks.length === 0 ? (
                <p className="grid min-h-48 place-items-center text-sm text-ink-tertiary">暂无任务</p>
              ) : (
                tasks.map((task) => (
                  <article
                    key={task.id}
                    className={`mb-2 rounded-lg border ${selectedTask?.id === task.id ? "border-brand bg-brand-soft" : "border-hairline-subtle"}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTaskId(task.id);
                        setIsTaskDrawerOpen(false);
                      }}
                      className="block w-full p-3 text-left"
                    >
                      <span className="flex justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{task.description || "试甲效果"}</span>
                        <span className="flex-none text-xs text-ink-secondary">{STATUS_LABEL[task.status]}</span>
                      </span>
                      <span className="mt-1 block text-[11px] text-ink-tertiary">
                        {task.completedCount}/{task.count} 张 · {formattedDate(task.createdAt)}
                      </span>
                      {task.error && <span className="mt-2 block text-xs text-danger-ink">{task.error}</span>}
                    </button>
                    <div className="flex gap-2 px-3 pb-3">
                      {isActive(task) ? (
                        <button
                          type="button"
                          onClick={() => handleCancel(task)}
                          disabled={busyTaskId === task.id}
                          className="h-7 rounded-lg border border-danger/30 px-2 text-xs font-semibold text-danger-ink disabled:opacity-50"
                        >
                          取消任务
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleDeleteTask(task)}
                          disabled={busyTaskId === task.id}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline px-2 text-xs font-semibold text-ink-secondary disabled:opacity-50"
                        >
                          <Icon icon={busyTaskId === task.id ? "mdi:loading" : "mdi:delete-outline"} className={busyTaskId === task.id ? "animate-spin" : ""} aria-hidden />
                          删除
                        </button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

