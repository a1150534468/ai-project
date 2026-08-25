import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { InAppSelect } from "../agent-teams/InAppSelect";
import * as api from "../../workflowEcomMainApi";
import type { EcomMainJob, EcomMainRatio, EcomMainResolution, EcomMainStyleId } from "../../workflowEcomMainApi";
import { IMAGE_MODEL_OPTIONS, isImageModel, type ImageModel } from "../../workflowState";
import { DownloadOverlayButton } from "./DownloadOverlayButton";
import { SubmitCostBar } from "./SubmitCostBar";
import {
  ECOM_MAIN_COUNT_OPTIONS,
  ECOM_MAIN_RATIO_OPTIONS,
  ECOM_MAIN_RESOLUTION_OPTIONS,
  ECOM_MAIN_STYLE_OPTIONS,
  ECOM_MAIN_TEXT_OPTIONS,
  buildCreateMainPayload,
  coerceEcomMainResolution,
  estimateMainPointCost,
  formatEcomMainError,
  isEcomMainResolutionBlocked,
  isMainJobGenerating,
} from "./ecomMainImageModel";

export interface EcomMainSharedProduct {
  readonly platformId: string;
  readonly productName: string;
  readonly category: string;
  readonly sellingPointsInput: string;
  readonly extra: string;
  readonly referenceAssetIds: readonly string[];
}

interface EcomMainImageStudioProps {
  readonly token: string;
  readonly shared: EcomMainSharedProduct;
  readonly onBalanceRefresh?: () => void;
  readonly onDownloadImage?: (url: string) => void;
  readonly loadJob?: EcomMainJob | null;
  readonly onActivity?: () => void;
  readonly controlsHeader?: ReactNode;
  readonly historyFooter?: ReactNode;
  readonly client?: Pick<typeof api, "getEcomMainPricing" | "getCurrentEcomMainJob" | "createEcomMainJob" | "redrawEcomMainImage">;
}

const DEFAULT_CLIENT = api;

export function EcomMainImageStudio({ token, shared, onBalanceRefresh, onDownloadImage, loadJob, onActivity, controlsHeader, historyFooter, client = DEFAULT_CLIENT }: EcomMainImageStudioProps) {
  const [ratio, setRatio] = useState<EcomMainRatio>("1:1");
  const [resolution, setResolution] = useState<EcomMainResolution>("1K");
  const [model, setModel] = useState<ImageModel>(IMAGE_MODEL_OPTIONS[0].value);
  const [style, setStyle] = useState<EcomMainStyleId>("amazon_clean");
  const [customStyle, setCustomStyle] = useState("");
  const [withText, setWithText] = useState(true);
  const [count, setCount] = useState(4);
  const [pricing, setPricing] = useState<api.EcomMainPricing | null>(null);
  const [job, setJob] = useState<EcomMainJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [redrawingIndexes, setRedrawingIndexes] = useState<readonly number[]>([]);
  const pricingRequestSeq = useRef(0);

  useEffect(() => {
    // 带上模型查询计价，预估与实际扣费保持同一条价格解析链路；
    // 请求计数器丢弃乱序返回的旧响应，避免连续切模型后显示上一次的价格。
    const seq = pricingRequestSeq.current + 1;
    pricingRequestSeq.current = seq;
    void (async () => {
      try {
        const next = await client.getEcomMainPricing(token, model);
        if (seq === pricingRequestSeq.current) setPricing(next);
      } catch {
        if (seq === pricingRequestSeq.current) setPricing(null);
      }
    })();
  }, [client, token, model]);

  useEffect(() => {
    void (async () => {
      try { setJob((await client.getCurrentEcomMainJob(token)).job); } catch { /* 忽略：无历史任务 */ }
    })();
  }, [client, token]);

  useEffect(() => {
    if (loadJob) {
      setJob(loadJob);
      clearFeedback();
    }
  }, [loadJob]);

  const perImageRate = pricing ? pricing[resolution]?.rate ?? null : null;
  const estimated = useMemo(() => estimateMainPointCost(perImageRate, count), [perImageRate, count]);
  const busy = isSubmitting || redrawingIndexes.length > 0 || isMainJobGenerating(job?.stage);
  const clearFeedback = () => { setError(""); setNotice(""); };

  const handleGenerate = () => {
    if (!shared.productName.trim()) { setError("请先填写商品名称"); return; }
    if (style === "custom" && !customStyle.trim()) { setError("请填写自定义风格描述"); return; }
    clearFeedback();
    setIsSubmitting(true);
    void (async () => {
      try {
        const payload = buildCreateMainPayload({
          platformId: shared.platformId, ratio, resolution, model, style, customStyle, withText,
          productName: shared.productName, category: shared.category, sellingPointsInput: shared.sellingPointsInput,
          extra: shared.extra, referenceAssetIds: shared.referenceAssetIds, count,
        });
        const result = await client.createEcomMainJob(token, payload);
        setJob(result.job);
        if (result.job.stage === "partial") {
          setError(`部分主图生成失败，可对失败图重绘${result.job.error ? `：${result.job.error}` : ""}`);
        } else {
          setNotice("主图已生成");
        }
        onActivity?.();
        onBalanceRefresh?.();
      } catch (submitError) {
        setError(formatEcomMainError(submitError, "主图生成失败"));
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  const handleRedraw = (index: number) => {
    if (!job) return;
    clearFeedback();
    setRedrawingIndexes((current) => current.includes(index) ? current : [...current, index]);
    void (async () => {
      try {
        const result = await client.redrawEcomMainImage(token, job.id, index);
        setJob(result.job);
        setNotice(`第 ${index + 1} 张已重绘`);
        onActivity?.();
        onBalanceRefresh?.();
      } catch (redrawError) {
        setError(formatEcomMainError(redrawError, "重绘失败"));
      } finally {
        setRedrawingIndexes((current) => current.filter((item) => item !== index));
      }
    })();
  };

  return (
    <section className="grid min-h-0 bg-white xl:h-full xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
      <aside className="flex h-[calc(100dvh-19rem)] min-h-[460px] max-h-[680px] flex-col border-b border-[#e5e7eb] bg-white xl:h-full xl:min-h-0 xl:max-h-none xl:border-b-0 xl:border-r">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
          {controlsHeader}
          <div className="pt-5">
            <p className="text-xs font-semibold text-ink-secondary">生成配置</p>
            <h3 className="mt-1 text-base font-semibold text-ink">主图设置</h3>
          </div>
          <div className="mt-4 grid gap-3">
          <div className="grid gap-2 text-sm font-semibold text-ink">
            模型
            <InAppSelect icon="mdi:creation-outline" label="模型" value={model} options={IMAGE_MODEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} onChange={(v) => {
              if (!isImageModel(v)) return;
              setModel(v);
              setResolution((current) => coerceEcomMainResolution(v, current, ratio));
              clearFeedback();
            }} />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink">
            图片比例
            <InAppSelect icon="mdi:crop" label="图片比例" value={ratio} options={ECOM_MAIN_RATIO_OPTIONS} onChange={(v) => {
              const nextRatio = v as EcomMainRatio;
              setRatio(nextRatio);
              setResolution((current) => coerceEcomMainResolution(model, current, nextRatio));
              clearFeedback();
            }} />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink">
            清晰度
            <InAppSelect icon="mdi:high-definition" label="清晰度" value={resolution} options={ECOM_MAIN_RESOLUTION_OPTIONS.filter((option) => !isEcomMainResolutionBlocked(model, option.value, ratio))} onChange={(v) => { setResolution(v as EcomMainResolution); clearFeedback(); }} />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink">
            做图风格
            <InAppSelect icon="mdi:palette-outline" label="做图风格" value={style} options={ECOM_MAIN_STYLE_OPTIONS} onChange={(v) => { setStyle(v as EcomMainStyleId); clearFeedback(); }} />
          </div>
          {style === "custom" && (
            <label className="grid gap-2 text-sm font-semibold text-ink">
              自定义风格描述
              <textarea value={customStyle} onChange={(e) => { setCustomStyle(e.target.value); clearFeedback(); }} placeholder="例如：赛博朋克霓虹夜景、暖调日系胶片" className="min-h-[72px] rounded-lg border border-hairline p-3 text-sm leading-6 text-ink" />
            </label>
          )}
          <div className="grid gap-2 text-sm font-semibold text-ink">
            画面文字
            <InAppSelect icon="mdi:format-text" label="画面文字" value={withText ? "with" : "no"} options={ECOM_MAIN_TEXT_OPTIONS} onChange={(v) => { setWithText(v === "with"); clearFeedback(); }} />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink">
            生成张数
            <InAppSelect icon="mdi:numeric" label="生成张数" value={String(count)} options={ECOM_MAIN_COUNT_OPTIONS} onChange={(v) => { setCount(Number(v)); clearFeedback(); }} />
          </div>
          </div>
          {(error || notice) && (
            <p className={`mt-4 rounded-lg px-3 py-2 text-sm ${error ? "bg-red-50 text-red-700" : "bg-brand-soft text-brand-ink"}`}>{error || notice}</p>
          )}
        </div>
        <SubmitCostBar
          estimatedPointCost={estimated}
          submitLabel="生成主图"
          submitIcon="mdi:image-plus-outline"
          submitDisabled={busy}
          busy={isSubmitting}
          busyLabel={`正在生成 ${count} 张...`}
          onSubmit={handleGenerate}
        />
      </aside>

      <div className="flex min-h-[420px] min-w-0 flex-col bg-white xl:h-full">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-xs font-semibold text-ink-secondary">当前结果</p><h3 className="mt-1 text-base font-semibold text-ink">图组预览 {job && !isSubmitting ? `(${job.images.length} 张)` : ""}</h3></div>
          {isSubmitting && <span role="status" className="inline-flex items-center gap-2 text-xs font-semibold text-brand-ink"><Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />正在生成</span>}
        </div>
        {isSubmitting && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-2 text-sm font-medium text-brand-ink">
            <Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />
            正在按张生成 {count} 张主图，请稍候...（离开页面会中断本次生成）
          </div>
        )}
        {!job && !isSubmitting && <div className="mt-4 grid min-h-[340px] place-items-center rounded-lg border border-dashed border-hairline bg-[#f7f8fa] px-6 text-center"><div><Icon icon="mdi:image-plus-outline" className="mx-auto mb-3 text-4xl text-ink-tertiary" aria-hidden /><p className="text-sm font-semibold text-ink-secondary">填写左侧产品资料后开始生成</p></div></div>}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {isSubmitting
            ? Array.from({ length: count }).map((_, skeletonIndex) => (
                <article key={`skeleton-${skeletonIndex}`} className="overflow-hidden rounded-[12px] border border-hairline-subtle">
                  <div className="relative grid aspect-square place-items-center overflow-hidden bg-[#f5f5f7]">
                    <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-[#f5f5f7] via-[#f7f8fa] to-[#f5f5f7]" />
                    <Icon icon="mdi:image-outline" className="relative animate-pulse text-3xl text-ink-tertiary" aria-hidden />
                  </div>
                  <div className="grid gap-2 p-3">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-[#f5f5f7]" />
                    <div className="h-3 w-full animate-pulse rounded bg-[#f5f5f7]" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-[#f5f5f7]" />
                  </div>
                </article>
              ))
            : job?.images.map((image) => (
                <article key={image.index} className="overflow-hidden rounded-[12px] border border-hairline-subtle">
                  <div className="group relative grid aspect-square place-items-center bg-[#f5f5f7]">
                    {image.originalUrl
                      ? <img src={image.thumbnailUrl || image.originalUrl} alt={`主图 ${image.index + 1}`} className="h-full w-full object-cover" />
                      : <span className="text-xs text-ink-tertiary">{image.status === "failed" ? "生成失败" : "待生成"}</span>}
                    {image.originalUrl && onDownloadImage && (
                      <DownloadOverlayButton onClick={() => onDownloadImage(image.originalUrl!)} />
                    )}
                    {redrawingIndexes.includes(image.index) && (
                      <div className="absolute inset-0 grid place-items-center bg-white/70">
                        <Icon icon="mdi:loading" className="animate-spin text-2xl text-brand" aria-hidden />
                      </div>
                    )}
                  </div>
                  <div className="grid gap-2 p-3">
                    <p className="text-sm font-semibold text-ink break-words">{image.index === 0 ? "商品图 · 主图" : `商品图 ${image.index + 1}`}</p>
                    <p className="text-xs leading-5 text-ink-secondary break-words"><span className="font-semibold">主题：</span>{image.theme}</p>
                    <p className="text-xs leading-5 text-ink-secondary break-words"><span className="font-semibold">画面要求：</span>{image.sceneRequirement}</p>
                    <p className="text-xs leading-5 text-ink-secondary break-words"><span className="font-semibold">文案要求：</span>{image.copyRequirement}</p>
                    {image.status === "failed" && (
                      <RippleButton type="button" onClick={() => handleRedraw(image.index)} disabled={busy} className="h-9 rounded-[8px] border border-hairline text-xs font-semibold text-brand-ink disabled:text-ink-tertiary">
                        {redrawingIndexes.includes(image.index) ? "重绘中…" : "重绘这张"}
                      </RippleButton>
                    )}
                  </div>
                </article>
              ))}
        </div>
        </div>
        {historyFooter}
      </div>
    </section>
  );
}
