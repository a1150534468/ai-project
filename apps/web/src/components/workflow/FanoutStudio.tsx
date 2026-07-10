import { useCallback, useMemo, useState } from "react";
import { ApiError } from "../../apiError";
import * as api from "../../workflowFanoutApi";
import type { FanoutBrief, FanoutDimensionId, FanoutMode, FanoutVariant } from "../../workflowFanoutApi";
import { FanoutStudioView } from "./fanoutStudioView";
import {
  parseSellingPoints, formatSellingPoints, canGenerate as canGen, exportVariantsText, dedupAvailable, parseFanoutCount,
} from "./fanoutStudioModel";

export interface FanoutStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

export function FanoutStudio({ token, onBalanceRefresh }: FanoutStudioProps) {
  const [raw, setRaw] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [brief, setBrief] = useState<FanoutBrief | null>(null);
  const [sellingPointsInput, setSellingPointsInput] = useState("");
  const [mode, setMode] = useState<FanoutMode>("enum");
  const [dimension, setDimension] = useState<FanoutDimensionId | undefined>("platform");
  const [countInput, setCountInput] = useState("10");
  const [dedup, setDedup] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [variants, setVariants] = useState<readonly FanoutVariant[]>([]);
  const [avgSimilarity, setAvgSimilarity] = useState(0);
  const [delivered, setDelivered] = useState(0);
  const [requested, setRequested] = useState(0);
  const [partialFailure, setPartialFailure] = useState(false);
  const [stoppedByBalance, setStoppedByBalance] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveBrief = useMemo<FanoutBrief | null>(
    () => (brief ? { ...brief, sellingPoints: parseSellingPoints(sellingPointsInput) } : null),
    [brief, sellingPointsInput],
  );

  const parsedCount = parseFanoutCount(countInput);

  const onExtract = useCallback(async () => {
    setExtracting(true); setError(null);
    try {
      const { brief: b } = await api.extractBrief(token, raw);
      setBrief(b);
      setSellingPointsInput(formatSellingPoints(b.sellingPoints));
      onBalanceRefresh?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "理解失败，请稍后重试");
    } finally {
      setExtracting(false);
    }
  }, [token, raw, onBalanceRefresh]);

  const onGenerate = useCallback(async () => {
    const pc = parseFanoutCount(countInput);
    if (!effectiveBrief || !pc.ok) return;
    setGenerating(true); setError(null);
    try {
      const res = await api.generateFanout(token, {
        mode, brief: effectiveBrief, count: pc.value,
        dimension: mode === "enum" ? dimension : undefined,
        dedup: dedupAvailable(mode) ? dedup : undefined,
      });
      setVariants(res.variants);
      setAvgSimilarity(res.avgSimilarity);
      setDelivered(res.delivered);
      setRequested(res.requested);
      setPartialFailure(res.partialFailure);
      setStoppedByBalance(res.stoppedByBalance);
      onBalanceRefresh?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "生成失败，请稍后重试");
    } finally {
      setGenerating(false);
    }
  }, [token, mode, effectiveBrief, countInput, dimension, dedup, onBalanceRefresh]);

  const onCopy = useCallback((text: string) => { void navigator.clipboard?.writeText(text); }, []);
  const onExport = useCallback(() => {
    const blob = new Blob([exportVariantsText(variants)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "fanout.txt"; a.click();
    URL.revokeObjectURL(url);
  }, [variants]);

  return (
    <FanoutStudioView
      raw={raw} onRawChange={setRaw} extracting={extracting} onExtract={onExtract}
      brief={brief} onBriefChange={(patch) => setBrief((b) => (b ? { ...b, ...patch } : b))}
      sellingPointsInput={sellingPointsInput} onSellingPointsInput={setSellingPointsInput}
      mode={mode} onModeChange={setMode} dimension={dimension} onDimensionChange={setDimension}
      count={parsedCount.ok ? parsedCount.value : 0}
      countInput={countInput} onCountInputChange={setCountInput}
      onQuickCount={(n) => setCountInput(String(n))}
      countError={parsedCount.ok ? null : parsedCount.error}
      dedup={dedup} onDedupChange={setDedup}
      generating={generating}
      canGenerate={!!effectiveBrief && parsedCount.ok && canGen({ mode, brief: effectiveBrief, dimension })}
      onGenerate={onGenerate}
      variants={variants} avgSimilarity={avgSimilarity} delivered={delivered} requested={requested}
      partialFailure={partialFailure} stoppedByBalance={stoppedByBalance}
      error={error} onCopy={onCopy} onExport={onExport}
    />
  );
}
