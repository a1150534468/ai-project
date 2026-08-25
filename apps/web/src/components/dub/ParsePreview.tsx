import { useState } from "react";
import { Icon } from "@iconify/react";
import { analyzeParsed, type DubAnalysis, type DubParseResult, type DubPricing } from "../../dubApi";
import { estimatePerUnit } from "../../dubWizard";

export interface ParsePreviewProps {
  readonly token: string;
  readonly pricing: DubPricing | null;
  readonly result: DubParseResult;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly onAnalyzed: (a: DubAnalysis) => void;
  readonly onErr: (msg: string) => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 降级 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch { return false; }
}

function DownloadRow({ label, url, onErr }: { label: string; url: string; onErr: (m: string) => void }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[12px] text-ink-tertiary">{label}</span>
      <input readOnly value={url} className="min-w-0 flex-1 truncate bg-transparent text-[12px] text-ink-secondary outline-none" />
      <button
        onClick={async () => { const ok = await copyText(url); if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } else onErr("复制失败，请手动选择链接"); }}
        className="shrink-0 rounded-md bg-brand px-2.5 py-1 text-[12px] text-white"
      >
        {copied ? "已复制" : "一键复制"}
      </button>
    </div>
  );
}

export function ParsePreview({ token, pricing, result, busy, setBusy, onAnalyzed, onErr }: ParsePreviewProps) {
  const priced = pricing?.analyzeVideoSec.enabled ?? false;
  const estimate = pricing ? estimatePerUnit(pricing.analyzeVideoSec, result.video.durationSec) : null;

  const run = async () => {
    setBusy(true);
    try { onAnalyzed(await analyzeParsed(token, result.video.objectKey)); }
    catch (e) { onErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {result.title && <p className="text-[13.5px] font-medium text-ink">{result.title}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {result.cover.url && <img src={result.cover.url} alt="封面" className="w-full rounded-xl object-cover" />}
        <video src={result.video.url} controls className="w-full rounded-xl bg-black" />
      </div>

      <div className="space-y-2 rounded-xl bg-gray-50 p-3">
        <p className="text-[12px] text-ink-tertiary">如需保存到本地，复制链接到浏览器地址栏即可下载：</p>
        <DownloadRow label="视频" url={result.video.url} onErr={onErr} />
        <DownloadRow label="封面" url={result.cover.url} onErr={onErr} />
      </div>

      {priced && estimate !== null && (
        <p className="text-[12px] text-ink-tertiary">拆解预计消耗约 {estimate} 算力点（{result.video.durationSec} 秒）。</p>
      )}
      <button
        disabled={busy || !priced}
        onClick={run}
        className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
      >
        {busy ? (<span className="flex items-center gap-1.5"><Icon icon="mdi:loading" className="animate-spin" />拆解中…</span>) : "开始拆解"}
      </button>
    </div>
  );
}
