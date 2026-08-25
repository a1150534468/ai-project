import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { SlidingNumber } from "../ui/sliding-number";
import {
  MODEL_DURATION_OPTIONS,
  MODEL_RESOLUTION_OPTIONS,
  type VideoAspectRatio,
  type VideoModel,
  type VideoResolution,
} from "../../videoApi";

const ASPECT_OPTIONS: VideoAspectRatio[] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const RESOLUTION_LABELS: Record<VideoResolution, string> = { "480p": "标清 480p", "720p": "高清 720p", "1080p": "超清 1080p", "4k": "超清 4K" };

interface VideoSettingsPopoverProps {
  readonly model: VideoModel;
  readonly aspectRatio: VideoAspectRatio;
  readonly resolution: VideoResolution;
  readonly durationSec: number;
  readonly generateAudio: boolean;
  readonly onAspectRatioChange: (value: VideoAspectRatio) => void;
  readonly onResolutionChange: (value: VideoResolution) => void;
  readonly onDurationChange: (value: number) => void;
  readonly onGenerateAudioChange: (value: boolean) => void;
}

function durationLabel(model: VideoModel, durationSec: number): string {
  return MODEL_DURATION_OPTIONS[model].find((d) => d.value === durationSec)?.label ?? `${durationSec}s`;
}

// 自定义时长滑块：白底黑条 + 简洁黑点，拖动无极顺滑（值取整），无 hover 放大、无聚焦光圈。
function DurationSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const MIN = 4;
  const MAX = 15;
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const ratio = dragRatio ?? (value - MIN) / (MAX - MIN);
  const commit = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setDragRatio(r);
    onChange(Math.round(MIN + r * (MAX - MIN)));
  };
  return (
    <div
      ref={trackRef}
      className="relative h-6 w-full cursor-pointer touch-none select-none"
      onPointerDown={(e) => { draggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); commit(e.clientX); }}
      onPointerMove={(e) => { if (draggingRef.current) commit(e.clientX); }}
      onPointerUp={(e) => { draggingRef.current = false; setDragRatio(null); e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { draggingRef.current = false; setDragRatio(null); }}
    >
      <div className="absolute left-0 top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-surface-muted" />
      <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-inverse" style={{ width: `${ratio * 100}%` }} />
      <div className="absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-surface-inverse shadow-[0_1px_4px_rgba(0,0,0,0.28)]" style={{ left: `${ratio * 100}%` }} />
    </div>
  );
}

// 合并「画幅 / 分辨率 / 音频 / 时长」的一体化弹窗；收起态显示摘要 9:16 · 720p · 15s。
export function VideoSettingsPopover(props: VideoSettingsPopoverProps) {
  const { model, aspectRatio, resolution, durationSec, generateAudio } = props;
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isMini = model === "seedance-2-mini";
  // 2.0 / fast 用滑块（4-15 连续）；滑块显示值把「自动/非法」兜底到 15。
  const sliderValue = durationSec >= 4 && durationSec <= 15 ? durationSec : 15;

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
      setDropUp(window.innerHeight - rect.bottom < 360);
    }
    setOpen((v) => !v);
  };

  const summary = `${aspectRatio} · ${resolution} · ${durationLabel(model, durationSec)}`;

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label="视频设置" aria-expanded={open} onClick={toggle}
        className={`flex w-full items-center gap-2 rounded-[10px] border bg-white px-3 py-2.5 text-left transition ${open ? "border-ink" : "border-hairline-subtle "}`}>
        <span className="shrink-0 text-xs text-ink-tertiary">视频设置</span>
        <span className="ml-auto min-w-0 truncate text-sm font-medium text-ink">{summary}</span>
        <Icon icon="mdi:chevron-down" className={`shrink-0 text-base text-ink-tertiary transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className={`absolute right-0 z-30 grid w-[calc(200%+0.5rem)] gap-3.5 rounded-[14px] border border-hairline-subtle bg-white p-3.5 shadow-[0_16px_40px_rgba(20,20,45,0.16)] ${dropUp ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"}`}>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold text-ink-secondary">视频比例</p>
            <div className="grid grid-cols-6 gap-1.5">
              {ASPECT_OPTIONS.map((a) => {
                const on = a === aspectRatio;
                return (
                  <button key={a} type="button" onClick={() => props.onAspectRatioChange(a)}
                    className={`rounded-[8px] border px-1 py-2 text-[11px] transition ${on ? "border-ink font-semibold text-ink" : "border-hairline-subtle text-ink-tertiary "}`}>
                    {a}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold text-ink-secondary">分辨率</p>
            <div className="flex flex-wrap gap-1.5">
              {MODEL_RESOLUTION_OPTIONS[model].map((r) => {
                const on = r === resolution;
                return (
                  <button key={r} type="button" onClick={() => props.onResolutionChange(r)}
                    className={`rounded-[8px] border px-3 py-2 text-[12px] transition ${on ? "border-ink font-semibold text-ink" : "border-hairline-subtle text-ink-tertiary "}`}>
                    {RESOLUTION_LABELS[r]}
                  </button>
                );
              })}
            </div>
          </div>
          {!isMini && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-ink-secondary">音频</p>
              <div className="grid grid-cols-2 gap-1.5">
                {([[true, "含音频"], [false, "静音"]] as Array<[boolean, string]>).map(([val, label]) => {
                  const on = generateAudio === val;
                  return (
                    <button key={label} type="button" onClick={() => props.onGenerateAudioChange(val)}
                      className={`rounded-[8px] border px-3 py-2 text-[12px] transition ${on ? "border-ink font-semibold text-ink" : "border-hairline-subtle text-ink-tertiary "}`}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold text-ink-secondary">时长</p>
            {isMini ? (
              <div className="flex flex-wrap gap-1.5">
                {MODEL_DURATION_OPTIONS[model].map((d) => {
                  const on = d.value === durationSec;
                  return (
                    <button key={d.value} type="button" onClick={() => props.onDurationChange(d.value)}
                      className={`rounded-[8px] border px-3 py-2 text-[12px] transition ${on ? "border-ink font-semibold text-ink" : "border-hairline-subtle text-ink-tertiary "}`}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-1">
                <div className="mb-1.5 flex items-center justify-between text-[12px]">
                  <span className="text-ink-tertiary">4s</span>
                  <span className="flex items-center text-[15px] font-semibold text-brand">
                    <SlidingNumber value={sliderValue} />s
                  </span>
                  <span className="text-ink-tertiary">15s</span>
                </div>
                <DurationSlider value={sliderValue} onChange={props.onDurationChange} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
