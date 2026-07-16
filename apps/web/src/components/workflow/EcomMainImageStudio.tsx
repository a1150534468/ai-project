import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { InAppSelect } from "../agent-teams/InAppSelect";
import * as api from "../../workflowEcomMainApi";
import type { EcomMainJob, EcomMainRatio, EcomMainResolution, EcomMainStyleId } from "../../workflowEcomMainApi";
import {
  ECOM_MAIN_COUNT_OPTIONS,
  ECOM_MAIN_RATIO_OPTIONS,
  ECOM_MAIN_RESOLUTION_OPTIONS,
  ECOM_MAIN_STYLE_OPTIONS,
  ECOM_MAIN_TEXT_OPTIONS,
  buildCreateMainPayload,
  estimateMainPointCost,
  formatEcomMainError,
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
  readonly client?: Pick<typeof api, "getEcomMainPricing" | "getCurrentEcomMainJob" | "createEcomMainJob" | "redrawEcomMainImage">;
}

const DEFAULT_CLIENT = api;

export function EcomMainImageStudio({ token, shared, onBalanceRefresh, onDownloadImage, loadJob, onActivity, client = DEFAULT_CLIENT }: EcomMainImageStudioProps) {
  const [ratio, setRatio] = useState<EcomMainRatio>("1:1");
  const [resolution, setResolution] = useState<EcomMainResolution>("1K");
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

  useEffect(() => {
    void (async () => {
      try { setPricing(await client.getEcomMainPricing(token)); } catch { setPricing(null); }
    })();
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
          platformId: shared.platformId, ratio, resolution, style, customStyle, withText,
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
    <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
      <aside className="rounded-[14px] border border-[#d2d2d7] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <h3 className="text-[16px] font-semibold text-[#1d1d1f]">主图设置</h3>
        <div className="mt-4 grid gap-3">
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            图片比例
            <InAppSelect icon="mdi:crop" label="图片比例" value={ratio} options={ECOM_MAIN_RATIO_OPTIONS} onChange={(v) => { setRatio(v as EcomMainRatio); clearFeedback(); }} />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            清晰度
            <InAppSelect icon="mdi:high-definition" label="清晰度" value={resolution} options={ECOM_MAIN_RESOLUTION_OPTIONS} onChange={(v) => { setResolution(v as EcomMainResolution); clearFeedback(); }} />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            做图风格
            <InAppSelect icon="mdi:palette-outline" label="做图风格" value={style} options={ECOM_MAIN_STYLE_OPTIONS} onChange={(v) => { setStyle(v as EcomMainStyleId); clearFeedback(); }} />
          </div>
          {style === "custom" && (
            <label className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
              自定义风格描述
              <textarea value={customStyle} onChange={(e) => { setCustomStyle(e.target.value); clearFeedback(); }} placeholder="例如：赛博朋克霓虹夜景、暖调日系胶片" className="min-h-[72px] rounded-[10px] border border-[#d2d2d7] p-3 text-sm leading-6 text-[#1d1d1f]" />
            </label>
          )}
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            画面文字
            <InAppSelect icon="mdi:format-text" label="画面文字" value={withText ? "with" : "no"} options={ECOM_MAIN_TEXT_OPTIONS} onChange={(v) => { setWithText(v === "with"); clearFeedback(); }} />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            生成张数
            <InAppSelect icon="mdi:numeric" label="生成张数" value={String(count)} options={ECOM_MAIN_COUNT_OPTIONS} onChange={(v) => { setCount(Number(v)); clearFeedback(); }} />
          </div>
        </div>

        <div className="mt-4 rounded-[10px] border border-[#e8e8ed] bg-[#f7faf9] px-3 py-2 text-sm text-[#6e6e73]">
          预计消耗 {estimated === null ? "—" : `${estimated} 算力点`}（{perImageRate === null ? "—" : `${perImageRate} 点/张`} × {count} 张）
        </div>

        <RippleButton type="button" onClick={handleGenerate} disabled={busy} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-[#00b8a9] text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#8edbd4]">
          {isSubmitting ? <><Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />正在生成 {count} 张…</> : "生成主图"}
        </RippleButton>

        {(error || notice) && (
          <p className={`mt-4 rounded-[10px] px-3 py-2 text-sm ${error ? "bg-red-50 text-red-700" : "bg-[#eaf8f6] text-[#00867c]"}`}>{error || notice}</p>
        )}
      </aside>

      <div className="min-w-0 rounded-[14px] border border-[#d2d2d7] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <h3 className="text-[16px] font-semibold text-[#1d1d1f]">图组预览 {job && !isSubmitting ? `(${job.images.length} 张)` : ""}</h3>
        {isSubmitting && (
          <div className="mt-3 flex items-center gap-2 rounded-[10px] bg-[#eaf8f6] px-3 py-2 text-sm font-medium text-[#00867c]">
            <Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />
            正在按张生成 {count} 张主图，请稍候…（离开页面会中断本次生成）
          </div>
        )}
        {!job && !isSubmitting && <p className="mt-3 text-sm text-[#8a8a8f]">填写产品资料后点「生成主图」，将按张出图并展示每张的主题/画面/文案要求。</p>}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {isSubmitting
            ? Array.from({ length: count }).map((_, skeletonIndex) => (
                <article key={`skeleton-${skeletonIndex}`} className="overflow-hidden rounded-[12px] border border-[#e8e8ed]">
                  <div className="relative grid aspect-square place-items-center overflow-hidden bg-[#eef1f3]">
                    <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-[#eef1f3] via-[#f7f9fa] to-[#eef1f3]" />
                    <Icon icon="mdi:image-outline" className="relative animate-pulse text-3xl text-[#c4ccd1]" aria-hidden />
                  </div>
                  <div className="grid gap-2 p-3">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-[#eef1f3]" />
                    <div className="h-3 w-full animate-pulse rounded bg-[#eef1f3]" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-[#eef1f3]" />
                  </div>
                </article>
              ))
            : job?.images.map((image) => (
                <article key={image.index} className="overflow-hidden rounded-[12px] border border-[#e8e8ed]">
                  <div className="group relative grid aspect-square place-items-center bg-[#f5f5f7]">
                    {image.originalUrl
                      ? <img src={image.thumbnailUrl || image.originalUrl} alt={`主图 ${image.index + 1}`} className="h-full w-full object-cover" />
                      : <span className="text-xs text-[#8a8a8f]">{image.status === "failed" ? "生成失败" : "待生成"}</span>}
                    {image.originalUrl && onDownloadImage && (
                      <button type="button" onClick={() => onDownloadImage(image.originalUrl!)}
                        className="absolute right-2 top-2 flex items-center gap-1 rounded-[8px] bg-black/55 px-2 py-1 text-xs font-semibold text-white opacity-0 transition group-hover:opacity-100">
                        <Icon icon="mdi:download" aria-hidden />下载原图
                      </button>
                    )}
                    {redrawingIndexes.includes(image.index) && (
                      <div className="absolute inset-0 grid place-items-center bg-white/70">
                        <Icon icon="mdi:loading" className="animate-spin text-2xl text-[#00b8a9]" aria-hidden />
                      </div>
                    )}
                  </div>
                  <div className="grid gap-2 p-3">
                    <p className="text-sm font-semibold text-[#1d1d1f] break-words">{image.index === 0 ? "商品图 · 主图" : `商品图 ${image.index + 1}`}</p>
                    <p className="text-xs leading-5 text-[#6e6e73] break-words"><span className="font-semibold">主题：</span>{image.theme}</p>
                    <p className="text-xs leading-5 text-[#6e6e73] break-words"><span className="font-semibold">画面要求：</span>{image.sceneRequirement}</p>
                    <p className="text-xs leading-5 text-[#6e6e73] break-words"><span className="font-semibold">文案要求：</span>{image.copyRequirement}</p>
                    {image.status === "failed" && (
                      <RippleButton type="button" onClick={() => handleRedraw(image.index)} disabled={busy} className="h-9 rounded-[8px] border border-[#d2d2d7] text-xs font-semibold text-[#00867c] disabled:text-[#8a8a8f]">
                        {redrawingIndexes.includes(image.index) ? "重绘中…" : "重绘这张"}
                      </RippleButton>
                    )}
                  </div>
                </article>
              ))}
        </div>
      </div>
    </section>
  );
}
