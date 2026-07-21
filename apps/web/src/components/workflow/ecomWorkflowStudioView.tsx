import { useRef } from "react";
import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import { RippleButton, Stagger, StaggerItem, spring } from "../../motion";
import { InAppSelect } from "../agent-teams/InAppSelect";
import type {
  WorkflowEcomImageAsset,
  WorkflowEcomPlatform,
  WorkflowEcomPlatformId,
  WorkflowEcomResolution,
  WorkflowEcomSegment,
  WorkflowEcomSegmentIndex,
  WorkflowEcomTemplate,
  WorkflowEcomTemplateId,
  WorkflowEcomWorkflow,
} from "../../workflowEcomApi";
import { ECOM_MAX_REFERENCE_COUNT } from "./ecomWorkflowStudioModel";

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
  readonly onDownloadImage?: (url: string) => void;
  readonly onPlatformChange: (value: WorkflowEcomPlatformId) => void;
  readonly onTemplateChange: (value: WorkflowEcomTemplateId) => void;
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

function costSuffix(cost: number | null): string {
  return cost != null ? ` · 约${cost}点` : "";
}

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

  return (
    <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(360px,440px)_minmax(0,1fr)]">
      <aside className="rounded-[14px] border border-[#d2d2d7] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.06em] text-[#6e6e73]">电商工作台</p>
            <h2 className="mt-2 text-[18px] font-semibold text-[#1d1d1f]">电商长图工作台</h2>
            <p className="mt-2 text-sm leading-6 text-[#6e6e73]">上传参考图、生成母版、确认分段并在浏览器完成白底纵向拼接。</p>
          </div>
          {props.isForeignPlatform && <span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-ink">海外平台文案</span>}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {!props.hideProductForm && (
            <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
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
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            模板
            <InAppSelect
              icon="mdi:file-document-outline"
              label="模板"
              value={props.selectedTemplateId}
              options={props.templates.map((template) => ({ value: template.id, label: template.name }))}
              onChange={handleTemplateChange}
            />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f] sm:col-span-2">
            清晰度
            <InAppSelect
              icon="mdi:high-definition"
              label="清晰度"
              value={props.selectedResolution}
              options={props.resolutionOptions.map((option) => ({ value: option.value, label: `${option.label} · ${option.size}` }))}
              onChange={handleResolutionChange}
            />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f] sm:col-span-2">
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
            <label className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
              商品名称
              <input value={props.productName} onChange={(event) => props.onProductNameChange(event.target.value)} className="h-11 rounded-[10px] border border-[#d2d2d7] px-3 text-sm text-[#1d1d1f]" />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
              商品类目
              <input value={props.category} onChange={(event) => props.onCategoryChange(event.target.value)} className="h-11 rounded-[10px] border border-[#d2d2d7] px-3 text-sm text-[#1d1d1f]" />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
              卖点文案
              <textarea value={props.sellingPointsInput} onChange={(event) => props.onSellingPointsChange(event.target.value)} className="min-h-[108px] rounded-[10px] border border-[#d2d2d7] p-3 text-sm leading-6 text-[#1d1d1f]" />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
              额外说明
              <textarea value={props.extra} onChange={(event) => props.onExtraChange(event.target.value)} className="min-h-[88px] rounded-[10px] border border-[#d2d2d7] p-3 text-sm leading-6 text-[#1d1d1f]" />
            </label>
          </div>
        )}

        {!props.hideProductForm && (
          <div className="mt-4 rounded-[10px] border border-[#e8e8ed] bg-[#f7faf9] p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[#1d1d1f]">参考图 ({props.referenceAssets.length + props.remoteReferenceCount}/{ECOM_MAX_REFERENCE_COUNT})</p>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={props.isUploadingReference || props.referenceAssets.length + props.remoteReferenceCount >= ECOM_MAX_REFERENCE_COUNT} className="h-10 rounded-[10px] border border-dashed border-[#d2d2d7] px-3 text-sm font-semibold text-[#1d1d1f] disabled:cursor-not-allowed disabled:text-[#8a8a8f]">
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
                <img key={asset.id} src={asset.thumbnailUrl || asset.originalUrl} alt="参考图缩略图" className="h-16 w-16 rounded-[8px] border border-[#d2d2d7] object-cover" />
              ))}
              {props.remoteReferenceCount > 0 && <div className="grid h-16 min-w-16 place-items-center rounded-[8px] border border-dashed border-[#d2d2d7] px-3 text-center text-xs text-[#6e6e73]">已关联 {props.remoteReferenceCount} 张线上参考图</div>}
              {props.referenceAssets.length === 0 && props.remoteReferenceCount === 0 && <div className="rounded-[8px] border border-dashed border-[#d2d2d7] px-3 py-4 text-xs text-[#8a8a8f]">上传后会展示本地缩略图。</div>}
            </div>
          </div>
        )}

        {(props.error || props.notice || props.workflowError) && (
          <p className={`mt-4 rounded-[10px] px-3 py-2 text-sm ${props.error || props.workflowError ? "bg-red-50 text-red-700" : "bg-brand-soft text-brand-ink"}`}>
            {props.error || props.workflowError || props.notice}
          </p>
        )}

        <div className="mt-4 grid gap-2 text-sm font-semibold text-[#1d1d1f]">
          从主图选母版
          {(props.mainImages?.length ?? 0) === 0 ? (
            <p className="rounded-[10px] border border-dashed border-[#d2d2d7] px-3 py-3 text-xs font-normal text-[#8a8a8f]">先在「商品主图」生成主图，即可选一张作为母版（省一次母版出图）。</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {props.mainImages!.map((img) => (
                  <button
                    key={img.assetId}
                    type="button"
                    onClick={() => props.onSelectMainImage?.(img.assetId)}
                    className={`h-16 w-16 overflow-hidden rounded-[8px] border-2 transition-colors ${props.selectedMasterAssetId === img.assetId ? "border-brand" : "border-transparent"}`}
                  >
                    <img src={img.thumbnailUrl} alt="主图缩略图" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
              <RippleButton
                type="button"
                onClick={() => props.onAdoptMaster?.()}
                disabled={!props.selectedMasterAssetId || props.isWorkflowMutating}
                className="h-10 rounded-[10px] bg-brand text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-brand/40"
              >
                用所选主图作为母版
              </RippleButton>
            </>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <RippleButton type="button" onClick={props.onCreateMaster} disabled={props.isWorkflowMutating || props.isBootstrapping} className="h-11 rounded-[10px] bg-brand text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-brand/40">
            {props.isSubmittingMaster ? "生成中" : `生成母版${costSuffix(props.masterPointCost)}`}
          </RippleButton>
          <RippleButton type="button" onClick={props.onRetryMaster} disabled={props.stageLabel === "draft" || props.isWorkflowMutating} className="h-11 rounded-[10px] border border-[#d2d2d7] text-sm font-semibold text-[#1d1d1f] disabled:cursor-not-allowed disabled:bg-[#f5f5f7] disabled:text-[#8a8a8f]">
            {props.isRetryingMaster ? "重试中" : "重试主图"}
          </RippleButton>
          <RippleButton type="button" onClick={props.onConfirmSegments} disabled={props.stageLabel === "draft" || props.isWorkflowMutating} className="h-11 rounded-[10px] border border-[#d2d2d7] text-sm font-semibold text-[#1d1d1f] disabled:cursor-not-allowed disabled:bg-[#f5f5f7] disabled:text-[#8a8a8f]">
            {props.isConfirmingSegments ? "确认中" : `确认分段${costSuffix(props.segmentPointCost)}`}
          </RippleButton>
          <RippleButton type="button" aria-label="浏览器拼接长图" onClick={props.onStitchPreview} disabled={!props.canStitch || props.isWorkflowMutating} className="h-11 rounded-[10px] border border-[#d2d2d7] text-sm font-semibold text-[#1d1d1f] disabled:cursor-not-allowed disabled:bg-[#f5f5f7] disabled:text-[#8a8a8f]">
            {props.isStitchingPreview ? "拼接中" : "浏览器拼接长图"}
          </RippleButton>
        </div>
      </aside>

      <div className="grid gap-5">
        <section className="rounded-[14px] border border-[#d2d2d7] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.06em] text-[#6e6e73]">任务阶段</p>
              <h3 className="mt-2 flex items-center gap-2 text-[18px] font-semibold text-[#1d1d1f]">
                母版与分段状态
                {props.isServerGenerating && <span aria-label="生成中" className="h-4 w-4 rounded-full border-2 border-brand/20 border-t-brand animate-spin" />}
              </h3>
              <p className="mt-2 text-sm leading-6 text-[#6e6e73]">{props.stageDescription}</p>
            </div>
            <span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-ink">{formatStageLabel(props.stageLabel, props.isServerGenerating)}</span>
          </div>
          {props.masterAsset && (
            <div className="group relative mt-4 grid gap-3">
              <img src={props.masterAsset.thumbnailUrl || props.masterAsset.originalUrl} alt="母版预览" className="max-h-[360px] w-full rounded-[10px] border border-[#d2d2d7] object-contain" />
              {props.masterAsset.originalUrl && props.onDownloadImage && (
                <button type="button" onClick={() => props.onDownloadImage?.(props.masterAsset!.originalUrl)}
                  className="absolute right-2 top-2 flex items-center gap-1 rounded-[8px] bg-black/55 px-2 py-1 text-xs font-semibold text-white opacity-100 transition ">
                  <Icon icon="mdi:download" aria-hidden />下载原图
                </button>
              )}
            </div>
          )}
        </section>

        <section className="rounded-[14px] border border-[#d2d2d7] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-[#6e6e73]">分段</p>
          <h3 className="mt-2 text-[18px] font-semibold text-[#1d1d1f]">分段预览</h3>
          <Stagger className="mt-4 grid gap-4 lg:grid-cols-3">
            <AnimatePresence mode="popLayout">
              {props.segmentCards.map(({ index, segment }) => (
                <StaggerItem key={index}>
                  <motion.article
                    layout
                    className="rounded-[10px] border border-[#e8e8ed] bg-[#f7faf9] p-3"
                    whileHover={{ y: -4, boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)" }}
                    transition={spring.smooth}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="text-sm font-semibold text-[#1d1d1f]">第 {index + 1} 段</h4>
                      <RippleButton type="button" onClick={() => props.onRedrawSegment(index)} disabled={props.stageLabel === "draft" || props.isWorkflowMutating} className="text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:text-[#8a8a8f]">
                        {props.redrawingIndexes.includes(index) ? "重绘中" : `重绘第 ${index + 1} 段`}
                      </RippleButton>
                    </div>
                    {segment ? (
                      <div className="mt-3 grid gap-3">
                        <div className="group relative">
                          <img src={segment.thumbnailUrl || segment.originalUrl} alt={`第 ${index + 1} 段预览`} className="aspect-[3/4] w-full rounded-[8px] border border-[#d2d2d7] object-cover" />
                          {segment.originalUrl && props.onDownloadImage && (
                            <button type="button" onClick={() => props.onDownloadImage?.(segment.originalUrl)}
                              className="absolute right-2 top-2 flex items-center gap-1 rounded-[8px] bg-black/55 px-2 py-1 text-xs font-semibold text-white opacity-100 transition ">
                              <Icon icon="mdi:download" aria-hidden />下载原图
                            </button>
                          )}
                        </div>
                        <p className="line-clamp-3 text-xs leading-5 text-[#6e6e73]">{segment.prompt}</p>
                      </div>
                    ) : (
                      <div className="mt-3 grid min-h-48 place-items-center rounded-[8px] border border-dashed border-[#d2d2d7] bg-white text-center text-xs text-[#8a8a8f]">
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

        <section className="rounded-[14px] border border-[#d2d2d7] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.06em] text-[#6e6e73]">浏览器拼接</p>
              <h3 className="mt-2 text-[18px] font-semibold text-[#1d1d1f]">浏览器白底拼接</h3>
              <p className="mt-2 text-sm leading-6 text-[#6e6e73]">分段原图齐全后，在浏览器中纵向拼接，再保存回工作流。</p>
            </div>
            <RippleButton type="button" aria-label="保存拼接长图" onClick={props.onSaveStitched} disabled={!props.canSave || props.isWorkflowMutating} className="h-11 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-brand/40">
              {props.isSavingStitched ? "保存中" : `保存拼接长图${costSuffix(props.stitchPointCost)}`}
            </RippleButton>
          </div>
          {props.stitchedPreviewDataUrl || props.stitchedAsset ? (
            <div className="mt-4 grid gap-3">
              {props.stitchedPreviewDataUrl && (
                <div className="grid gap-3">
                  <div className="group relative">
                    <img src={props.stitchedPreviewDataUrl} alt="本地拼接长图预览" className="max-h-[720px] w-full rounded-[10px] border border-[#d2d2d7] object-contain" />
                    {props.onDownloadImage && (
                      <button type="button" onClick={() => props.onDownloadImage?.(props.stitchedPreviewDataUrl!)}
                        className="absolute right-2 top-2 flex items-center gap-1 rounded-[8px] bg-black/55 px-2 py-1 text-xs font-semibold text-white opacity-100 transition ">
                        <Icon icon="mdi:download" aria-hidden />下载原图
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href={props.stitchedPreviewDataUrl} download="workflow-ecom-stitched.png" className="inline-flex h-10 items-center rounded-[10px] border border-[#d2d2d7] px-4 text-sm font-semibold text-[#1d1d1f]">下载本地预览</a>
                    <a href={props.stitchedPreviewDataUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-[10px] border border-[#d2d2d7] px-4 text-sm font-semibold text-[#1d1d1f]">打开本地预览</a>
                  </div>
                </div>
              )}
              {props.stitchedAsset && (
                <div className="grid gap-3 rounded-[10px] border border-[#e8e8ed] bg-[#f7faf9] p-3">
                  <div className="group relative">
                    <img src={props.stitchedAsset.thumbnailUrl || props.stitchedAsset.originalUrl} alt="已保存长图预览" className="max-h-[480px] w-full rounded-[10px] border border-[#d2d2d7] object-contain" />
                    {props.stitchedAsset.originalUrl && props.onDownloadImage && (
                      <button type="button" onClick={() => props.onDownloadImage?.(props.stitchedAsset!.originalUrl)}
                        className="absolute right-2 top-2 flex items-center gap-1 rounded-[8px] bg-black/55 px-2 py-1 text-xs font-semibold text-white opacity-100 transition ">
                        <Icon icon="mdi:download" aria-hidden />下载原图
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href={props.stitchedAsset.originalUrl} download="workflow-ecom-saved.png" className="inline-flex h-10 items-center rounded-[10px] border border-[#d2d2d7] px-4 text-sm font-semibold text-[#1d1d1f]">下载已保存长图</a>
                    <a href={props.stitchedAsset.originalUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-[10px] border border-[#d2d2d7] px-4 text-sm font-semibold text-[#1d1d1f]">打开已保存长图</a>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-4 rounded-[10px] border border-dashed border-[#d2d2d7] bg-[#f7faf9] px-4 py-6 text-sm text-[#8a8a8f]">{props.canStitch ? "点击\"浏览器拼接长图\"生成本地预览。" : "三段原图齐全后才可拼接与保存。"}</div>
          )}
        </section>

      </div>
    </section>
  );
}
