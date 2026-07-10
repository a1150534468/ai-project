import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import { RippleButton, Stagger, StaggerItem, msgIn, useToast } from "../../motion";
import { VideoSettingsPopover } from "./VideoSettingsPopover";
import {
  VIDEO_MATERIAL_LIMITS,
  materialKindOf,
  type MaterialKind,
  type VideoAspectRatio,
  type VideoModel,
  type VideoResolution,
  type WorkflowVideoAsset,
  type WorkflowVideoPricingRow,
  type WorkflowVideoTask,
} from "../../videoApi";

interface StudioMaterial {
  readonly url: string;
  readonly mime: string;
  readonly name: string;
  readonly durationSec: number;
}

interface VideoGenerationStudioProps {
  readonly prompt: string;
  readonly model: VideoModel;
  readonly aspectRatio: VideoAspectRatio;
  readonly resolution: VideoResolution;
  readonly durationSec: number;
  readonly generateAudio: boolean;
  readonly materials: readonly StudioMaterial[];
  readonly materialCounts: Record<MaterialKind, number>;
  readonly inputVideoDurationSec: number;
  readonly materialNotice: string;
  readonly error: string;
  readonly isSubmitting: boolean;
  readonly pricingRows: readonly WorkflowVideoPricingRow[];
  readonly tasks: readonly WorkflowVideoTask[];
  readonly videos: readonly WorkflowVideoAsset[];
  readonly onPromptChange: (value: string) => void;
  readonly onModelChange: (value: VideoModel) => void;
  readonly onAspectRatioChange: (value: VideoAspectRatio) => void;
  readonly onResolutionChange: (value: VideoResolution) => void;
  readonly onDurationChange: (value: number) => void;
  readonly onGenerateAudioChange: (value: boolean) => void;
  readonly onRemoveMaterial: (url: string) => void;
  readonly onUploadMaterial: (file: File) => void;
  readonly onHelpWrite: () => void;
  readonly onNewTask: () => void;
  readonly onSubmit: () => void;
}

const MODEL_OPTIONS: Array<{ value: VideoModel; label: string; desc: string }> = [
  { value: "seedance-2", label: "Seedance-2.0-VIP", desc: "正式投放首选" },
  { value: "seedance-2-fast", label: "Seedance-2.0-Fast-VIP", desc: "快速演示验证" },
  { value: "seedance-2-mini", label: "Seedance-2.0-Mini-VIP", desc: "低成本测试" },
];

const ASPECT_OPTIONS: VideoAspectRatio[] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const KIND_META: Record<MaterialKind, { label: string; icon: string; badge: string }> = {
  image: { label: "图片", icon: "mdi:image-outline", badge: "图" },
  video: { label: "视频", icon: "mdi:play-circle-outline", badge: "视频" },
  audio: { label: "音频", icon: "mdi:music-note-outline", badge: "音频" },
};
const STATUS_LABELS: Record<WorkflowVideoTask["status"], string> = {
  running: "生成中",
  completed: "已完成",
  failed: "失败",
};

interface DropdownChoice {
  readonly value: string;
  readonly label: string;
  readonly desc?: string;
}

// 自定义下拉（非浏览器原生 select）：点击展开、点外部关闭、靠近视口底部时向上弹。
// wideMenu：在 2 列栅格左格中，菜单向右撑满整栏（跨两列 + gap），而非只占按钮半格宽。
function Dropdown({ value, choices, onSelect, ariaLabel, compact, wideMenu }: {
  readonly value: string;
  readonly choices: readonly DropdownChoice[];
  readonly onSelect: (value: string) => void;
  readonly ariaLabel: string;
  readonly compact?: boolean;
  readonly wideMenu?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = choices.find((c) => c.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const toggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropUp(window.innerHeight - rect.bottom < 240);
    }
    setOpen((v) => !v);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={toggle}
        className={`flex w-full items-center gap-2 rounded-[10px] border bg-white text-left transition ${compact ? "px-3 py-2.5 justify-between" : "px-3 py-2.5"} ${open ? "border-[#1d1d1f]" : "border-[#e8e8ed] hover:border-[#d2d2d7]"}`}
      >
        {!compact && <span className="text-xs text-[#8a8a8f]">{ariaLabel}</span>}
        <span className={`truncate text-sm font-medium text-[#1d1d1f] ${compact ? "" : "ml-auto"}`}>{current?.label ?? value}</span>
        <Icon icon="mdi:chevron-down" className={`shrink-0 text-base text-[#b6b6bd] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className={`absolute z-30 max-h-[230px] overflow-auto rounded-[12px] border border-[#e3e3e8] bg-white p-1.5 shadow-[0_12px_32px_rgba(20,20,45,0.14)] ${wideMenu ? "left-0 w-[calc(200%+0.5rem)]" : "left-0 right-0"} ${dropUp ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"}`}>
          {choices.map((c) => {
            const on = c.value === value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => { onSelect(c.value); setOpen(false); }}
                className={`flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left transition hover:bg-[#f6f6f8] ${on ? "bg-[#f6f6f8]" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm ${on ? "font-semibold text-[#1d1d1f]" : "text-[#1d1d1f]"}`}>{c.label}</span>
                  {c.desc && <span className="block truncate text-[11px] text-[#8a8a8f]">{c.desc}</span>}
                </span>
                {on && <Icon icon="mdi:check" className="shrink-0 text-sm text-[#1d1d1f]" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Estimate {
  readonly points: number;
  readonly auto: boolean;
}

function estimateVideoPoints(rows: readonly WorkflowVideoPricingRow[], model: VideoModel, resolution: VideoResolution, hasInputVideo: boolean, durationSec: number, inputVideoDurationSec: number): Estimate | null {
  const row = rows.find((item) => item.model === model && item.resolution === resolution && item.hasInputVideo === hasInputVideo);
  if (!row?.enabled) return null;
  const auto = durationSec <= 0;
  const outputSec = auto ? 15 : durationSec; // 自动时长按最大 15s 预扣
  if (row.pricingType === "VIDEO_IO") {
    // 复合计价：输入视频秒数 × 输入单价 + 输出秒数 × 输出单价；输入时长未知则无法预估。
    if (inputVideoDurationSec <= 0) return null;
    return { points: Math.ceil(row.rate * inputVideoDurationSec + row.outputRate * outputSec), auto };
  }
  const perUnits = row.perUnits > 0 ? row.perUnits : 1;
  return { points: Math.ceil((row.rate * outputSec) / perUnits), auto };
}

// 把上游/内部的原始报错映射成用户友好的短提示，避免把一大坨英文 JSON 直接甩给用户。
function friendlyTaskError(error: string): string {
  if (/quota_not_enough|quota is not enough|额度不足/i.test(error)) return "视频生成服务额度不足，请稍后再试或联系管理员";
  if (/timeout|超时|abort/i.test(error)) return "视频生成服务响应超时（上游繁忙），请稍后重试";
  if (/\b40[13]\b|unauthorized|forbidden/i.test(error)) return "视频生成服务暂不可用，请稍后再试或联系管理员";
  if (/insufficient|余额不足|视频点/i.test(error)) return "视频点不足，请充值后重试";
  const trimmed = error.trim().replace(/^(生成失败[:：]\s*)+/, ""); // 去掉上游已带的「生成失败：」避免叠加
  if (!trimmed) return "生成失败，请重试";
  return trimmed.length > 60 ? `生成失败：${trimmed.slice(0, 60)}…` : `生成失败：${trimmed}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function isVideoModel(value: string): value is VideoModel {
  return MODEL_OPTIONS.some((item) => item.value === value);
}

function isAspectRatio(value: string): value is VideoAspectRatio {
  return ASPECT_OPTIONS.includes(value as VideoAspectRatio);
}

export function VideoGenerationStudio({
  prompt,
  model,
  aspectRatio,
  resolution,
  durationSec,
  generateAudio,
  materials,
  materialCounts,
  inputVideoDurationSec,
  materialNotice,
  error,
  isSubmitting,
  pricingRows,
  tasks,
  videos,
  onPromptChange,
  onModelChange,
  onAspectRatioChange,
  onResolutionChange,
  onDurationChange,
  onGenerateAudioChange,
  onRemoveMaterial,
  onUploadMaterial,
  onHelpWrite,
  onNewTask,
  onSubmit,
}: VideoGenerationStudioProps) {
  const hasInputVideo = materialCounts.video > 0;
  const estimate = estimateVideoPoints(pricingRows, model, resolution, hasInputVideo, durationSec, inputVideoDurationSec);
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // 预览选择：undefined=默认最新，null=新建清空，string=某历史任务 requestId
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [downloadOpen, setDownloadOpen] = useState(false);

  const displayedVideo = selected === null
    ? null
    : selected === undefined
      ? (videos[0] ?? null)
      : (videos.find((v) => v.requestId === selected) ?? null);
  const selectedTask = typeof selected === "string" ? (tasks.find((t) => t.requestId === selected) ?? null) : null;
  const displayedPrompt = selectedTask?.prompt ?? displayedVideo?.prompt ?? "";

  const handleDropFiles = (fileList: FileList | null) => {
    setDragActive(false);
    if (!fileList || fileList.length === 0) return;
    for (const file of Array.from(fileList)) onUploadMaterial(file);
  };

  const modelChoices: DropdownChoice[] = MODEL_OPTIONS.map((m) => ({ value: m.value, label: m.label, desc: m.desc }));

  const kinds: MaterialKind[] = ["image", "video", "audio"];

  return (
    <section className="grid min-h-[calc(100vh-4rem)] grid-cols-1 gap-3 bg-[#f5f7fa] p-3 xl:grid-cols-[minmax(320px,460px)_minmax(0,1fr)_180px]">
      <aside className="flex flex-col rounded-[14px] border border-[#e8e8ed] bg-white shadow-[0_12px_34px_rgba(15,23,42,0.045)] xl:max-h-[calc(100vh-5.5rem)]">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-base font-semibold text-[#1d1d1f]">AI 视频</h1>
          <button type="button" onClick={() => { setSelected(null); onNewTask(); }} className="inline-flex h-8 items-center gap-1 rounded-[8px] px-2 text-xs font-semibold text-[#1d1d1f] hover:bg-[#f5f5f7]">
            <Icon icon="mdi:plus" className="text-sm" aria-hidden />
            新建
          </button>
        </div>

        {/* 参考素材 */}
        <p className="mb-2 text-xs font-semibold text-[#6e6e73]">参考素材</p>
        <label
          onDragOver={(event) => { event.preventDefault(); if (!dragActive) setDragActive(true); }}
          onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragLeave={(event) => { event.preventDefault(); if (event.currentTarget === event.target) setDragActive(false); }}
          onDrop={(event) => { event.preventDefault(); handleDropFiles(event.dataTransfer.files); }}
          className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-[13px] border-[1.5px] border-dashed p-4 text-center transition ${
            dragActive ? "border-brand bg-brand-soft" : "border-[#e3e3e8] bg-[#f6f6f8] hover:border-[#c9c9d1] hover:bg-[#f1f1f4]"
          }`}
        >
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-white shadow-[0_1px_3px_rgba(20,20,40,0.07)]">
            <Icon icon="mdi:tray-arrow-up" className="text-base text-[#1d1d1f]" aria-hidden />
          </span>
          <span className="text-[13px] font-medium text-[#1d1d1f]">拖入或点击上传</span>
          <span className="text-[11px] text-[#8a8a8f]">支持 图片 / 视频 / 音频</span>
          <input type="file" accept="image/*,video/*,audio/*" className="sr-only" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUploadMaterial(file);
            event.target.value = "";
          }} />
        </label>
        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
          {kinds.map((k) => {
            const full = materialCounts[k] >= VIDEO_MATERIAL_LIMITS[k];
            return (
              <div key={k} className="rounded-[9px] bg-[#f6f6f8] px-2 py-1.5">
                <span className="text-[13px] font-semibold text-[#1d1d1f]">{materialCounts[k]}<span className={full ? "text-[#c7c7cc]" : "text-[#8a8a8f]"}> / {VIDEO_MATERIAL_LIMITS[k]}</span></span>
                <span className="block text-[11px] text-[#6e6e73]">{KIND_META[k].label}</span>
              </div>
            );
          })}
        </div>
        {materials.length > 0 && (
          <div className="mt-2.5 grid gap-1.5">
            {materials.map((m) => {
              const kind = materialKindOf(m.mime) ?? "image";
              const meta = KIND_META[kind];
              const bg = kind === "video" ? "from-[#3a3a44] to-[#20202a]" : kind === "image" ? "from-[#7d8ea8] to-[#5c6b84]" : "from-[#caa46a] to-[#a8823f]";
              return (
                <div key={m.url} className="flex items-center gap-2.5 rounded-[11px] border border-[#ececf0] p-1.5">
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-[8px] bg-gradient-to-br text-white ${bg}`}>
                    <Icon icon={meta.icon} className="text-base" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-[#1d1d1f]">{m.name}</span>
                    <span className="block text-[10.5px] text-[#8a8a8f]">{meta.label}{m.durationSec > 0 ? ` · ${m.durationSec}s` : ""}</span>
                  </span>
                  <button type="button" aria-label={`移除 ${m.name}`} onClick={() => onRemoveMaterial(m.url)} className="px-1 text-[#b7b7bf] transition hover:text-[#8a8a90]">
                    <Icon icon="mdi:close" className="text-base" aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {materialNotice && <p className="mt-2 rounded-[8px] bg-brand-soft px-3 py-2 text-xs font-semibold text-brand-ink">{materialNotice}</p>}

        {/* 脚本 / 提示词 */}
        <div className="mt-4 mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold text-[#6e6e73]">脚本 / 提示词</p>
          <button
            type="button"
            onClick={onHelpWrite}
            className="inline-flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-brand-hover"
          >
            <Icon icon="mdi:auto-fix" className="text-sm" aria-hidden />
            帮我写
          </button>
        </div>
        <textarea
          value={prompt}
          maxLength={2000}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="描述场景、镜头运动、主体动作、风格和声音氛围，或点「帮我写」自动生成脚本"
          className="w-full flex-1 min-h-[112px] resize-none rounded-[12px] border border-[#e3e3e8] p-3 text-sm leading-6 text-[#1d1d1f] outline-none focus:border-[#c3c3cc]"
        />
        <p className="mt-1 text-right text-[11px] font-medium text-[#8a8a8f]">{prompt.length} / 2000</p>

        {/* 配置：模型 + 视频设置（合并弹窗） */}
        <p className="mt-4 mb-2 text-xs font-semibold text-[#6e6e73]">配置</p>
        <div className="grid grid-cols-2 gap-2">
          <Dropdown wideMenu ariaLabel="模型" value={model} choices={modelChoices} onSelect={(v) => onModelChange(v as VideoModel)} />
          <VideoSettingsPopover
            model={model}
            aspectRatio={aspectRatio}
            resolution={resolution}
            durationSec={durationSec}
            generateAudio={generateAudio}
            onAspectRatioChange={onAspectRatioChange}
            onResolutionChange={onResolutionChange}
            onDurationChange={onDurationChange}
            onGenerateAudioChange={onGenerateAudioChange}
          />
        </div>
        </div>

        <div className="shrink-0 border-t border-[#ececf0] p-3">
        {error && <p className="mb-2 rounded-[9px] bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <RippleButton
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={isSubmitting || !prompt.trim() || estimate === null}
          className="z-10 h-11 w-full rounded-[9px] bg-[#1d1d1f] text-sm font-semibold text-white transition hover:bg-[#333] disabled:cursor-not-allowed disabled:bg-[#c7c7cc]"
        >
          {isSubmitting ? "提交中" : "立即生成视频"}
          <span className="ml-3 text-xs font-medium opacity-80">
            {estimate === null
              ? (hasInputVideo && inputVideoDurationSec <= 0 ? "请上传输入视频以估价" : "价格未启用")
              : estimate.auto
                ? `按实际结算 · 预扣 ${estimate.points}`
                : `预计 ${estimate.points} 视频点`}
          </span>
        </RippleButton>
        </div>

        {confirmOpen && estimate && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
            role="dialog"
            aria-modal="true"
            onClick={() => setConfirmOpen(false)}
          >
            <div className="w-full max-w-[320px] rounded-[16px] bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.25)]" onClick={(event) => event.stopPropagation()}>
              <h3 className="text-[15px] font-semibold text-[#1d1d1f]">确认生成</h3>
              <p className="mt-2.5 text-[13px] leading-6 text-[#6e6e73]">
                {estimate.auto ? (
                  <>本次将预扣 <b className="font-semibold text-[#1d1d1f]">{estimate.points} 视频点</b>（按最长 15 秒），生成后按<b className="font-semibold text-[#1d1d1f]">实际时长结算、多退</b>。确认生成？</>
                ) : (
                  <>本次预计扣除 <b className="font-semibold text-[#1d1d1f]">{estimate.points} 视频点</b>，确认生成？</>
                )}
              </p>
              <div className="mt-4 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  className="h-10 flex-1 rounded-[10px] border border-[#e3e3e8] text-[13px] font-semibold text-[#1d1d1f] transition hover:bg-[#f6f6f8]"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => { setConfirmOpen(false); setSelected(undefined); onSubmit(); }}
                  className="h-10 flex-1 rounded-[10px] bg-[#1d1d1f] text-[13px] font-semibold text-white transition hover:bg-[#333]"
                >
                  确认生成
                </button>
              </div>
            </div>
          </div>
        )}
      </aside>

      <main className="flex min-h-[420px] flex-col rounded-[14px] border border-[#e8e8ed] bg-white">
        <div className="flex h-11 items-center gap-5 border-b border-[#e8e8ed] px-5 text-sm font-semibold text-[#1d1d1f]">
          <span>预览</span>
          <span className="border-b-2 border-[#1d1d1f] py-3">收藏</span>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#fafafa]">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5">
            {displayedVideo ? (
              <video key={displayedVideo.id} src={displayedVideo.originalUrl} controls className="max-h-full max-w-full rounded-[10px] bg-black object-contain" />
            ) : selectedTask ? (
              <div className="grid place-items-center gap-3 text-center text-[#8a8a8f]">
                <Icon icon={selectedTask.status === "running" ? "mdi:progress-clock" : "mdi:alert-circle-outline"} className="text-6xl" aria-hidden />
                <p className="text-sm font-medium">{selectedTask.status === "failed" ? "该任务生成失败" : selectedTask.status === "running" ? "该任务生成中…" : "视频未成功保存，请重新生成"}</p>
              </div>
            ) : (
              <div className="grid place-items-center gap-3 text-center text-[#8a8a8f]">
                <Icon icon="mdi:video-outline" className="text-6xl" aria-hidden />
                <p className="text-sm font-medium">暂无视频</p>
              </div>
            )}
          </div>
          {(displayedVideo || selectedTask) && displayedPrompt && (
            <div className="flex items-start gap-2 border-t border-[#ececf0] bg-white px-5 py-3">
              <p className="min-w-0 flex-1 line-clamp-2 text-xs leading-5 text-[#6e6e73]">{displayedPrompt}</p>
              {displayedVideo && (
                <button
                  type="button"
                  onClick={() => setDownloadOpen(true)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-[#1d1d1f] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#333]"
                >
                  <Icon icon="mdi:download" className="text-sm" aria-hidden />
                  下载
                </button>
              )}
            </div>
          )}
        </div>
      </main>

      <aside className="rounded-[14px] border border-[#e8e8ed] bg-white p-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[#1d1d1f]">任务队列</h2>
          <span className="text-xs text-[#8a8a8f]">生成中 {runningCount}</span>
        </div>
        <div className="grid gap-2">
          {tasks.length > 0 ? (
            <Stagger className="grid gap-2">
              {tasks.map((task) => (
                <StaggerItem key={task.id}>
                  <motion.div
                    onClick={() => setSelected(task.requestId)}
                    className={`cursor-pointer rounded-[10px] border p-3 transition hover:border-[#c9c9d1] ${selected === task.requestId ? "border-[#1d1d1f] bg-[#fafafa]" : "border-[#e8e8ed]"}`}
                    layout
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[#1d1d1f]">{STATUS_LABELS[task.status]}</span>
                      <motion.span
                        className="text-xs font-semibold text-brand-ink"
                        key={task.progress}
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.2 }}
                      >
                        {task.progress}%
                      </motion.span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs text-[#6e6e73]">{task.prompt}</p>
                    <p className="mt-2 text-[11px] text-[#8a8a8f]">{task.resolution} · {task.durationSec}s · {formatTime(task.createdAt)}</p>
                    {task.error && <p className="mt-2 text-xs leading-5 text-red-600">{friendlyTaskError(task.error)}</p>}
                  </motion.div>
                </StaggerItem>
              ))}
            </Stagger>
          ) : (
            <p className="rounded-[10px] bg-[#f7faf9] px-3 py-8 text-center text-xs text-[#8a8a8f]">暂无任务</p>
          )}
        </div>
      </aside>

      {downloadOpen && displayedVideo && (
        <DownloadModal url={displayedVideo.originalUrl} onClose={() => setDownloadOpen(false)} />
      )}
    </section>
  );
}

// 视频下载弹窗：展示直链 + 一键复制 + 引导到浏览器打开下载（规避 App 内直接下载受限）。
function DownloadModal({ url, onClose }: { url: string; onClose: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.show("ok", "链接已复制");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.show("err", "复制失败，请手动选择链接复制");
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-[440px] rounded-[16px] bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.25)]" onClick={(event) => event.stopPropagation()}>
        <h3 className="text-[15px] font-semibold text-[#1d1d1f]">下载视频</h3>
        <p className="mt-2 text-[13px] leading-6 text-[#6e6e73]">复制下方链接，在浏览器地址栏打开即可下载视频。</p>
        <div className="mt-3 flex items-center gap-2 rounded-[8px] border border-[#e8e8ed] bg-[#fafafa] p-2">
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-none border-0 bg-transparent px-1 text-[12px] text-[#1d1d1f] outline-none" />
          <button type="button" onClick={copy} className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-[#1d1d1f] px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-[#333]">
            <Icon icon={copied ? "mdi:check" : "mdi:content-copy"} className="text-sm" aria-hidden />
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="h-10 rounded-[10px] border border-[#e3e3e8] px-5 text-[13px] font-semibold text-[#1d1d1f] transition hover:bg-[#f6f6f8]">关闭</button>
        </div>
      </div>
    </div>
  );
}

export function coerceVideoModel(value: string, fallback: VideoModel): VideoModel {
  return isVideoModel(value) ? value : fallback;
}

export function coerceVideoAspectRatio(value: string, fallback: VideoAspectRatio): VideoAspectRatio {
  return isAspectRatio(value) ? value : fallback;
}
