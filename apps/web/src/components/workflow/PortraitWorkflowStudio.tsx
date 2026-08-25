import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { InAppSelect } from "../agent-teams/InAppSelect";
import { DownloadOverlayButton } from "./DownloadOverlayButton";
import { downloadImageFile, imageDownloadFileName } from "./imageDownload";
import { readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import { WorkflowHistoryStrip } from "./ImageHistoryStrip";
import { SubmitCostBar } from "./SubmitCostBar";
import { HumanImageGenerationFields, HUMAN_RESOLUTION_OPTIONS } from "./HumanImageGenerationFields";
import {
  cancelPortraitTask,
  createPortraitTask,
  deletePortraitReference,
  deletePortraitTask,
  getPortraitOptions,
  getPortraitState,
  uploadPortraitReference,
  type PortraitAspectRatio,
  type PortraitModel,
  type PortraitOptions,
  type PortraitPreset,
  type PortraitPresetId,
  type PortraitPromptOptions,
  type PortraitReference,
  type PortraitResolution,
  type PortraitTask,
  type PortraitTaskStatus,
} from "../../portraitApi";

const MAX_REFERENCE_COUNT = 3;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const POLL_MS = 3000;
const URL_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_CONSENT_VERSION = "portrait-consent-v1";
const DEFAULT_MODEL = "doubao-seedream-5-0-260128";
const FALLBACK_MODELS: readonly PortraitModel[] = [
  { value: "doubao-seedream-5-0-260128", label: "豆包 Seedream 5.0", supports4K: true, supports1K: false },
  { value: "gpt-image-2", label: "GPT Image 2", supports4K: false, supports1K: true },
];
const FALLBACK_PRESETS: readonly PortraitPreset[] = [
  { id: "business-elite", name: "商务精英", description: "西装+办公室" },
  { id: "linkedin", name: "LinkedIn 头像", description: "半身证件照风" },
  { id: "id-photo", name: "证件照", description: "简历/证件标准" },
  { id: "guofeng", name: "中国古风", description: "汉唐宋明" },
  { id: "sunny-casual", name: "阳光休闲", description: "咖啡馆/街拍" },
  { id: "poster", name: "海报形象", description: "中文大字+签名+品牌" },
  { id: "wedding", name: "婚纱写真", description: "中西式" },
  { id: "student-id", name: "学生证件", description: "校园/学位服" },
  { id: "founder-ip", name: "创业 IP", description: "杂志封面风" },
  { id: "hk-retro", name: "复古港风", description: "90 年代港风/王家卫" },
  { id: "oil-painting", name: "油画肖像", description: "文艺复兴/印象派" },
  { id: "ink-gongbi", name: "国风工笔", description: "水墨/工笔画" },
  { id: "magazine", name: "杂志大片", description: "Vogue/Bazaar 时尚" },
  { id: "cyberpunk", name: "赛博朋克", description: "霓虹未来感" },
  { id: "fairytale", name: "童话漫画", description: "二次元/Disney 风" },
  { id: "custom", name: "自定义", description: "按你的描述创作" },
];
// 旧版模板 id 仅用于历史任务标题展示；服务端 /options 未返回 legacyPresetNames 时的兜底
const LEGACY_PRESET_NAMES: Readonly<Record<string, string>> = {
  business: "商务头像",
  social: "社交头像",
  lifestyle: "生活写真",
  traditional: "传统服饰",
};
const SCENE_OPTIONS = ["明亮影棚", "现代办公室", "城市街景", "自然户外", "温馨室内", "纯色背景"];
const OUTFIT_OPTIONS = ["保持参考穿搭", "商务正装", "简约休闲", "时尚造型", "传统服饰"];
const COMPOSITION_OPTIONS = ["头肩特写", "半身肖像", "全身人像", "居中构图", "环境人像"];
const EXPRESSION_OPTIONS = ["自然微笑", "从容平静", "自信坚定", "轻松随性", "保持参考表情"];

interface PortraitWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

const STATUS_LABEL: Record<PortraitTaskStatus, string> = {
  pending: "准备中",
  running: "生成中",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `portrait-${crypto.randomUUID()}`
    : `portrait-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isActive(task: PortraitTask): boolean {
  return task.status === "pending" || task.status === "running";
}

function formattedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function ChoiceField({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly string[]; readonly onChange: (value: string) => void }) {
  return (
    <div className="grid gap-2 text-sm font-semibold text-ink">
      <p>{label}</p>
      <InAppSelect
        icon="mdi:tune-variant"
        label={label}
        value={value}
        options={options.map((option) => ({ value: option, label: option }))}
        onChange={onChange}
      />
    </div>
  );
}

export function PortraitWorkflowStudio({ token, onBalanceRefresh }: PortraitWorkflowStudioProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<PortraitOptions | null>(null);
  const [references, setReferences] = useState<readonly PortraitReference[]>([]);
  const [tasks, setTasks] = useState<readonly PortraitTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(0);
  const [presetId, setPresetId] = useState<PortraitPresetId>("business-elite");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [aspectRatio, setAspectRatio] = useState<PortraitAspectRatio>("3:4");
  const [resolution, setResolution] = useState<PortraitResolution>("2K");
  const [count, setCount] = useState(1);
  const [promptOptions, setPromptOptions] = useState<PortraitPromptOptions>({
    scene: "明亮影棚",
    outfit: "保持参考穿搭",
    composition: "头肩特写",
    expression: "自然微笑",
    hair: "",
    makeup: "",
    extraPrompt: "",
  });
  const [authorizationAccepted, setAuthorizationAccepted] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [deletingReferenceId, setDeletingReferenceId] = useState<string | null>(null);
  const [isTaskDrawerOpen, setIsTaskDrawerOpen] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  // 报错渲染在可滚动表单里，从吸底栏提交时可能在视口外，出现报错就滚到最近位置。
  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);

  const refreshState = useCallback(async () => {
    const state = await getPortraitState(token);
    setReferences(state.references);
    setTasks(state.tasks);
    setSelectedTaskId((current) => current && state.tasks.some((task) => task.id === current)
      ? current
      : state.tasks[0]?.id ?? null);
    return state;
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextOptions, state] = await Promise.all([getPortraitOptions(token), getPortraitState(token)]);
        if (cancelled) return;
        setOptions(nextOptions);
        setReferences(state.references);
        setTasks(state.tasks);
        setSelectedTaskId(state.tasks[0]?.id ?? null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError, "形象照工作台加载失败"));
      } finally {
        if (!cancelled) setIsBootstrapping(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const hasActiveTask = tasks.some(isActive);
  useEffect(() => {
    if (!hasActiveTask) return;
    const timer = window.setInterval(() => {
      void refreshState().catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveTask, refreshState]);

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshState().catch(() => undefined); }, URL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshState]);

  const presets = options?.presets.length ? options.presets : FALLBACK_PRESETS;
  const models = options?.models?.length ? options.models : FALLBACK_MODELS;
  const selectedModel = models.find((item) => item.value === model) ?? models[0];
  const modelSupports4K = selectedModel?.supports4K ?? true;
  // 老服务端不返回 supports1K：此时按「不支持」处理，避免前端提交出 400。
  const modelSupports1K = selectedModel?.supports1K ?? false;
  const resolutionOptions = HUMAN_RESOLUTION_OPTIONS.filter((option) => (
    option.value === "4K" ? modelSupports4K : option.value === "1K" ? modelSupports1K : true
  ));
  const legacyPresetNames = options?.legacyPresetNames;
  // 名称解析链：当前模板 → 服务端旧版模板名 → 本地兜底表 → 原始 id
  const presetName = useCallback((id: string) => {
    const current = presets.find((preset) => preset.id === id)?.name;
    if (current) return current;
    const fromServer = typeof legacyPresetNames?.[id] === "string" ? legacyPresetNames[id].trim() : "";
    if (fromServer) return fromServer;
    return LEGACY_PRESET_NAMES[id] ?? id;
  }, [presets, legacyPresetNames]);
  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null, [tasks, selectedTaskId]);
  const selectedOutput = selectedTask?.outputs[selectedOutputIndex] ?? selectedTask?.outputs[0] ?? null;
  const pointRate = options?.pricingByModel?.[model]?.[resolution] ?? options?.pricing[resolution]?.rate ?? null;
  const pointCost = pointRate == null ? null : pointRate * count;
  const canSubmit = references.length > 0 && authorizationAccepted && !isSubmitting && !isUploading && !hasActiveTask;

  const handleDownload = (output: NonNullable<typeof selectedOutput>) => {
    void downloadImageFile({
      url: output.originalUrl,
      fileName: imageDownloadFileName({ prefix: "portrait", url: output.originalUrl, mime: output.mime, index: output.index }),
    }).catch((downloadError) => setError(errorMessage(downloadError, "下载原图失败")));
  };

  const handleModelChange = (value: string) => {
    setModel(value);
    const next = models.find((item) => item.value === value);
    if (!next) return;
    if (!next.supports4K && resolution === "4K") setResolution("2K");
    if (!(next.supports1K ?? false) && resolution === "1K") setResolution("2K");
  };

  useEffect(() => { setSelectedOutputIndex(0); }, [selectedTaskId]);

  const updatePromptOption = (key: keyof PortraitPromptOptions, value: string) => {
    setPromptOptions((current) => ({ ...current, [key]: value }));
    setError("");
  };

  const handleFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []).slice(0, Math.max(0, MAX_REFERENCE_COUNT - references.length));
    if (files.length === 0 || isUploading) return;
    setIsUploading(true);
    setError("");
    void (async () => {
      try {
        for (const file of files) {
          if (file.size > MAX_REFERENCE_BYTES) throw new Error(`${file.name} 超过 10MB`);
          if (!file.type.startsWith("image/")) throw new Error(`${file.name} 不是支持的图片`);
          const inline = await readFileAsInlineImage(file);
          await uploadPortraitReference(token, inline);
        }
        await refreshState();
      } catch (uploadError) {
        setError(errorMessage(uploadError, "上传参考照失败"));
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    })();
  };

  const handleDeleteReference = (reference: PortraitReference) => {
    if (deletingReferenceId) return;
    setDeletingReferenceId(reference.id);
    setError("");
    void (async () => {
      try {
        await deletePortraitReference(token, reference.id);
        await refreshState();
      } catch (deleteError) {
        setError(errorMessage(deleteError, "删除参考照失败"));
      } finally {
        setDeletingReferenceId(null);
      }
    })();
  };

  const handleSubmit = () => {
    if (!canSubmit) {
      if (references.length === 0) setError("请先上传 1 至 3 张同一人物的参考照");
      else if (!authorizationAccepted) setError("请先确认已获得参考人物授权");
      return;
    }
    setIsSubmitting(true);
    setError("");
    void (async () => {
      try {
        const response = await createPortraitTask(token, {
          requestId: requestId(),
          presetId,
          model,
          aspectRatio,
          resolution,
          count,
          referenceAssetIds: references.map((reference) => reference.id),
          options: promptOptions,
          authorizationAccepted: true,
          consentVersion: options?.consentVersion ?? DEFAULT_CONSENT_VERSION,
        });
        setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
        setSelectedTaskId(response.task.id);
        onBalanceRefresh?.();
      } catch (submitError) {
        setError(errorMessage(submitError, "形象照生成失败"));
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  const handleCancel = (task: PortraitTask) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    void (async () => {
      try {
        await cancelPortraitTask(token, task.requestId);
        await refreshState();
        onBalanceRefresh?.();
      } catch (cancelError) {
        setError(errorMessage(cancelError, "取消任务失败"));
      } finally {
        setBusyTaskId(null);
      }
    })();
  };

  const handleDeleteTask = (task: PortraitTask) => {
    if (busyTaskId || isActive(task)) return;
    setBusyTaskId(task.id);
    void (async () => {
      try {
        await deletePortraitTask(token, task.requestId);
        await refreshState();
      } catch (deleteError) {
        setError(errorMessage(deleteError, "删除任务失败"));
      } finally {
        setBusyTaskId(null);
      }
    })();
  };

  return (
    <section data-testid="portrait-studio" className="relative flex min-h-0 flex-col overflow-hidden bg-surface xl:h-full">
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
      <aside className="flex h-[calc(100dvh-15.5rem)] min-h-[500px] max-h-[720px] flex-col border-b border-hairline-subtle bg-surface xl:h-full xl:min-h-0 xl:max-h-none xl:border-b-0 xl:border-r">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
        <div className="flex items-center justify-between"><div><p className="text-xs font-semibold text-ink-secondary">生成配置</p><h2 className="mt-1 text-base font-semibold text-ink">创作设置</h2></div><Icon icon="mdi:tune-variant" className="text-xl text-ink-tertiary" aria-hidden /></div>

        <div className="mt-5">
          <p className="mb-2 text-sm font-semibold text-ink">参考人物 ({references.length}/{MAX_REFERENCE_COUNT})</p>
          <div className="grid grid-cols-3 gap-2">
            {references.map((reference, index) => (
              <div key={reference.id} className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-hairline-subtle bg-surface-muted">
                <img src={reference.previewUrl} alt={`人物参考照 ${index + 1}`} className="h-full w-full object-cover" />
                <button type="button" title="删除参考照" aria-label={`删除参考照 ${index + 1}`} onClick={() => handleDeleteReference(reference)} disabled={deletingReferenceId === reference.id || hasActiveTask} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-scrim/60 text-white opacity-100 transition disabled:opacity-30 lg:opacity-0 lg:group-hover:opacity-100"><Icon icon={deletingReferenceId === reference.id ? "mdi:loading" : "mdi:close"} className={deletingReferenceId === reference.id ? "animate-spin" : ""} aria-hidden /></button>
              </div>
            ))}
            {references.length < MAX_REFERENCE_COUNT && <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="flex aspect-[3/4] flex-col items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-subtle text-ink-secondary disabled:opacity-50" aria-label="上传人物参考照"><Icon icon={isUploading ? "mdi:loading" : "mdi:plus"} className={`text-2xl ${isUploading ? "animate-spin" : ""}`} aria-hidden /><span className="mt-1 text-[11px]">{isUploading ? "上传中" : "添加"}</span></button>}
          </div>
          <input ref={fileInputRef} data-testid="portrait-file-input" type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif" className="hidden" onChange={(event) => handleFiles(event.target.files)} />
          <p className="mt-2 flex items-center gap-1 text-[11px] text-ink-tertiary"><Icon icon="mdi:shield-lock-outline" aria-hidden />私有存储，任务结束 24 小时后自动清理</p>
        </div>

        <div className="mt-5 border-t border-hairline-subtle pt-4">
          <p className="mb-2 text-sm font-semibold text-ink">形象模板</p>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((preset) => <button key={preset.id} type="button" onClick={() => setPresetId(preset.id)} className={`min-h-[58px] rounded-lg border px-3 py-2 text-left ${presetId === preset.id ? "border-brand bg-brand-soft text-brand-ink" : "border-hairline-subtle text-ink-secondary"}`}><span className="block text-sm font-semibold">{preset.name}</span><span className="mt-0.5 block text-[10px] leading-4 opacity-70">{preset.description}</span></button>)}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <ChoiceField label="场景" value={promptOptions.scene} options={SCENE_OPTIONS} onChange={(value) => updatePromptOption("scene", value)} />
          <ChoiceField label="服装" value={promptOptions.outfit} options={OUTFIT_OPTIONS} onChange={(value) => updatePromptOption("outfit", value)} />
          <ChoiceField label="构图" value={promptOptions.composition} options={COMPOSITION_OPTIONS} onChange={(value) => updatePromptOption("composition", value)} />
          <ChoiceField label="表情" value={promptOptions.expression} options={EXPRESSION_OPTIONS} onChange={(value) => updatePromptOption("expression", value)} />
          <label className="grid gap-2 text-sm font-semibold text-ink">发型<input value={promptOptions.hair} onChange={(event) => updatePromptOption("hair", event.target.value)} placeholder="保持参考或自定义" className="h-10 rounded-lg border border-hairline px-3 text-sm font-normal" /></label>
          <label className="grid gap-2 text-sm font-semibold text-ink">妆容<input value={promptOptions.makeup} onChange={(event) => updatePromptOption("makeup", event.target.value)} placeholder="自然或自定义" className="h-10 rounded-lg border border-hairline px-3 text-sm font-normal" /></label>
        </div>
        <label className="mt-3 grid gap-2 text-sm font-semibold text-ink">补充提示词<textarea aria-label="补充提示词" value={promptOptions.extraPrompt} onChange={(event) => updatePromptOption("extraPrompt", event.target.value)} maxLength={1200} placeholder="光线、氛围、背景细节等" className="min-h-[76px] resize-y rounded-lg border border-hairline p-3 text-sm font-normal leading-5" /></label>

        <HumanImageGenerationFields
          models={models}
          model={model}
          aspectRatio={aspectRatio}
          resolution={resolution}
          resolutionOptions={resolutionOptions}
          count={count}
          onModelChange={handleModelChange}
          onAspectRatioChange={(value) => setAspectRatio(value as PortraitAspectRatio)}
          onResolutionChange={(value) => setResolution(value as PortraitResolution)}
          onCountChange={setCount}
        />

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline-subtle bg-surface-subtle p-3 text-xs leading-5 text-ink-secondary"><input aria-label="人物授权确认" type="checkbox" checked={authorizationAccepted} onChange={(event) => setAuthorizationAccepted(event.target.checked)} className="mt-0.5 h-4 w-4 accent-ink" /><span>我确认参考人物为本人，或已获得本人明确授权，并同意用于本次 AI 形象照生成。</span></label>
        {error && <p ref={errorRef} role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger-ink">{error}</p>}
        <p className="mt-3 text-[10px] leading-4 text-ink-tertiary">AI 生成内容仅作预览，请勿用于证件、身份核验或未经授权的公开传播。</p>
        </div>
        <SubmitCostBar
          estimatedPointCost={pointCost}
          submitLabel="生成形象照"
          submitIcon="mdi:creation"
          submitDisabled={!canSubmit}
          busy={isSubmitting}
          busyLabel="生成中"
          onSubmit={handleSubmit}
        />
      </aside>

      <main className="flex min-h-[520px] min-w-0 flex-col overflow-hidden bg-surface-subtle xl:h-full">
        <header className="flex h-14 flex-none items-center justify-between border-b border-hairline-subtle bg-surface px-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-[7px] bg-surface-inverse text-ink-inverse"><Icon icon="mdi:account-box-outline" className="text-lg" aria-hidden /></span>
            <div><h2 className="text-sm font-semibold text-ink">AI 形象照</h2><p className="text-[11px] text-ink-tertiary">AI 生成预览</p></div>
          </div>
          <div className="flex items-center gap-2">
            {selectedTask && <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${selectedTask.status === "completed" ? "bg-success/10 text-success-ink" : selectedTask.status === "failed" ? "bg-danger/10 text-danger-ink" : "bg-surface-muted text-ink-secondary"}`}>{STATUS_LABEL[selectedTask.status]}</span>}
            <button type="button" onClick={() => setIsTaskDrawerOpen(true)} aria-expanded={isTaskDrawerOpen} className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline bg-surface px-3 text-xs font-semibold text-ink"><Icon icon="mdi:format-list-bulleted-square" className="text-base" aria-hidden />任务 {tasks.filter(isActive).length}</button>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5 lg:p-8">
          {selectedOutput ? (
            <>
              <img data-testid="portrait-preview" src={selectedOutput.originalUrl} alt="AI 生成形象照预览" className="max-h-full max-w-full rounded-[8px] object-contain shadow-[0_22px_70px_rgba(0,0,0,0.18)]" />
              <DownloadOverlayButton positionClassName="right-4 top-4" onClick={() => handleDownload(selectedOutput)} />
            </>
          ) : selectedTask && isActive(selectedTask) ? (
            <div className="grid max-w-sm place-items-center text-center">
              <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-surface shadow-sm"><Icon icon="mdi:creation-outline" className="text-4xl text-brand-ink" aria-hidden /><span className="absolute inset-0 animate-ping rounded-full border border-brand/30" /></span>
              <p className="mt-5 text-base font-semibold text-ink">正在生成形象照</p>
              <p className="mt-2 text-sm text-ink-secondary">已完成 {selectedTask.completedCount}/{selectedTask.count}</p>
              <button type="button" onClick={() => handleCancel(selectedTask)} disabled={busyTaskId === selectedTask.id} className="mt-5 h-9 rounded-[8px] border border-hairline bg-surface px-4 text-sm font-semibold text-ink-secondary">取消任务</button>
            </div>
          ) : (
            <div className="grid max-w-sm place-items-center text-center">
              <span className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed border-hairline bg-surface/70"><Icon icon="mdi:account-star-outline" className="text-4xl text-ink-tertiary" aria-hidden /></span>
              <p className="mt-5 text-base font-semibold text-ink-secondary">形象照预览</p>
              <p className="mt-2 text-sm text-ink-tertiary">选择模板并提交后，结果将在这里显示</p>
            </div>
          )}
          {selectedTask?.error && !isActive(selectedTask) && <div className="absolute bottom-4 left-4 right-4 rounded-[8px] border border-danger/30 bg-surface/95 px-3 py-2 text-center text-xs text-danger-ink shadow-sm">{selectedTask.error}</div>}
        </div>
        {selectedTask && selectedTask.outputs.length > 0 && (
          <footer className="flex flex-none items-center gap-3 border-t border-hairline-subtle bg-surface px-4 py-3">
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
              {selectedTask.outputs.map((output, index) => <button key={output.id} type="button" onClick={() => setSelectedOutputIndex(index)} className={`h-12 w-10 flex-none overflow-hidden rounded-[6px] border-2 ${selectedOutput?.id === output.id ? "border-brand" : "border-transparent"}`}><img src={output.originalUrl} alt={`结果 ${index + 1}`} className="h-full w-full object-cover" /></button>)}
            </div>
          </footer>
        )}
        <WorkflowHistoryStrip
          ariaLabel="形象照生成历史"
          summary={`${tasks.length} 个任务`}
          emptyText="暂无生成记录"
          groups={tasks.map((task) => ({
            id: task.id,
            title: presetName(task.presetId),
            meta: `${STATUS_LABEL[task.status]} · ${formattedDate(task.createdAt)}`,
            items: task.outputs.length > 0
              ? task.outputs.map((output, index) => ({
                  id: output.id,
                  imageUrl: output.originalUrl,
                  alt: `形象照结果 ${index + 1}`,
                  selected: selectedTask?.id === task.id && selectedOutputIndex === index,
                  onSelect: () => { setSelectedTaskId(task.id); setSelectedOutputIndex(index); },
                }))
              : [{
                  id: `${task.id}-placeholder`,
                  alt: `${STATUS_LABEL[task.status]}的形象照任务`,
                  selected: selectedTask?.id === task.id,
                  isLoading: isActive(task),
                  placeholderIcon: isActive(task) ? "mdi:loading" : "mdi:account-outline",
                  onSelect: () => { setSelectedTaskId(task.id); setSelectedOutputIndex(0); },
                }],
          }))}
        />
      </main>
      </div>

      {isTaskDrawerOpen && (
        <div className="fixed inset-0 z-50 bg-scrim/20" onClick={() => setIsTaskDrawerOpen(false)}>
          <aside role="dialog" aria-modal="true" aria-label="形象照任务队列" onClick={(event) => event.stopPropagation()} className="ml-auto flex h-full w-full flex-col bg-surface shadow-2xl sm:w-[320px]">
            <div className="flex h-16 items-center justify-between border-b border-hairline-subtle px-4"><div><p className="text-xs font-semibold text-ink-secondary">任务状态</p><h2 className="text-base font-semibold text-ink">形象照任务</h2></div><button type="button" onClick={() => setIsTaskDrawerOpen(false)} aria-label="关闭形象照任务队列" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-surface-muted"><Icon icon="mdi:close" className="text-xl" aria-hidden /></button></div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {tasks.length === 0 ? <p className="grid min-h-48 place-items-center text-sm text-ink-tertiary">暂无任务</p> : tasks.map((task) => (
                <article key={task.id} className={`mb-2 rounded-lg border ${selectedTask?.id === task.id ? "border-brand bg-brand-soft" : "border-hairline-subtle"}`}>
                  <button type="button" onClick={() => { setSelectedTaskId(task.id); setIsTaskDrawerOpen(false); }} className="block w-full p-3 text-left"><span className="flex justify-between gap-2"><span className="truncate text-sm font-semibold text-ink">{presetName(task.presetId)}</span><span className="flex-none text-xs text-ink-secondary">{STATUS_LABEL[task.status]}</span></span><span className="mt-1 block text-[11px] text-ink-tertiary">{task.completedCount}/{task.count} 张 · {formattedDate(task.createdAt)}</span>{task.error && <span className="mt-2 block text-xs text-danger-ink">{task.error}</span>}</button>
                  <div className="flex gap-2 px-3 pb-3">
                    {isActive(task) ? <button type="button" onClick={() => handleCancel(task)} disabled={busyTaskId === task.id} className="h-7 rounded-lg border border-danger/30 px-2 text-xs font-semibold text-danger-ink disabled:opacity-50">取消任务</button> : <button type="button" onClick={() => handleDeleteTask(task)} disabled={busyTaskId === task.id} className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline px-2 text-xs font-semibold text-ink-secondary disabled:opacity-50"><Icon icon={busyTaskId === task.id ? "mdi:loading" : "mdi:delete-outline"} className={busyTaskId === task.id ? "animate-spin" : ""} aria-hidden />删除</button>}
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
