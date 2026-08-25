import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { DownloadOverlayButton } from "./DownloadOverlayButton";
import { downloadImageFile, imageDownloadFileName } from "./imageDownload";
import { readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import { WorkflowHistoryStrip } from "./ImageHistoryStrip";
import { SubmitCostBar } from "./SubmitCostBar";
import { HumanImageGenerationFields, HUMAN_RESOLUTION_OPTIONS } from "./HumanImageGenerationFields";
import {
  cancelTryOnTask,
  createTryOnTask,
  deleteTryOnReference,
  deleteTryOnTask,
  getTryOnOptions,
  getTryOnState,
  uploadTryOnReference,
  type TryOnAspectRatio,
  type TryOnModel,
  type TryOnOptions,
  type TryOnOutput,
  type TryOnReference,
  type TryOnReferenceKind,
  type TryOnResolution,
  type TryOnTask,
  type TryOnTaskStatus,
} from "../../tryOnApi";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const POLL_MS = 3000;
const URL_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_CONSENT_VERSION = "try-on-consent-v1";
const DEFAULT_MODEL = "doubao-seedream-5-0-260128";
const FALLBACK_MODELS: readonly TryOnModel[] = [
  { value: DEFAULT_MODEL, label: "豆包 Seedream 5.0", supports1K: false, supports4K: true },
  { value: "gpt-image-2", label: "GPT Image 2", supports1K: true, supports4K: false },
];

const STATUS_LABEL: Record<TryOnTaskStatus, string> = {
  pending: "准备中",
  running: "生成中",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

interface TryOnWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

interface ReferenceSlotProps {
  readonly kind: TryOnReferenceKind;
  readonly label: string;
  readonly required?: boolean;
  readonly reference?: TryOnReference;
  readonly isUploading: boolean;
  readonly isDeleting: boolean;
  readonly disabled: boolean;
  readonly onFile: (kind: TryOnReferenceKind, file: File) => void;
  readonly onDelete: (reference: TryOnReference) => void;
}

function ReferenceSlot(props: ReferenceSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = props.isUploading || props.isDeleting;
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-ink-secondary">
        <span className="truncate">{props.label}</span>
        <span className={props.required ? "text-red-500" : "text-ink-tertiary"}>{props.required ? "*" : "可选"}</span>
      </div>
      <div className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-dashed border-[#c7c7cc] bg-surface-subtle">
        {props.reference ? (
          <>
            <img src={props.reference.previewUrl} alt={props.label} className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => props.onDelete(props.reference!)}
              disabled={props.disabled || busy}
              aria-label={`删除${props.label}`}
              title={`删除${props.label}`}
              className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white disabled:opacity-40"
            >
              <Icon
                icon={props.isDeleting ? "mdi:loading" : "mdi:close"}
                className={props.isDeleting ? "animate-spin" : ""}
                aria-hidden
              />
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={props.disabled || busy}
              className="absolute inset-x-1 bottom-1 h-7 rounded-[6px] bg-black/65 text-[11px] font-semibold text-white disabled:opacity-40"
            >
              更换
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={props.disabled || busy}
            aria-label={`上传${props.label}`}
            className="flex h-full w-full flex-col items-center justify-center text-ink-secondary disabled:opacity-40"
          >
            <Icon
              icon={props.isUploading ? "mdi:loading" : "mdi:plus"}
              className={`text-2xl ${props.isUploading ? "animate-spin" : ""}`}
              aria-hidden
            />
            <span className="mt-1 text-[11px]">{props.isUploading ? "上传中" : "上传"}</span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        data-testid={`try-on-file-${props.kind}`}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif"
        className="hidden"
        disabled={props.disabled || busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) props.onFile(props.kind, file);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `try-on-${crypto.randomUUID()}`
    : `try-on-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isActive(task: TryOnTask): boolean {
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

export function TryOnWorkflowStudio({ token, onBalanceRefresh }: TryOnWorkflowStudioProps) {
  const [options, setOptions] = useState<TryOnOptions | null>(null);
  const [references, setReferences] = useState<readonly TryOnReference[]>([]);
  const [tasks, setTasks] = useState<readonly TryOnTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(0);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [aspectRatio, setAspectRatio] = useState<TryOnAspectRatio>("3:4");
  const [resolution, setResolution] = useState<TryOnResolution>("2K");
  const [count, setCount] = useState(1);
  const [description, setDescription] = useState("");
  const [authorizationAccepted, setAuthorizationAccepted] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<TryOnReferenceKind | null>(null);
  const [deletingReferenceId, setDeletingReferenceId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [isTaskDrawerOpen, setIsTaskDrawerOpen] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  const refreshState = useCallback(async () => {
    const state = await getTryOnState(token);
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
        const [nextOptions, state] = await Promise.all([getTryOnOptions(token), getTryOnState(token)]);
        if (cancelled) return;
        setOptions(nextOptions);
        setModel(nextOptions.model);
        setReferences(state.references);
        setTasks(state.tasks);
        setSelectedTaskId(state.tasks[0]?.id ?? null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError, "服装试穿工作台加载失败"));
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
    const timer = window.setInterval(() => {
      void refreshState().catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveTask, refreshState]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshState().catch(() => undefined);
    }, URL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshState]);

  useEffect(() => {
    setSelectedOutputIndex(0);
  }, [selectedTaskId]);

  const referenceByKind = useMemo(
    () => new Map(references.map((reference) => [reference.kind, reference])),
    [references],
  );
  const garmentFront = referenceByKind.get("garment_front");
  const garmentDetail = referenceByKind.get("garment_detail");
  const modelReference = referenceByKind.get("model");
  const models = options?.models.length ? options.models : FALLBACK_MODELS;
  const selectedModel = models.find((item) => item.value === model) ?? models[0];
  const resolutionOptions = HUMAN_RESOLUTION_OPTIONS.filter(
    (item) => item.value === "2K" || (item.value === "1K" ? selectedModel?.supports1K : selectedModel?.supports4K),
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null,
    [selectedTaskId, tasks],
  );
  const selectedOutput = selectedTask?.outputs[selectedOutputIndex] ?? selectedTask?.outputs[0] ?? null;
  const pointRate = options?.pricingByModel?.[model]?.[resolution] ?? options?.pricing[resolution]?.rate ?? null;
  const pointCost = pointRate == null ? null : pointRate * count;
  const busyInputs = Boolean(uploadingKind || deletingReferenceId || hasActiveTask);
  const canSubmit =
    Boolean(garmentFront) &&
    (!modelReference || authorizationAccepted) &&
    !isSubmitting &&
    !uploadingKind &&
    !hasActiveTask;

  const handleModelChange = (value: string) => {
    setModel(value);
    const next = models.find((item) => item.value === value);
    if (resolution === "1K" && !next?.supports1K) setResolution("2K");
    if (resolution === "4K" && !next?.supports4K) setResolution("2K");
  };

  const handleFile = (kind: TryOnReferenceKind, file: File) => {
    if (uploadingKind || hasActiveTask) return;
    if (file.size > MAX_REFERENCE_BYTES) {
      setError(`${file.name} 超过 10MB`);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError(`${file.name} 不是支持的图片`);
      return;
    }
    const previous = referenceByKind.get(kind);
    setUploadingKind(kind);
    setError("");
    void (async () => {
      try {
        const inline = await readFileAsInlineImage(file);
        const response = await uploadTryOnReference(token, kind, inline);
        if (previous) await deleteTryOnReference(token, previous.id).catch(() => undefined);
        setReferences((current) => [response.asset, ...current.filter((item) => item.kind !== kind)]);
        if (kind === "model") setAuthorizationAccepted(false);
      } catch (uploadError) {
        setError(errorMessage(uploadError, "上传试穿素材失败"));
      } finally {
        setUploadingKind(null);
      }
    })();
  };

  const handleDeleteReference = (reference: TryOnReference) => {
    if (deletingReferenceId || hasActiveTask) return;
    setDeletingReferenceId(reference.id);
    setError("");
    void (async () => {
      try {
        await deleteTryOnReference(token, reference.id);
        setReferences((current) => current.filter((item) => item.id !== reference.id));
        if (reference.kind === "model") setAuthorizationAccepted(false);
      } catch (deleteError) {
        setError(errorMessage(deleteError, "删除试穿素材失败"));
      } finally {
        setDeletingReferenceId(null);
      }
    })();
  };

  const handleSubmit = () => {
    if (!garmentFront) {
      setError("请先上传一张服装正面图");
      return;
    }
    if (modelReference && !authorizationAccepted) {
      setError("请确认已获得模特人物授权");
      return;
    }
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError("");
    void (async () => {
      try {
        const response = await createTryOnTask(token, {
          requestId: requestId(),
          model,
          aspectRatio,
          resolution,
          count,
          garmentFrontAssetId: garmentFront.id,
          ...(garmentDetail ? { garmentDetailAssetId: garmentDetail.id } : {}),
          ...(modelReference
            ? {
                modelAssetId: modelReference.id,
                authorizationAccepted: true as const,
                consentVersion: options?.consentVersion ?? DEFAULT_CONSENT_VERSION,
              }
            : {}),
          description,
        });
        setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
        setSelectedTaskId(response.task.id);
        onBalanceRefresh?.();
      } catch (submitError) {
        setError(errorMessage(submitError, "服装试穿生成失败"));
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  const handleCancel = (task: TryOnTask) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    void (async () => {
      try {
        await cancelTryOnTask(token, task.requestId);
        await refreshState();
        onBalanceRefresh?.();
      } catch (cancelError) {
        setError(errorMessage(cancelError, "取消试穿任务失败"));
      } finally {
        setBusyTaskId(null);
      }
    })();
  };

  const handleDeleteTask = (task: TryOnTask) => {
    if (busyTaskId || isActive(task)) return;
    setBusyTaskId(task.id);
    void (async () => {
      try {
        await deleteTryOnTask(token, task.requestId);
        await refreshState();
      } catch (deleteError) {
        setError(errorMessage(deleteError, "删除试穿任务失败"));
      } finally {
        setBusyTaskId(null);
      }
    })();
  };

  const handleDownload = (output: TryOnOutput) => {
    void downloadImageFile({
      url: output.originalUrl,
      fileName: imageDownloadFileName({
        prefix: "try-on",
        url: output.originalUrl,
        mime: output.mime,
        index: output.index,
      }),
    }).catch((downloadError) => setError(errorMessage(downloadError, "下载原图失败")));
  };

  return (
    <section data-testid="try-on-studio" className="relative flex min-h-0 flex-col overflow-hidden bg-white xl:h-full">
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
        <aside className="flex h-[calc(100dvh-15.5rem)] min-h-[500px] max-h-[720px] flex-col border-b border-[#e5e7eb] bg-white xl:h-full xl:min-h-0 xl:max-h-none xl:border-b-0 xl:border-r">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-ink-secondary">生成配置</p>
                <h2 className="mt-1 text-base font-semibold text-ink">服装试穿设置</h2>
              </div>
              <Icon icon="mdi:tshirt-crew-outline" className="text-xl text-ink-tertiary" aria-hidden />
            </div>

            <div className="mt-5">
              <p className="mb-2 text-sm font-semibold text-ink">试穿素材</p>
              <div className="grid grid-cols-3 gap-2">
                <ReferenceSlot
                  kind="garment_front"
                  label="服装正面"
                  required
                  reference={garmentFront}
                  isUploading={uploadingKind === "garment_front"}
                  isDeleting={deletingReferenceId === garmentFront?.id}
                  disabled={busyInputs}
                  onFile={handleFile}
                  onDelete={handleDeleteReference}
                />
                <ReferenceSlot
                  kind="garment_detail"
                  label="背面/细节"
                  reference={garmentDetail}
                  isUploading={uploadingKind === "garment_detail"}
                  isDeleting={deletingReferenceId === garmentDetail?.id}
                  disabled={busyInputs}
                  onFile={handleFile}
                  onDelete={handleDeleteReference}
                />
                <ReferenceSlot
                  kind="model"
                  label="模特图"
                  reference={modelReference}
                  isUploading={uploadingKind === "model"}
                  isDeleting={deletingReferenceId === modelReference?.id}
                  disabled={busyInputs}
                  onFile={handleFile}
                  onDelete={handleDeleteReference}
                />
              </div>
              <p className="mt-2 text-[11px] leading-4 text-ink-tertiary">
                服装正面清晰、无遮挡效果最佳；模特图不上传时由 AI 生成模特。
              </p>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-tertiary">
                <Icon icon="mdi:shield-lock-outline" aria-hidden />
                私有存储，任务结束 24 小时后自动清理输入素材
              </p>
            </div>

            <label className="mt-5 grid gap-2 text-sm font-semibold text-ink">
              补充描述 <span className="text-xs font-normal text-ink-tertiary">可选</span>
              <textarea
                aria-label="试穿补充描述"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setError("");
                }}
                disabled={hasActiveTask}
                maxLength={1200}
                placeholder="模特特征、场景、姿势或拍摄风格"
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
              onAspectRatioChange={(value) => setAspectRatio(value as TryOnAspectRatio)}
              onResolutionChange={(value) => setResolution(value as TryOnResolution)}
              onCountChange={setCount}
            />

            {modelReference && (
              <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-[#e5e7eb] bg-surface-subtle p-3 text-xs leading-5 text-ink-secondary">
                <input
                  aria-label="试穿模特授权确认"
                  type="checkbox"
                  checked={authorizationAccepted}
                  disabled={hasActiveTask}
                  onChange={(event) => {
                    setAuthorizationAccepted(event.target.checked);
                    setError("");
                  }}
                  className="mt-0.5 h-4 w-4 accent-[#1d1d1f]"
                />
                <span>我确认模特图为本人，或已获得本人明确授权，并同意用于本次 AI 服装试穿生成。</span>
              </label>
            )}
            {error && (
              <p ref={errorRef} role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            {isBootstrapping && !error && <p className="mt-3 text-xs text-ink-tertiary">正在加载试穿配置…</p>}
          </div>
          <SubmitCostBar
            estimatedPointCost={pointCost}
            submitLabel="生成试穿图"
            submitIcon="mdi:tshirt-crew-outline"
            submitDisabled={!canSubmit}
            busy={isSubmitting}
            busyLabel="提交中"
            onSubmit={handleSubmit}
          />
        </aside>

        <main className="flex min-h-[520px] min-w-0 flex-col overflow-hidden bg-surface-subtle xl:h-full">
          <header className="flex h-14 flex-none items-center justify-between border-b border-[#e5e7eb] bg-white px-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-[#1d1d1f] text-white">
                <Icon icon="mdi:tshirt-crew-outline" className="text-lg" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-ink">服装试穿</h2>
                <p className="text-[11px] text-ink-tertiary">AI 生成预览</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {selectedTask && (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${selectedTask.status === "completed" ? "bg-emerald-50 text-emerald-700" : selectedTask.status === "failed" ? "bg-red-50 text-red-700" : "bg-surface-muted text-ink-secondary"}`}
                >
                  {STATUS_LABEL[selectedTask.status]}
                </span>
              )}
              <button
                type="button"
                onClick={() => setIsTaskDrawerOpen(true)}
                aria-expanded={isTaskDrawerOpen}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline bg-white px-3 text-xs font-semibold text-ink"
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
                  data-testid="try-on-preview"
                  src={selectedOutput.originalUrl}
                  alt="AI 服装试穿预览"
                  className="max-h-full max-w-full rounded-[8px] object-contain shadow-[0_22px_70px_rgba(0,0,0,0.18)]"
                />
                <DownloadOverlayButton
                  positionClassName="right-4 top-4"
                  onClick={() => handleDownload(selectedOutput)}
                />
              </>
            ) : selectedTask && isActive(selectedTask) ? (
              <div className="grid max-w-sm place-items-center text-center">
                <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-sm">
                  <Icon icon="mdi:tshirt-crew-outline" className="text-4xl text-brand-ink" aria-hidden />
                  <span className="absolute inset-0 animate-ping rounded-full border border-brand/30" />
                </span>
                <p className="mt-5 text-base font-semibold text-ink">正在生成试穿图</p>
                <p className="mt-2 text-sm text-ink-secondary">
                  已完成 {selectedTask.completedCount}/{selectedTask.count}
                </p>
                <button
                  type="button"
                  onClick={() => handleCancel(selectedTask)}
                  disabled={busyTaskId === selectedTask.id}
                  className="mt-5 h-9 rounded-[8px] border border-hairline bg-white px-4 text-sm font-semibold text-ink-secondary"
                >
                  取消任务
                </button>
              </div>
            ) : (
              <div className="grid max-w-sm place-items-center text-center">
                <span className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed border-[#c7c7cc] bg-white/70">
                  <Icon icon="mdi:tshirt-crew-outline" className="text-4xl text-ink-tertiary" aria-hidden />
                </span>
                <p className="mt-5 text-base font-semibold text-ink-secondary">试穿效果预览</p>
                <p className="mt-2 text-sm text-ink-tertiary">上传服装正面图并提交后，结果将在这里显示</p>
              </div>
            )}
            {selectedTask?.error && !isActive(selectedTask) && (
              <div className="absolute bottom-4 left-4 right-4 rounded-[8px] border border-red-200 bg-white/95 px-3 py-2 text-center text-xs text-red-700 shadow-sm">
                {selectedTask.error}
              </div>
            )}
          </div>
          {selectedTask && selectedTask.outputs.length > 0 && (
            <footer className="flex flex-none items-center gap-3 border-t border-[#e5e7eb] bg-white px-4 py-3">
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
                {selectedTask.outputs.map((output, index) => (
                  <button
                    key={output.id}
                    type="button"
                    onClick={() => setSelectedOutputIndex(index)}
                    className={`h-12 w-10 flex-none overflow-hidden rounded-[6px] border-2 ${selectedOutput?.id === output.id ? "border-brand" : "border-transparent"}`}
                  >
                    <img
                      src={output.originalUrl}
                      alt={`试穿结果 ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            </footer>
          )}
          <WorkflowHistoryStrip
            ariaLabel="服装试穿生成历史"
            summary={`${tasks.length} 个任务`}
            emptyText="暂无生成记录"
            groups={tasks.map((task) => ({
              id: task.id,
              title: task.description || (task.modelAssetId ? "指定模特试穿" : "AI 模特试穿"),
              meta: `${STATUS_LABEL[task.status]} · ${formattedDate(task.createdAt)}`,
              items: task.outputs.length
                ? task.outputs.map((output, index) => ({
                    id: output.id,
                    imageUrl: output.originalUrl,
                    alt: `试穿结果 ${index + 1}`,
                    selected: selectedTask?.id === task.id && selectedOutputIndex === index,
                    onSelect: () => {
                      setSelectedTaskId(task.id);
                      setSelectedOutputIndex(index);
                    },
                  }))
                : [
                    {
                      id: `${task.id}-placeholder`,
                      alt: `${STATUS_LABEL[task.status]}的试穿任务`,
                      selected: selectedTask?.id === task.id,
                      isLoading: isActive(task),
                      placeholderIcon: isActive(task) ? "mdi:loading" : "mdi:tshirt-crew-outline",
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
        <div className="fixed inset-0 z-50 bg-black/20" onClick={() => setIsTaskDrawerOpen(false)}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="服装试穿任务队列"
            onClick={(event) => event.stopPropagation()}
            className="ml-auto flex h-full w-full flex-col bg-white shadow-2xl sm:w-[320px]"
          >
            <div className="flex h-16 items-center justify-between border-b border-[#e5e7eb] px-4">
              <div>
                <p className="text-xs font-semibold text-ink-secondary">任务状态</p>
                <h2 className="text-base font-semibold text-ink">服装试穿任务</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsTaskDrawerOpen(false)}
                aria-label="关闭服装试穿任务队列"
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
                    className={`mb-2 rounded-lg border ${selectedTask?.id === task.id ? "border-brand bg-brand-soft" : "border-[#e5e7eb]"}`}
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
                        <span className="truncate text-sm font-semibold text-ink">
                          {task.modelAssetId ? "指定模特试穿" : "AI 模特试穿"}
                        </span>
                        <span className="flex-none text-xs text-ink-secondary">{STATUS_LABEL[task.status]}</span>
                      </span>
                      <span className="mt-1 block text-[11px] text-ink-tertiary">
                        {task.completedCount}/{task.count} 张 · {formattedDate(task.createdAt)}
                      </span>
                      {task.error && <span className="mt-2 block text-xs text-red-600">{task.error}</span>}
                    </button>
                    <div className="flex gap-2 px-3 pb-3">
                      {isActive(task) ? (
                        <button
                          type="button"
                          onClick={() => handleCancel(task)}
                          disabled={busyTaskId === task.id}
                          className="h-7 rounded-lg border border-red-200 px-2 text-xs font-semibold text-red-600 disabled:opacity-50"
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
                          <Icon
                            icon={busyTaskId === task.id ? "mdi:loading" : "mdi:delete-outline"}
                            className={busyTaskId === task.id ? "animate-spin" : ""}
                            aria-hidden
                          />
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
