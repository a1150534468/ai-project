import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { InAppSelect } from "../agent-teams/InAppSelect";
import { readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import {
  cancelPortraitTask,
  createPortraitTask,
  deletePortraitReference,
  deletePortraitTask,
  getPortraitOptions,
  getPortraitState,
  uploadPortraitReference,
  type PortraitAspectRatio,
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
const POLL_MS = 2500;
const URL_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_CONSENT_VERSION = "portrait-consent-v1";
const FALLBACK_PRESETS: readonly PortraitPreset[] = [
  { id: "business", name: "商务头像", description: "专业、克制的职业形象" },
  { id: "social", name: "社交头像", description: "自然亲和的个人头像" },
  { id: "lifestyle", name: "生活写真", description: "松弛自然的生活场景" },
  { id: "traditional", name: "传统服饰", description: "传统审美与服饰表达" },
  { id: "poster", name: "个人海报", description: "具有主题感的视觉海报" },
  { id: "custom", name: "自定义", description: "按你的描述创作" },
];
const ASPECT_OPTIONS = [
  { value: "1:1", label: "1:1 · 方形" },
  { value: "3:4", label: "3:4 · 竖版" },
  { value: "4:3", label: "4:3 · 横版" },
  { value: "9:16", label: "9:16 · 全屏竖版" },
  { value: "16:9", label: "16:9 · 宽屏" },
] as const;
const RESOLUTION_OPTIONS = [
  { value: "2K", label: "2K · 标准" },
  { value: "4K", label: "4K · 高清" },
] as const;
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
    <label className="grid gap-1.5 text-xs font-semibold text-[#424245]">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-sm font-normal text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-brand/20">
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

export function PortraitWorkflowStudio({ token, onBalanceRefresh }: PortraitWorkflowStudioProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<PortraitOptions | null>(null);
  const [references, setReferences] = useState<readonly PortraitReference[]>([]);
  const [tasks, setTasks] = useState<readonly PortraitTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(0);
  const [presetId, setPresetId] = useState<PortraitPresetId>("business");
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
  const [error, setError] = useState("");

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
  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null, [tasks, selectedTaskId]);
  const selectedOutput = selectedTask?.outputs[selectedOutputIndex] ?? selectedTask?.outputs[0] ?? null;
  const pointCost = options?.pricing[resolution]?.rate == null ? null : options.pricing[resolution].rate * count;
  const canSubmit = references.length > 0 && authorizationAccepted && !isSubmitting && !isUploading && !hasActiveTask;

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
    <section data-testid="portrait-studio" className="grid min-h-0 gap-5 xl:h-full xl:grid-cols-[260px_minmax(0,1fr)_340px]">
      <aside className="min-h-[280px] overflow-hidden rounded-[12px] border border-[#e8e8ed] bg-white shadow-[0_16px_44px_rgba(15,23,42,0.055)] xl:h-full">
        <div className="flex items-center justify-between border-b border-[#eeeeF2] px-4 py-3.5">
          <div>
            <h2 className="text-[16px] font-semibold text-[#1d1d1f]">生成历史</h2>
            <p className="mt-0.5 text-xs text-[#86868b]">最近 {tasks.length} 个任务</p>
          </div>
          <Icon icon="mdi:history" className="text-xl text-[#86868b]" aria-hidden />
        </div>
        <div className="h-[calc(100%-65px)] overflow-y-auto p-2.5">
          {tasks.map((task) => {
            const active = selectedTask?.id === task.id;
            const cover = task.outputs[0];
            return (
              <div key={task.id} className={`group mb-2 flex min-h-[72px] items-center gap-3 rounded-[8px] border p-2.5 transition ${active ? "border-brand/40 bg-brand-soft/60" : "border-transparent bg-[#f7f7f9] "}`}>
                <button type="button" onClick={() => setSelectedTaskId(task.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <span className="flex h-12 w-10 flex-none items-center justify-center overflow-hidden rounded-[6px] bg-[#e9eaed]">
                    {cover ? <img src={cover.originalUrl} alt="形象照历史缩略图" className="h-full w-full object-cover" /> : <Icon icon={isActive(task) ? "mdi:loading" : "mdi:account-outline"} className={`text-xl text-[#86868b] ${isActive(task) ? "animate-spin" : ""}`} aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[#1d1d1f]">{presets.find((preset) => preset.id === task.presetId)?.name ?? "形象照"}</span>
                    <span className="mt-1 flex items-center gap-2 text-[11px] text-[#86868b]"><span>{STATUS_LABEL[task.status]}</span><span>{formattedDate(task.createdAt)}</span></span>
                  </span>
                </button>
                {!isActive(task) && <button type="button" title="删除任务" aria-label="删除形象照任务" disabled={busyTaskId === task.id} onClick={() => handleDeleteTask(task)} className="flex h-8 w-8 flex-none items-center justify-center rounded-[6px] text-[#86868b] transition disabled:opacity-40"><Icon icon={busyTaskId === task.id ? "mdi:loading" : "mdi:delete-outline"} className={busyTaskId === task.id ? "animate-spin" : ""} aria-hidden /></button>}
              </div>
            );
          })}
          {!isBootstrapping && tasks.length === 0 && <div className="grid place-items-center px-4 py-16 text-center"><Icon icon="mdi:image-multiple-outline" className="text-3xl text-[#c7c7cc]" aria-hidden /><p className="mt-3 text-sm text-[#86868b]">暂无生成记录</p></div>}
        </div>
      </aside>

      <main className="flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-[12px] border border-[#e8e8ed] bg-[#efeff2] shadow-[0_16px_44px_rgba(15,23,42,0.055)] xl:h-full">
        <header className="flex h-14 flex-none items-center justify-between border-b border-[#dedee3] bg-white px-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-[7px] bg-[#1d1d1f] text-white"><Icon icon="mdi:account-box-outline" className="text-lg" aria-hidden /></span>
            <div><h2 className="text-sm font-semibold text-[#1d1d1f]">AI 形象照</h2><p className="text-[11px] text-[#86868b]">AI 生成预览</p></div>
          </div>
          {selectedTask && <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${selectedTask.status === "completed" ? "bg-emerald-50 text-emerald-700" : selectedTask.status === "failed" ? "bg-red-50 text-red-700" : "bg-[#f2f2f5] text-[#6e6e73]"}`}>{STATUS_LABEL[selectedTask.status]}</span>}
        </header>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5 lg:p-8">
          {selectedOutput ? (
            <img data-testid="portrait-preview" src={selectedOutput.originalUrl} alt="AI 生成形象照预览" className="max-h-full max-w-full rounded-[8px] object-contain shadow-[0_22px_70px_rgba(0,0,0,0.18)]" />
          ) : selectedTask && isActive(selectedTask) ? (
            <div className="grid max-w-sm place-items-center text-center">
              <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-sm"><Icon icon="mdi:creation-outline" className="text-4xl text-brand-ink" aria-hidden /><span className="absolute inset-0 animate-ping rounded-full border border-brand/30" /></span>
              <p className="mt-5 text-base font-semibold text-[#1d1d1f]">正在生成形象照</p>
              <p className="mt-2 text-sm text-[#6e6e73]">已完成 {selectedTask.completedCount}/{selectedTask.count}</p>
              <button type="button" onClick={() => handleCancel(selectedTask)} disabled={busyTaskId === selectedTask.id} className="mt-5 h-9 rounded-[8px] border border-[#d2d2d7] bg-white px-4 text-sm font-semibold text-[#424245]">取消任务</button>
            </div>
          ) : (
            <div className="grid max-w-sm place-items-center text-center">
              <span className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed border-[#c7c7cc] bg-white/70"><Icon icon="mdi:account-star-outline" className="text-4xl text-[#86868b]" aria-hidden /></span>
              <p className="mt-5 text-base font-semibold text-[#424245]">形象照预览</p>
              <p className="mt-2 text-sm text-[#86868b]">选择模板并提交后，结果将在这里显示</p>
            </div>
          )}
          {selectedTask?.error && !isActive(selectedTask) && <div className="absolute bottom-4 left-4 right-4 rounded-[8px] border border-red-200 bg-white/95 px-3 py-2 text-center text-xs text-red-700 shadow-sm">{selectedTask.error}</div>}
        </div>
        {selectedTask && selectedTask.outputs.length > 0 && (
          <footer className="flex flex-none items-center gap-3 border-t border-[#dedee3] bg-white px-4 py-3">
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
              {selectedTask.outputs.map((output, index) => <button key={output.id} type="button" onClick={() => setSelectedOutputIndex(index)} className={`h-12 w-10 flex-none overflow-hidden rounded-[6px] border-2 ${selectedOutput?.id === output.id ? "border-brand" : "border-transparent"}`}><img src={output.originalUrl} alt={`结果 ${index + 1}`} className="h-full w-full object-cover" /></button>)}
            </div>
            {selectedOutput && <a href={selectedOutput.originalUrl} download={`portrait-${selectedOutput.index + 1}.png`} className="flex h-9 flex-none items-center gap-1.5 rounded-[8px] bg-[#1d1d1f] px-3 text-sm font-semibold text-white" title="下载原图"><Icon icon="mdi:download" className="text-lg" aria-hidden />下载</a>}
          </footer>
        )}
      </main>

      <aside className="min-h-0 overflow-y-auto rounded-[12px] border border-[#e8e8ed] bg-white p-4 shadow-[0_16px_44px_rgba(15,23,42,0.055)] xl:h-full">
        <div className="flex items-center justify-between"><div><h2 className="text-[16px] font-semibold text-[#1d1d1f]">创作设置</h2><p className="mt-0.5 text-xs text-[#86868b]">豆包 Seedream 5.0 Lite</p></div><Icon icon="mdi:tune-variant" className="text-xl text-[#86868b]" aria-hidden /></div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold text-[#424245]">参考人物 ({references.length}/{MAX_REFERENCE_COUNT})</p>
          <div className="grid grid-cols-3 gap-2">
            {references.map((reference, index) => (
              <div key={reference.id} className="group relative aspect-[3/4] overflow-hidden rounded-[7px] border border-[#e1e1e6] bg-[#f2f2f5]">
                <img src={reference.previewUrl} alt={`人物参考照 ${index + 1}`} className="h-full w-full object-cover" />
                <button type="button" title="删除参考照" aria-label={`删除参考照 ${index + 1}`} onClick={() => handleDeleteReference(reference)} disabled={deletingReferenceId === reference.id || hasActiveTask} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-100 transition disabled:opacity-30 lg:opacity-0 lg:group-hover:opacity-100"><Icon icon={deletingReferenceId === reference.id ? "mdi:loading" : "mdi:close"} className={deletingReferenceId === reference.id ? "animate-spin" : ""} aria-hidden /></button>
              </div>
            ))}
            {references.length < MAX_REFERENCE_COUNT && <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="flex aspect-[3/4] flex-col items-center justify-center rounded-[7px] border border-dashed border-[#b8b8bf] bg-[#fafafa] text-[#6e6e73] transition disabled:opacity-50" aria-label="上传人物参考照"><Icon icon={isUploading ? "mdi:loading" : "mdi:plus"} className={`text-2xl ${isUploading ? "animate-spin" : ""}`} aria-hidden /><span className="mt-1 text-[11px]">{isUploading ? "上传中" : "添加"}</span></button>}
          </div>
          <input ref={fileInputRef} data-testid="portrait-file-input" type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif" className="hidden" onChange={(event) => handleFiles(event.target.files)} />
          <p className="mt-2 flex items-center gap-1 text-[11px] text-[#86868b]"><Icon icon="mdi:shield-lock-outline" aria-hidden />私有存储，任务结束 24 小时后自动清理</p>
        </div>

        <div className="mt-5 border-t border-[#eeeeF2] pt-4">
          <p className="mb-2 text-xs font-semibold text-[#424245]">形象模板</p>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((preset) => <button key={preset.id} type="button" onClick={() => setPresetId(preset.id)} className={`min-h-[58px] rounded-[8px] border px-3 py-2 text-left transition ${presetId === preset.id ? "border-brand bg-brand-soft text-brand-ink" : "border-[#e1e1e6] text-[#424245]"}`}><span className="block text-sm font-semibold">{preset.name}</span><span className="mt-0.5 block text-[10px] leading-4 opacity-70">{preset.description}</span></button>)}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <ChoiceField label="场景" value={promptOptions.scene} options={SCENE_OPTIONS} onChange={(value) => updatePromptOption("scene", value)} />
          <ChoiceField label="服装" value={promptOptions.outfit} options={OUTFIT_OPTIONS} onChange={(value) => updatePromptOption("outfit", value)} />
          <ChoiceField label="构图" value={promptOptions.composition} options={COMPOSITION_OPTIONS} onChange={(value) => updatePromptOption("composition", value)} />
          <ChoiceField label="表情" value={promptOptions.expression} options={EXPRESSION_OPTIONS} onChange={(value) => updatePromptOption("expression", value)} />
          <label className="grid gap-1.5 text-xs font-semibold text-[#424245]">发型<input value={promptOptions.hair} onChange={(event) => updatePromptOption("hair", event.target.value)} placeholder="保持参考或自定义" className="h-10 rounded-[8px] border border-[#d2d2d7] px-3 text-sm font-normal" /></label>
          <label className="grid gap-1.5 text-xs font-semibold text-[#424245]">妆容<input value={promptOptions.makeup} onChange={(event) => updatePromptOption("makeup", event.target.value)} placeholder="自然或自定义" className="h-10 rounded-[8px] border border-[#d2d2d7] px-3 text-sm font-normal" /></label>
        </div>
        <label className="mt-3 grid gap-1.5 text-xs font-semibold text-[#424245]">补充提示词<textarea aria-label="补充提示词" value={promptOptions.extraPrompt} onChange={(event) => updatePromptOption("extraPrompt", event.target.value)} maxLength={1200} placeholder="光线、氛围、背景细节等" className="min-h-[76px] resize-y rounded-[8px] border border-[#d2d2d7] p-3 text-sm font-normal leading-5" /></label>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div><p className="mb-1.5 text-xs font-semibold text-[#424245]">画面比例</p><InAppSelect icon="mdi:aspect-ratio" label="画面比例" value={aspectRatio} options={ASPECT_OPTIONS} onChange={(value) => setAspectRatio(value as PortraitAspectRatio)} /></div>
          <div><p className="mb-1.5 text-xs font-semibold text-[#424245]">清晰度</p><InAppSelect icon="mdi:image-size-select-large" label="清晰度" value={resolution} options={RESOLUTION_OPTIONS} onChange={(value) => setResolution(value as PortraitResolution)} /></div>
        </div>
        <div className="mt-3"><p className="mb-1.5 text-xs font-semibold text-[#424245]">生成张数</p><div className="grid grid-cols-4 overflow-hidden rounded-[8px] border border-[#d2d2d7]">{[1, 2, 3, 4].map((value) => <button key={value} type="button" onClick={() => setCount(value)} className={`h-9 border-r border-[#e1e1e6] text-sm font-semibold last:border-r-0 ${count === value ? "bg-[#1d1d1f] text-white" : "bg-white text-[#6e6e73]"}`}>{value}</button>)}</div></div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-[8px] border border-[#e1e1e6] bg-[#f8f8fa] p-3 text-xs leading-5 text-[#424245]"><input aria-label="人物授权确认" type="checkbox" checked={authorizationAccepted} onChange={(event) => setAuthorizationAccepted(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1d1d1f]" /><span>我确认参考人物为本人，或已获得本人明确授权，并同意用于本次 AI 形象照生成。</span></label>
        {error && <p role="alert" className="mt-3 rounded-[8px] bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{error}</p>}
        <RippleButton type="button" onClick={handleSubmit} disabled={!canSubmit} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-[#1d1d1f] text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-[#c7c7cc]"><Icon icon={isSubmitting ? "mdi:loading" : "mdi:creation"} className={`text-lg ${isSubmitting ? "animate-spin" : ""}`} aria-hidden />{isSubmitting ? "提交中" : "生成形象照"}{pointCost != null && !isSubmitting ? <span className="font-normal opacity-70">· {pointCost} 点</span> : null}</RippleButton>
        <p className="mt-2 text-center text-[10px] leading-4 text-[#86868b]">AI 生成内容仅作预览，请勿用于证件、身份核验或未经授权的公开传播。</p>
      </aside>
    </section>
  );
}
