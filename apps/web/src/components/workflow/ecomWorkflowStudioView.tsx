import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RippleButton, Stagger, StaggerItem, spring } from "../../motion";
import { InAppSelect } from "../agent-teams/InAppSelect";
import { IMAGE_MODEL_OPTIONS, isImageModel, type ImageModel } from "../../workflowState";
import type {
  WorkflowEcomImageAsset,
  WorkflowEcomPlatform,
  WorkflowEcomPlatformId,
  WorkflowEcomResolution,
  WorkflowEcomSegment,
  WorkflowEcomSegmentIndex,
  WorkflowEcomTemplate,
  WorkflowEcomTemplateId,
} from "../../workflowEcomApi";
import { ECOM_DEFAULT_MODEL_LABEL, ECOM_DEFAULT_MODEL_OPTION_VALUE, ECOM_MAX_REFERENCE_COUNT } from "./ecomWorkflowStudioModel";
import { DownloadOverlayButton } from "./DownloadOverlayButton";
import { SubmitCostBar } from "./SubmitCostBar";

export type EcomWorkflowStudioViewSegment = {
  readonly index: number;
  readonly segment: WorkflowEcomSegment | null;
};

export type EcomWorkflowStudioViewProps = {
  readonly platforms: readonly WorkflowEcomPlatform[];
  readonly templates: readonly WorkflowEcomTemplate[];
  readonly selectedPlatformId: WorkflowEcomPlatformId;
  readonly selectedTemplateId: WorkflowEcomTemplateId;
  readonly selectedResolution: WorkflowEcomResolution;
  /** null = 跟随服务端默认模型，下拉显示「默认模型」 */
  readonly selectedModel: ImageModel | null;
  readonly resolutionOptions: readonly { readonly value: WorkflowEcomResolution; readonly label: string; readonly size: string }[];
  readonly selectedSegmentCount: number;
  readonly segmentCountOptions: readonly { readonly value: string; readonly label: string }[];
  readonly masterPointCost: number | null;
  readonly segmentPointCost: number | null;
  readonly stitchPointCost: number | null;
  readonly productName: string;
  readonly category: string;
  readonly sellingPointsInput: string;
  readonly extra: string;
  readonly referenceAssets: readonly WorkflowEcomImageAsset[];
  readonly remoteReferenceCount: number;
  readonly isForeignPlatform: boolean;
  readonly stitchedPreviewDataUrl: string | null;
  readonly isBootstrapping: boolean;
  readonly isSubmittingMaster: boolean;
  readonly isRetryingMaster: boolean;
  readonly isConfirmingSegments: boolean;
  readonly isUploadingReference: boolean;
  readonly isStitchingPreview: boolean;
  readonly isSavingStitched: boolean;
  readonly isWorkflowMutating: boolean;
  readonly redrawingIndexes: readonly WorkflowEcomSegmentIndex[];
  readonly error: string;
  readonly notice: string;
  readonly workflowError: string | null;
  readonly stageLabel: string;
  readonly stageDescription: string;
  readonly isServerGenerating: boolean;
  readonly masterAsset: WorkflowEcomImageAsset | null;
  readonly stitchedAsset: WorkflowEcomImageAsset | null;
  readonly segmentCards: readonly EcomWorkflowStudioViewSegment[];
  readonly canStitch: boolean;
  readonly canSave: boolean;
  readonly hideProductForm?: boolean;
  readonly mainImages?: readonly { readonly assetId: string; readonly thumbnailUrl: string }[];
  readonly selectedMasterAssetId?: string | null;
  readonly controlsHeader?: ReactNode;
  readonly historyFooter?: ReactNode;
  readonly onDownloadImage?: (url: string) => void;
  readonly onPlatformChange: (value: WorkflowEcomPlatformId) => void;
  readonly onTemplateChange: (value: WorkflowEcomTemplateId) => void;
  readonly onModelChange: (value: ImageModel | null) => void;
  readonly onResolutionChange: (value: WorkflowEcomResolution) => void;
  readonly onSegmentCountChange: (value: string) => void;
  readonly onProductNameChange: (value: string) => void;
  readonly onCategoryChange: (value: string) => void;
  readonly onSellingPointsChange: (value: string) => void;
  readonly onExtraChange: (value: string) => void;
  readonly onReferenceUpload: (file: File) => void;
  readonly onCreateMaster: () => void;
  readonly onRetryMaster: () => void;
  readonly onConfirmSegments: () => void;
  readonly onRedrawSegment: (index: WorkflowEcomSegmentIndex) => void;
  readonly onStitchPreview: () => void;
  readonly onSaveStitched: () => void;
  readonly onSelectMainImage?: (assetId: string) => void;
  readonly onAdoptMaster?: () => void;
};

function formatStageLabel(stage: string, isServerGenerating: boolean): string {
  if (isServerGenerating) return "生成中";
  if (stage === "draft") return "未开始";
  if (stage === "master_ready") return "母版已完成";
  if (stage === "master_failed") return "母版失败";
  if (stage === "segments_ready") return "分段已完成";
  if (stage === "segment_failed") return "分段失败";
  if (stage === "stitched") return "长图已保存";
  if (stage === "stitch_failed") return "拼接失败";
  return stage;
}

export function EcomWorkflowStudioView(props: EcomWorkflowStudioViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handlePlatformChange = (value: string) => {
    const platform = props.platforms.find((item) => item.id === value);
    if (platform) props.onPlatformChange(platform.id);
  };
  const handleTemplateChange = (value: string) => {
    const template = props.templates.find((item) => item.id === value);
    if (template) props.onTemplateChange(template.id);
  };
  const handleResolutionChange = (value: string) => {
    const option = props.resolutionOptions.find((item) => item.value === value);
    if (option) props.onResolutionChange(option.value);
  };
  const handleSegmentCountChange = (value: string) => {
    props.onSegmentCountChange(value);
  };
  // 拼接免费：预估只含母版 + 分段
  const totalPointCost = props.masterPointCost === null && props.segmentPointCost === null
    ? null
    : (props.masterPointCost ?? 0) + (props.segmentPointCost ?? 0);
  const costDetail = totalPointCost === null
    ? "拼接免费"
    : `母版 ${props.masterPointCost ?? 0} + 分段 ${props.segmentPointCost ?? 0} · 拼接免费`;

  return (
    <section className="grid min-h-0 min-w-0 bg-white xl:h-full xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
      <aside className="flex h-[calc(100dvh-19rem)] min-h-[460px] max-h-[680px] flex-col border-b border-[#e5e7eb] bg-white xl:h-full xl:min-h-0 xl:max-h-none xl:border-b-0 xl:border-r">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 [scrollbar-gutter:stable] [scrollbar-width:thin] lg:px-5">
        {props.controlsHeader}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-ink-secondary">电商工作台</p>
            <h2 className="mt-1 text-base font-semibold text-ink">电商长图工作台</h2>
            <p className="mt-2 text-sm leading-6 text-ink-secondary">上传参考图、生成母版、确认分段并在浏览器完成白底纵向拼接。</p>
          </div>
          {props.isForeignPlatform && <span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-ink">海外平台文案</span>}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {!props.hideProductForm && (
            <div className="grid gap-2 text-sm font-semibold text-ink">
              平台
              <InAppSelect
                icon="mdi:storefront-outline"
                label="平台"
                value={props.selectedPlatformId}
                options={props.platforms.map((platform) => ({ value: platform.id, label: platform.name }))}
                onChange={handlePlatformChange}
              />
            </div>
          )}
          <div className="grid gap-2 text-sm font-semibold text-ink">
            模板
            <InAppSelect
              icon="mdi:file-document-outline"
              label="模板"
              value={props.selectedTemplateId}
              options={props.templates.map((template) => ({ value: template.id, label: template.name }))}
              onChange={handleTemplateChange}
            />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink sm:col-span-2">
            模型
            <InAppSelect
              icon="mdi:creation-outline"
              label="模型"
              value={props.selectedModel ?? ECOM_DEFAULT_MODEL_OPTION_VALUE}
              options={[
                { value: ECOM_DEFAULT_MODEL_OPTION_VALUE, label: ECOM_DEFAULT_MODEL_LABEL },
                ...IMAGE_MODEL_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
              ]}
              onChange={(value) => {
                if (value === ECOM_DEFAULT_MODEL_OPTION_VALUE) props.onModelChange(null);
                else if (isImageModel(value)) props.onModelChange(value);
              }}
            />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink sm:col-span-2">
            清晰度
            <InAppSelect
              icon="mdi:high-definition"
              label="清晰度"
              value={props.selectedResolution}
              options={props.resolutionOptions.map((option) => ({ value: option.value, label: `${option.label} · ${option.size}` }))}
              onChange={handleResolutionChange}
            />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-ink sm:col-span-2">
            分段数
            <InAppSelect
              icon="mdi:view-agenda-outline"
              label="分段数"
              value={String(props.selectedSegmentCount)}
              options={props.segmentCountOptions}
              onChange={handleSegmentCountChange}
            />
          </div>
        </div>

        {!props.hideProductForm && (
          <div className="mt-4 grid gap-3">
            <label className="grid gap-2 text-sm font-semibold text-ink">
              商品名称
              <input value={props.productName} onChange={(event) => props.onProductNameChange(event.target.value)} className="h-10 rounded-lg border border-hairline px-3 text-sm text-ink" />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-ink">
              商品类目
              <input value={props.category} onChange={(event) => props.onCategoryChange(event.target.value)} className="h-10 rounded-lg border border-hairline px-3 text-sm text-ink" />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-ink">
              卖点文案
              <textarea value={props.sellingPointsInput} onChange={(event) => props.onSellingPointsChange(event.target.value)} className="min-h-[108px] rounded-lg border border-hairline p-3 text-sm leading-6 text-ink" />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-ink">
              额外说明
              <textarea value={props.extra} onChange={(event) => props.onExtraChange(event.target.value)} className="min-h-[88px] rounded-lg border border-hairline p-3 text-sm leading-6 text-ink" />
            </label>
          </div>
        )}

        {!props.hideProductForm && (
          <div className="mt-4 rounded-lg border border-hairline-subtle bg-surface-subtle p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-ink">参考图 ({props.referenceAssets.length + props.remoteReferenceCount}/{ECOM_MAX_REFERENCE_COUNT})</p>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={props.isUploadingReference || props.referenceAssets.length + props.remoteReferenceCount >= ECOM_MAX_REFERENCE_COUNT} className="h-10 rounded-lg border border-dashed border-hairline px-3 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:text-ink-tertiary">
                {props.isUploadingReference ? "上传中" : "上传参考图"}
              </button>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onReferenceUpload(file);
              event.currentTarget.value = "";
            }} />
            <div className="mt-3 flex flex-wrap gap-2">
              {props.referenceAssets.map((asset) => (
                <img key={asset.id} src={asset.thumbnailUrl || asset.originalUrl} alt="参考图缩略图" className="h-16 w-16 rounded-lg border border-hairline object-cover" />
              ))}
              {props.remoteReferenceCount > 0 && <div className="grid h-16 min-w-16 place-items-center rounded-lg border border-dashed border-hairline px-3 text-center text-xs text-ink-secondary">已关联 {props.remoteReferenceCount} 张线上参考图</div>}
              {props.referenceAssets.length === 0 && props.remoteReferenceCount === 0 && <div className="rounded-lg border border-dashed border-hairline px-3 py-4 text-xs text-ink-tertiary">上传后会展示本地缩略图。</div>}
            </div>
          </div>
        )}

        {(props.error || props.notice || props.workflowError) && (
          <p className={`mt-4 rounded-lg px-3 py-2 text-sm ${props.error || props.workflowError ? "bg-red-50 text-red-700" : "bg-brand-soft text-brand-ink"}`}>
            {props.error || props.workflowError || props.notice}
          </p>
        )}

        <div className="mt-4 grid gap-2 text-sm font-semibold text-ink">
          从主图选母版
          {(props.mainImages?.length ?? 0) === 0 ? (
            <p className="rounded-lg border border-dashed border-hairline px-3 py-3 text-xs font-normal text-ink-tertiary">先在「商品主图」生成主图，即可选一张作为母版（省一次母版出图）。</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {props.mainImages!.map((img) => (
                  <button
                    key={img.assetId}
                    type="button"
                    onClick={() => props.onSelectMainImage?.(img.assetId)}
                    className={`h-16 w-16 overflow-hidden rounded-lg border-2 transition-colors ${props.selectedMasterAssetId === img.assetId ? "border-brand" : "border-transparent"}`}
                  >
                    <img src={img.thumbnailUrl} alt="主图缩略图" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
              <RippleButton
                type="button"
                onClick={() => props.onAdoptMaster?.()}
                disabled={!props.selectedMasterAssetId || props.isWorkflowMutating}
                className="h-10 rounded-lg bg-brand text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-brand/40"
              >
                用所选主图作为母版
              </RippleButton>
            </>
          )}
        </div>
        </div>

        <SubmitCostBar
          estimatedPointCost={totalPointCost}
          costDetail={costDetail}
          submitLabel="生成母版"
          actions={
            <div className="grid grid-cols-2 gap-2">
              <RippleButton type="button" onClick={props.onCreateMaster} disabled={props.isWorkflowMutating || props.isBootstrapping} className="h-11 rounded-lg bg-brand text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-brand/40">
                {props.isSubmittingMaster ? "生成中" : "生成母版"}
              </RippleButton>
              <RippleButton type="button" onClick={props.onRetryMaster} disabled={props.stageLabel === "draft" || props.isWorkflowMutating} className="h-11 rounded-lg border border-hairline text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-tertiary">
                {props.isRetryingMaster ? "重试中" : "重试主图"}
              </RippleButton>
              <RippleButton type="button" onClick={props.onConfirmSegments} disabled={props.stageLabel === "draft" || props.isWorkflowMutating} className="h-11 rounded-lg border border-hairline text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-tertiary">
                {props.isConfirmingSegments ? "确认中" : "确认分段"}
              </RippleButton>
              <RippleButton type="button" aria-label="浏览器拼接长图" onClick={props.onStitchPreview} disabled={!props.canStitch || props.isWorkflowMutating} className="h-11 rounded-lg border border-hairline text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-tertiary">
                {props.isStitchingPreview ? "拼接中" : "浏览器拼接长图"}
              </RippleButton>
            </div>
          }
        />
      </aside>

      <div className="flex min-h-[420px] min-w-0 flex-col bg-white xl:h-full">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-[#e5e7eb] bg-white px-4 py-5 lg:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-ink-secondary">任务阶段</p>
              <h3 className="mt-1 flex items-center gap-2 text-base font-semibold text-ink">
                母版与分段状态
                {props.isServerGenerating && <span aria-label="生成中" className="h-4 w-4 rounded-full border-2 border-brand/20 border-t-brand animate-spin" />}
              </h3>
              <p className="mt-2 text-sm leading-6 text-ink-secondary">{props.stageDescription}</p>
            </div>
            <span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-ink">{formatStageLabel(props.stageLabel, props.isServerGenerating)}</span>
          </div>
          {props.masterAsset && (
            <div className="group relative mt-4 grid gap-3">
              <img src={props.masterAsset.thumbnailUrl || props.masterAsset.originalUrl} alt="母版预览" className="max-h-[360px] w-full rounded-lg border border-hairline object-contain" />
              {props.masterAsset.originalUrl && props.onDownloadImage && (
                <DownloadOverlayButton onClick={() => props.onDownloadImage?.(props.masterAsset!.originalUrl)} />
              )}
            </div>
          )}
        </section>

        <section className="border-b border-[#e5e7eb] bg-white px-4 py-5 lg:px-6">
          <p className="text-xs font-semibold text-ink-secondary">分段</p>
          <h3 className="mt-1 text-base font-semibold text-ink">分段预览</h3>
          <Stagger className="mt-4 grid gap-4 lg:grid-cols-3">
            <AnimatePresence mode="popLayout">
              {props.segmentCards.map(({ index, segment }) => (
                <StaggerItem key={index}>
                  <motion.article
                    layout
                    className="rounded-lg border border-hairline-subtle bg-surface-subtle p-3"
                    whileHover={{ y: -4, boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)" }}
                    transition={spring.smooth}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="text-sm font-semibold text-ink">第 {index + 1} 段</h4>
                      <RippleButton type="button" onClick={() => props.onRedrawSegment(index)} disabled={props.stageLabel === "draft" || props.isWorkflowMutating} className="text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:text-ink-tertiary">
                        {props.redrawingIndexes.includes(index) ? "重绘中" : `重绘第 ${index + 1} 段`}
                      </RippleButton>
                    </div>
                    {segment ? (
                      <div className="mt-3 grid gap-3">
                        <div className="group relative">
                          <img src={segment.thumbnailUrl || segment.originalUrl} alt={`第 ${index + 1} 段预览`} className="aspect-[3/4] w-full rounded-lg border border-hairline object-cover" />
                          {segment.originalUrl && props.onDownloadImage && (
                            <DownloadOverlayButton onClick={() => props.onDownloadImage?.(segment.originalUrl)} />
                          )}
                        </div>
                        <p className="line-clamp-3 text-xs leading-5 text-ink-secondary">{segment.prompt}</p>
                      </div>
                    ) : (
                      <div className="mt-3 grid min-h-48 place-items-center rounded-lg border border-dashed border-hairline bg-white text-center text-xs text-ink-tertiary">
                        {props.stageLabel === "segments_running" ? (
                          <span className="grid place-items-center gap-2">
                            <span className="h-5 w-5 rounded-full border-2 border-brand/20 border-t-brand animate-spin" />
                            正在生成
                          </span>
                        ) : "待生成分段"}
                      </div>
                    )}
                  </motion.article>
                </StaggerItem>
              ))}
            </AnimatePresence>
          </Stagger>
        </section>

        <section className="bg-white px-4 py-5 lg:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-ink-secondary">浏览器拼接</p>
              <h3 className="mt-1 text-base font-semibold text-ink">浏览器白底拼接</h3>
              <p className="mt-2 text-sm leading-6 text-ink-secondary">分段原图齐全后，在浏览器中纵向拼接，再保存回工作流。拼接不消耗算力点。</p>
            </div>
            <RippleButton type="button" aria-label="保存拼接长图" onClick={props.onSaveStitched} disabled={!props.canSave || props.isWorkflowMutating} className="h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-brand/40">
              {props.isSavingStitched ? "保存中" : "保存拼接长图"}
            </RippleButton>
          </div>
          {props.stitchedPreviewDataUrl || props.stitchedAsset ? (
            <div className="mt-4 grid gap-3">
              {props.stitchedPreviewDataUrl && (
                <div className="grid gap-3">
                  <div className="group relative">
                    <img src={props.stitchedPreviewDataUrl} alt="本地拼接长图预览" className="max-h-[720px] w-full rounded-lg border border-hairline object-contain" />
                    {props.onDownloadImage && (
                      <DownloadOverlayButton onClick={() => props.onDownloadImage?.(props.stitchedPreviewDataUrl!)} />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href={props.stitchedPreviewDataUrl} download="workflow-ecom-stitched.png" className="inline-flex h-10 items-center rounded-lg border border-hairline px-4 text-sm font-semibold text-ink">下载本地预览</a>
                    <a href={props.stitchedPreviewDataUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-lg border border-hairline px-4 text-sm font-semibold text-ink">打开本地预览</a>
                  </div>
                </div>
              )}
              {props.stitchedAsset && (
                <div className="grid gap-3 rounded-lg border border-hairline-subtle bg-surface-subtle p-3">
                  <div className="group relative">
                    <img src={props.stitchedAsset.thumbnailUrl || props.stitchedAsset.originalUrl} alt="已保存长图预览" className="max-h-[480px] w-full rounded-lg border border-hairline object-contain" />
                    {props.stitchedAsset.originalUrl && props.onDownloadImage && (
                      <DownloadOverlayButton onClick={() => props.onDownloadImage?.(props.stitchedAsset!.originalUrl)} />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href={props.stitchedAsset.originalUrl} download="workflow-ecom-saved.png" className="inline-flex h-10 items-center rounded-lg border border-hairline px-4 text-sm font-semibold text-ink">下载已保存长图</a>
                    <a href={props.stitchedAsset.originalUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-lg border border-hairline px-4 text-sm font-semibold text-ink">打开已保存长图</a>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-hairline bg-surface-subtle px-4 py-6 text-sm text-ink-tertiary">{props.canStitch ? "点击\"浏览器拼接长图\"生成本地预览。" : "三段原图齐全后才可拼接与保存。"}</div>
          )}
        </section>

        </div>
        {props.historyFooter}
      </div>
    </section>
  );
}
