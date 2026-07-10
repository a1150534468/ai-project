import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

export interface BusyOverlayProps {
  readonly show: boolean;
  readonly title: string;
  /** 轮播提示语，缓解长等待（拆解/合成可能几十秒到几分钟） */
  readonly hints?: readonly string[];
}

export function BusyOverlay({ show, title, hints = [] }: BusyOverlayProps) {
  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!show) { setTick(0); setElapsed(0); return; }
    const hintTimer = setInterval(() => setTick((t) => t + 1), 3200);
    const secTimer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => { clearInterval(hintTimer); clearInterval(secTimer); };
  }, [show]);

  if (!show) return null;
  const hint = hints.length > 0 ? hints[tick % hints.length] : "";

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-white/75 backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <span className="relative flex h-12 w-12 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand/25" aria-hidden />
          <Icon icon="mdi:loading" className="relative animate-spin text-[30px] text-brand" />
        </span>
        <p className="text-[14px] font-semibold text-[#1d1d1f]">{title}</p>
        {hint && <p className="max-w-xs text-[12px] text-[#8a8a8f] transition-opacity">{hint}</p>}
        <p className="text-[11px] tabular-nums text-[#c7c7cc]">已用时 {elapsed}s</p>
      </div>
    </div>
  );
}
