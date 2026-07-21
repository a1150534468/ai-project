import { useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { analyzeVideo, parseShare, type DubAnalysis, type DubParseResult, type DubPricing } from "../../dubApi";
import { estimatePerUnit, estimatePerCall } from "../../dubWizard";
import { ParsePreview } from "./ParsePreview";

const MAX_BYTES = 50 * 1024 * 1024;

export interface SourcePanelProps {
  readonly token: string;
  readonly pricing: DubPricing | null;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly onAnalyzed: (a: DubAnalysis) => void;
  readonly onManualScript: (text: string) => void;
  readonly onErr: (msg: string) => void;
}

export function SourcePanel({ token, pricing, busy, setBusy, onAnalyzed, onManualScript, onErr }: SourcePanelProps) {
  const [mode, setMode] = useState<"link" | "upload" | "manual">("link");
  const [file, setFile] = useState<File | null>(null);
  const [manual, setManual] = useState("");
  const [shareText, setShareText] = useState("");
  const [parsed, setParsed] = useState<DubParseResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const priced = pricing?.analyzeVideoSec.enabled ?? false;
  // 未知真实时长，按 60s 给一个上限提示；实际按后端 ffprobe 秒数扣费
  const estimate = pricing ? estimatePerUnit(pricing.analyzeVideoSec, 60) : null;

  const parseEstimate = pricing ? estimatePerCall(pricing.parseVideo) : null;
  const parsePriced = pricing?.parseVideo.enabled ?? false;

  const runParse = async () => {
    if (!shareText.trim()) return;
    setBusy(true);
    try { setParsed(await parseShare(token, shareText.trim())); }
    catch (e) { onErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const pick = (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) { onErr("仅支持视频文件"); return; }
    if (f.size > MAX_BYTES) { onErr("参考视频不能超过 50MB"); return; }
    setFile(f);
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      onAnalyzed(await analyzeVideo(token, file));
    } catch (e) {
      onErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        {(["link", "upload", "manual"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium ${mode === m ? "bg-brand text-white" : "bg-gray-100 text-[#5a5a60]"}`}
          >
            {m === "link" ? "粘贴链接" : m === "upload" ? "上传参考视频" : "直接写文案"}
          </button>
        ))}
      </div>

      {mode === "link" ? (
        parsed ? (
          <ParsePreview
            token={token}
            pricing={pricing}
            result={parsed}
            busy={busy}
            setBusy={setBusy}
            onAnalyzed={onAnalyzed}
            onErr={onErr}
          />
        ) : (
          <div className="space-y-3">
            <textarea
              value={shareText}
              onChange={(e) => setShareText(e.target.value)}
              rows={5}
              placeholder="粘贴抖音等分享文案或链接，例如：0.76 复制打开抖音…… https://v.douyin.com/xxxx/"
              className="w-full rounded-xl border border-gray-200 p-3 text-[13.5px] outline-none focus:border-brand"
            />
            {!parsePriced && <p className="text-[12px] text-amber-600">管理员尚未配置解析价格，暂无法解析。</p>}
            {parsePriced && parseEstimate !== null && (
              <p className="text-[12px] text-[#8a8a8f]">解析预计消耗约 {parseEstimate} 算力点/次（拆解按视频时长另计）。</p>
            )}
            <button
              disabled={!shareText.trim() || busy || !parsePriced}
              onClick={runParse}
              className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {busy ? "解析中…" : "解析"}
            </button>
          </div>
        )
      ) : mode === "upload" ? (
        <div className="space-y-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-10 text-[#8a8a8f] "
          >
            <Icon icon="mdi:cloud-upload-outline" className="text-3xl" />
            <span className="text-[13px]">{file ? file.name : "点击选择参考视频（≤50MB）"}</span>
          </button>
          <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />

          {!priced && <p className="text-[12px] text-amber-600">管理员尚未配置视频拆解价格，暂无法拆解。</p>}
          {priced && estimate !== null && (
            <p className="text-[12px] text-[#8a8a8f]">预计消耗约 {estimate} 算力点（60 秒视频），按实际时长结算。</p>
          )}

          <button
            disabled={!file || busy || !priced}
            onClick={run}
            className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {busy ? (<span className="flex items-center gap-1.5"><Icon icon="mdi:loading" className="animate-spin" />拆解中…</span>) : "开始拆解"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <textarea
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            rows={10}
            placeholder="直接粘贴或撰写口播文案，可跳过视频拆解"
            className="w-full rounded-xl border border-gray-200 p-3 text-[13.5px] outline-none focus:border-brand"
          />
          <button
            disabled={!manual.trim()}
            onClick={() => onManualScript(manual.trim())}
            className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            使用这段文案
          </button>
        </div>
      )}
    </div>
  );
}
