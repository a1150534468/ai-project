import type { ReactNode } from "react";
import { Icon } from "@iconify/react";
import type { FanoutBrief, FanoutDimensionId, FanoutMode, FanoutVariant } from "../../workflowFanoutApi";
import {
  FANOUT_COUNT_OPTIONS, MODE_OPTIONS, ENUM_DIMENSION_OPTIONS, dedupAvailable, averageSimilarityLabel,
} from "./fanoutStudioModel";

export interface FanoutStudioViewProps {
  readonly raw: string;
  readonly onRawChange: (v: string) => void;
  readonly extracting: boolean;
  readonly onExtract: () => void;
  readonly brief: FanoutBrief | null;
  readonly onBriefChange: (patch: Partial<FanoutBrief>) => void;
  readonly sellingPointsInput: string;
  readonly onSellingPointsInput: (v: string) => void;
  readonly mode: FanoutMode;
  readonly onModeChange: (m: FanoutMode) => void;
  readonly dimension?: FanoutDimensionId;
  readonly onDimensionChange: (d: FanoutDimensionId) => void;
  readonly count: number;
  readonly countInput: string;
  readonly onCountInputChange: (v: string) => void;
  readonly onQuickCount: (value: number) => void;
  readonly countError: string | null;
  readonly dedup: boolean;
  readonly onDedupChange: (v: boolean) => void;
  readonly generating: boolean;
  readonly canGenerate: boolean;
  readonly onGenerate: () => void;
  readonly variants: readonly FanoutVariant[];
  readonly avgSimilarity: number;
  readonly delivered: number;
  readonly requested: number;
  readonly partialFailure: boolean;
  readonly stoppedByBalance: boolean;
  readonly error: string | null;
  readonly onCopy: (text: string) => void;
  readonly onExport: () => void;
}

const CARD = "rounded-xl2 border border-[#e8e8ed] bg-white p-5";

export function FanoutStudioView(props: FanoutStudioViewProps) {
  const {
    raw, onRawChange, extracting, onExtract, brief, onBriefChange,
    sellingPointsInput, onSellingPointsInput, mode, onModeChange, dimension, onDimensionChange,
    count, countInput, onCountInputChange, onQuickCount, countError,
    dedup, onDedupChange, generating, canGenerate, onGenerate,
    variants, avgSimilarity, delivered, requested, partialFailure, stoppedByBalance, error, onCopy, onExport,
  } = props;

  return (
    <section className="space-y-4">
      {/* 1. 原文输入 */}
      <div className={CARD}>
        <label className="mb-2 block text-sm font-semibold text-[#1d1d1f]">原始文案</label>
        <textarea
          value={raw} onChange={(e) => onRawChange(e.target.value)} rows={5}
          placeholder="粘贴一份原始文案，AI 会先理解产品/人群/卖点/风格/场景"
          className="w-full resize-y p-3"
        />
        <button
          onClick={onExtract} disabled={extracting || raw.trim().length === 0}
          className="btn-primary mt-3 inline-flex items-center gap-1 disabled:opacity-40 "
        >
          {extracting ? <Icon icon="mdi:loading" className="animate-spin" /> : <Icon icon="mdi:magic-staff" />}
          AI 理解原文
        </button>
      </div>

      {/* 2. 可编辑 brief */}
      {brief && (
        <div className={`${CARD} grid gap-3 sm:grid-cols-2`}>
          <Field label="产品" value={brief.product} onChange={(v) => onBriefChange({ product: v })} />
          <Field label="人群" value={brief.audience} onChange={(v) => onBriefChange({ audience: v })} />
          <Field label="风格" value={brief.style} onChange={(v) => onBriefChange({ style: v })} />
          <Field label="场景" value={brief.scene} onChange={(v) => onBriefChange({ scene: v })} />
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-semibold text-[#6e6e73]">卖点（每行一个）</label>
            <textarea
              value={sellingPointsInput} onChange={(e) => onSellingPointsInput(e.target.value)} rows={3}
              className="w-full resize-y p-2"
            />
          </div>
        </div>
      )}

      {/* 3. 裂变配置 */}
      {brief && (
        <div className={`${CARD} space-y-4`}>
          <OptionRow label="裂变模式">
            {MODE_OPTIONS.map((o) => (
              <Chip key={o.value} active={mode === o.value} onClick={() => onModeChange(o.value)} title={o.hint}>{o.label}</Chip>
            ))}
          </OptionRow>
          {mode === "enum" && (
            <OptionRow label="维度">
              {ENUM_DIMENSION_OPTIONS.map((o) => (
                <Chip key={o.value} active={dimension === o.value} onClick={() => onDimensionChange(o.value)}>{o.label}</Chip>
              ))}
            </OptionRow>
          )}
          <div>
            <OptionRow label="数量（可自定义 1-100）">
              {FANOUT_COUNT_OPTIONS.map((o) => (
                <Chip key={o.value} active={count === o.value} onClick={() => onQuickCount(o.value)}>{o.label}</Chip>
              ))}
              <div className="flex items-center gap-1">
                <input
                  type="text" inputMode="numeric" aria-label="自定义条数"
                  value={countInput} onChange={(e) => onCountInputChange(e.target.value)}
                  placeholder="1-100"
                  className={`w-20 p-2 text-center ${countError ? "border-[#d4380d] focus:border-[#d4380d]" : ""}`}
                />
                <span className="text-xs text-[#8a8a8f]">条</span>
              </div>
            </OptionRow>
            {countError && <p className="mt-1.5 text-xs text-[#d4380d]">{countError}</p>}
          </div>
          {dedupAvailable(mode) && (
            <label className="flex items-center gap-2 text-sm text-[#1d1d1f]">
              <input type="checkbox" checked={dedup} onChange={(e) => onDedupChange(e.target.checked)} className="h-4 w-4 accent-brand" />
              开启降重（控制相似度）
            </label>
          )}
          <button
            onClick={onGenerate} disabled={generating || !canGenerate}
            className="btn-primary inline-flex items-center gap-1 disabled:opacity-40 "
          >
            {generating ? <Icon icon="mdi:loading" className="animate-spin" /> : <Icon icon="mdi:shape-plus" />}
            开始裂变
          </button>
        </div>
      )}

      {error && <p className="rounded-[10px] bg-[#fff1f0] px-4 py-2 text-sm text-[#d4380d]">{error}</p>}

      {/* 4. 结果 */}
      {variants.length > 0 && (
        <div className={CARD}>
          <div className="mb-3 flex items-center justify-between text-sm text-[#6e6e73]">
            <span>
              已生成 {delivered}/{requested} 条
              {avgSimilarity > 0 && <> · 平均相似度 {averageSimilarityLabel(avgSimilarity)}</>}
              {partialFailure && <span className="text-[#d4380d]"> · 部分批次失败</span>}
              {stoppedByBalance && <span className="text-[#d4380d]"> · 余额不足已停止</span>}
            </span>
            <button onClick={onExport} className="inline-flex items-center gap-1 rounded-full border border-[#e8e8ed] px-3 py-1 text-xs font-semibold text-[#1d1d1f] transition ">
              <Icon icon="mdi:download" /> 导出
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {variants.map((v) => (
              <div key={v.id} className="flex flex-col rounded-[10px] border border-[#e8e8ed] p-3 transition ">
                <div className="mb-1 flex items-center justify-between">
                  <span className="badge bg-brand-soft text-brand-ink">{v.label}</span>
                  {v.highSimilarity && <span className="text-xs text-[#d4380d]">高相似</span>}
                </div>
                <p className="flex-1 whitespace-pre-wrap text-sm text-[#1d1d1f]">{v.text}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-[#8a8a8f]">
                  <span>{v.charCount} 字</span>
                  <button onClick={() => onCopy(v.text)} className="inline-flex items-center gap-1 transition ">
                    <Icon icon="mdi:content-copy" /> 复制
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-[#6e6e73]">{props.label}</label>
      <input value={props.value} onChange={(e) => props.onChange(e.target.value)} className="w-full p-2" />
    </div>
  );
}
function OptionRow(props: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="mb-2 block text-xs font-semibold text-[#6e6e73]">{props.label}</span>
      <div className="flex flex-wrap items-center gap-2">{props.children}</div>
    </div>
  );
}
function Chip(props: { active: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      onClick={props.onClick} title={props.title}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${props.active ? "bg-brand text-white" : "border border-[#d2d2d7] text-[#1d1d1f] "}`}
    >
      {props.children}
    </button>
  );
}
