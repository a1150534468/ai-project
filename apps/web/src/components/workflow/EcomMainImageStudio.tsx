import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { useAuthGate } from "../../app/authGate";
import { InAppSelect } from "../ui/InAppSelect";
import { cx } from "../ui/cx";
import * as api from "../../workflowEcomMainApi";
import type { EcomMainJob, EcomMainRatio, EcomMainResolution, EcomMainStyleId } from "../../workflowEcomMainApi";
import { IMAGE_MODEL_OPTIONS, isImageModel, type ImageModel } from "../../workflowState";
import { DownloadOverlayButton } from "./DownloadOverlayButton";
import { SubmitBar } from "./SubmitBar";
import { SETTINGS_TEXTAREA, SettingsField, SettingsGroup } from "./SettingsSlots";
import { usePanelVisibility } from "./panelVisibility";
import { WF_PANEL, WF_PANEL_HEAD, wfShell, WF_WORKSPACE } from "./workflowLayout";
import {
  ECOM_MAIN_COUNT_OPTIONS,
  ECOM_MAIN_RATIO_OPTIONS,
  ECOM_MAIN_RESOLUTION_OPTIONS,
  ECOM_MAIN_STYLE_OPTIONS,
  ECOM_MAIN_TEXT_OPTIONS,
  buildCreateMainPayload,
  coerceEcomMainResolution,
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
  readonly client?: Pick<typeof api, "getCurrentEcomMainJob" | "createEcomMainJob" | "redrawEcomMainImage">;
}

const DEFAULT_CLIENT = api;

export function EcomMainImageStudio({
  token,
  shared,
  onBalanceRefresh,
  onDownloadImage,
  loadJob,
  onActivity,
  controlsHeader,
  historyFooter,
  client = DEFAULT_CLIENT,
}: EcomMainImageStudioProps) {
  const { requireAuth } = useAuthGate();
  const [ratio, setRatio] = useState<EcomMainRatio>("1:1");
  const [resolution, setResolution] = useState<EcomMainResolution>("1K");
  const [model, setModel] = useState<ImageModel>(IMAGE_MODEL_OPTIONS[0].value);
  const [style, setStyle] = useState<EcomMainStyleId>("amazon_clean");
  const [customStyle, setCustomStyle] = useState("");
  const [withText, setWithText] = useState(true);
  const [count, setCount] = useState(4);
  const [job, setJob] = useState<EcomMainJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [redrawingIndexes, setRedrawingIndexes] = useState<readonly number[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        setJob((await client.getCurrentEcomMainJob(token)).job);
      } catch {
        /* 忽略：无历史任务 */
      }
    })();
  }, [client, token]);

  useEffect(() => {
    if (loadJob) {
      setJob(loadJob);
      clearFeedback();
    }
  }, [loadJob]);

  const busy = isSubmitting || redrawingIndexes.length > 0 || isMainJobGenerating(job?.stage);
  const clearFeedback = () => {
    setError("");
    setNotice("");
  };

  const handleGenerate = () => {
    if (!requireAuth()) return;
    if (!shared.productName.trim()) {
      setError("请先填写商品名称");
      return;
    }
    if (style === "custom" && !customStyle.trim()) {
      setError("请填写自定义风格描述");
      return;
    }
    clearFeedback();
    setIsSubmitting(true);
    void (async () => {
      try {
        const payload = buildCreateMainPayload({
          platformId: shared.platformId,
          ratio,
          resolution,
          model,
          style,
          customStyle,
          withText,
          productName: shared.productName,
          category: shared.category,
          sellingPointsInput: shared.sellingPointsInput,
          extra: shared.extra,
          referenceAssetIds: shared.referenceAssetIds,
          count,
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
    if (!requireAuth()) return;
    if (!job) return;
    clearFeedback();
    setRedrawingIndexes((current) => (current.includes(index) ? current : [...current, index]));
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

  const panels = usePanelVisibility();

  return (
    <section className={cx(wfShell(panels.left, panels.right), "wf-studio-in")}>
      {/* 左栏由顶栏「面板开关」控制：收起的那一列连缝一起从栅格里消失，工作区直接吃掉那份宽度。 */}
      {panels.left && (
        <aside className={cx(WF_PANEL, "xl:h-full")}>
        <div className={WF_PANEL_HEAD}>
          <h2 className="min-w-0 truncate text-sm font-semibold text-ink">商品主图设置</h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
          {controlsHeader}

          <SettingsGroup title="主图参数" className="mt-5">
            <SettingsField label="模型">
              <InAppSelect
                icon="mdi:creation-outline"
                label="模型"
                value={model}
                options={IMAGE_MODEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(v) => {
                  if (!isImageModel(v)) return;
                  setModel(v);
                  setResolution((current) => coerceEcomMainResolution(v, current, ratio));
                  clearFeedback();
                }}
              />
            </SettingsField>
            <SettingsField label="图片比例">
              <InAppSelect
                icon="mdi:crop"
                label="图片比例"
                value={ratio}
                options={ECOM_MAIN_RATIO_OPTIONS}
                onChange={(v) => {
                  const nextRatio = v as EcomMainRatio;
                  setRatio(nextRatio);
                  setResolution((current) => coerceEcomMainResolution(model, current, nextRatio));
                  clearFeedback();
                }}
              />
            </SettingsField>
            <SettingsField label="清晰度">
              <InAppSelect
                icon="mdi:high-definition"
                label="清晰度"
                value={resolution}
                options={ECOM_MAIN_RESOLUTION_OPTIONS.filter(
                  (option) => !isEcomMainResolutionBlocked(model, option.value, ratio),
                )}
                onChange={(v) => {
                  setResolution(v as EcomMainResolution);
                  clearFeedback();
                }}
              />
            </SettingsField>
            <SettingsField label="做图风格">
              <InAppSelect
                icon="mdi:palette-outline"
                label="做图风格"
                value={style}
                options={ECOM_MAIN_STYLE_OPTIONS}
                onChange={(v) => {
                  setStyle(v as EcomMainStyleId);
                  clearFeedback();
                }}
              />
            </SettingsField>
            {style === "custom" && (
              <SettingsField label="自定义风格描述">
                <textarea
                  value={customStyle}
                  onChange={(e) => {
                    setCustomStyle(e.target.value);
                    clearFeedback();
                  }}
                  placeholder="例如：赛博朋克霓虹夜景、暖调日系胶片"
                  className={cx(SETTINGS_TEXTAREA, "min-h-[72px]")}
                />
              </SettingsField>
            )}
            <SettingsField label="画面文字">
              <InAppSelect
                icon="mdi:format-text"
                label="画面文字"
                value={withText ? "with" : "no"}
                options={ECOM_MAIN_TEXT_OPTIONS}
                onChange={(v) => {
                  setWithText(v === "with");
                  clearFeedback();
                }}
              />
            </SettingsField>
            <SettingsField label="生成张数">
              <InAppSelect
                icon="mdi:numeric"
                label="生成张数"
                value={String(count)}
                options={ECOM_MAIN_COUNT_OPTIONS}
                onChange={(v) => {
                  setCount(Number(v));
                  clearFeedback();
                }}
              />
            </SettingsField>
          </SettingsGroup>

          {(error || notice) && (
            <p
              className={`mt-4 rounded-[10px] px-3 py-2 text-sm ${error ? "bg-danger/10 text-danger-ink" : "bg-brand-soft text-brand-ink"}`}
            >
              {error || notice}
            </p>
          )}
        </div>

        <SubmitBar
          submitLabel="生成主图"
          submitIcon="mdi:image-plus-outline"
          submitDisabled={busy}
          busy={isSubmitting}
          busyLabel={`正在生成 ${count} 张...`}
          onSubmit={handleGenerate}
        />
      </aside>
      )}

      <main className={WF_WORKSPACE}>
        <div className={WF_PANEL_HEAD}>
          <p className="truncate text-sm font-semibold text-ink">
            图组预览 {job && !isSubmitting ? `(${job.images.length} 张)` : ""}
          </p>
          {isSubmitting && (
            <span role="status" className="inline-flex items-center gap-2 text-xs font-semibold text-brand-ink">
              <Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />
              正在生成
            </span>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {isSubmitting && (
            <div className="flex items-center gap-2 rounded-[10px] bg-brand-soft px-3 py-2 text-sm font-medium text-brand-ink">
              <Icon icon="mdi:loading" className="animate-spin text-base" aria-hidden />
              正在按张生成 {count} 张主图，请稍候...（离开页面会中断本次生成）
            </div>
          )}
          {!job && !isSubmitting && (
            <div className="grid min-h-[340px] place-items-center rounded-[10px] border border-dashed border-hairline bg-surface px-6 text-center">
              <div>
                <Icon icon="mdi:image-plus-outline" className="mx-auto mb-3 text-4xl text-ink-tertiary" aria-hidden />
                <p className="text-sm font-semibold text-ink-secondary">填写左侧产品资料后开始生成</p>
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {isSubmitting
              ? Array.from({ length: count }).map((_, skeletonIndex) => (
                  <article
                    key={`skeleton-${skeletonIndex}`}
                    className="overflow-hidden rounded-[10px] border border-hairline-subtle"
                  >
                    <div className="relative grid aspect-square place-items-center overflow-hidden bg-surface-muted">
                      <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-surface-muted via-surface-subtle to-surface-muted" />
                      <Icon
                        icon="mdi:image-outline"
                        className="relative animate-pulse text-3xl text-ink-tertiary"
                        aria-hidden
                      />
                    </div>
                    <div className="grid gap-2 p-3">
                      <div className="h-3 w-1/3 animate-pulse rounded bg-surface-muted" />
                      <div className="h-3 w-full animate-pulse rounded bg-surface-muted" />
                      <div className="h-3 w-2/3 animate-pulse rounded bg-surface-muted" />
                    </div>
                  </article>
                ))
              : job?.images.map((image) => (
                  <article key={image.index} className="overflow-hidden rounded-[10px] border border-hairline-subtle">
                    <div className="group relative grid aspect-square place-items-center bg-surface-muted">
                      {image.originalUrl ? (
                        <img
                          src={image.thumbnailUrl || image.originalUrl}
                          alt={`主图 ${image.index + 1}`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-xs text-ink-tertiary">
                          {image.status === "failed" ? "生成失败" : "待生成"}
                        </span>
                      )}
                      {image.originalUrl && onDownloadImage && (
                        <DownloadOverlayButton onClick={() => onDownloadImage(image.originalUrl!)} />
                      )}
                      {redrawingIndexes.includes(image.index) && (
                        <div className="absolute inset-0 grid place-items-center bg-surface/70">
                          <Icon icon="mdi:loading" className="animate-spin text-2xl text-brand" aria-hidden />
                        </div>
                      )}
                    </div>
                    <div className="grid gap-2 p-3">
                      <p className="text-sm font-semibold text-ink break-words">
                        {image.index === 0 ? "商品图 · 主图" : `商品图 ${image.index + 1}`}
                      </p>
                      <p className="text-xs leading-5 text-ink-secondary break-words">
                        <span className="font-semibold">主题：</span>
                        {image.theme}
                      </p>
                      <p className="text-xs leading-5 text-ink-secondary break-words">
                        <span className="font-semibold">画面要求：</span>
                        {image.sceneRequirement}
                      </p>
                      <p className="text-xs leading-5 text-ink-secondary break-words">
                        <span className="font-semibold">文案要求：</span>
                        {image.copyRequirement}
                      </p>
                      {image.status === "failed" && (
                        <RippleButton
                          type="button"
                          onClick={() => handleRedraw(image.index)}
                          disabled={busy}
                          className="h-9 rounded-[10px] border border-hairline text-xs font-semibold text-brand-ink disabled:text-ink-tertiary"
                        >
                          {redrawingIndexes.includes(image.index) ? "重绘中…" : "重绘这张"}
                        </RippleButton>
                      )}
                    </div>
                  </article>
                ))}
          </div>
        </div>
      </main>

      {/* 历史从「工作区底部的横条」搬到右栏（统一规范 v2：左=设置、中=工作区、右=历史）。 */}
      {panels.right && historyFooter}
    </section>
  );
}
