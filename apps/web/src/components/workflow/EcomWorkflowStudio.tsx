import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as workflowEcomApi from "../../workflowEcomApi";
import type {
  WorkflowEcomImageAsset,
  WorkflowEcomPlatform,
  WorkflowEcomPlatformId,
  WorkflowEcomPricing,
  WorkflowEcomResolution,
  WorkflowEcomSegmentIndex,
  WorkflowEcomTemplate,
  WorkflowEcomTemplateId,
  WorkflowEcomWorkflow,
} from "../../workflowEcomApi";
import { stitchEcomSegments } from "./ecomWorkflowStitch";
import {
  ECOM_MAX_REFERENCE_COUNT,
  FALLBACK_PLATFORMS,
  FALLBACK_TEMPLATES,
  ECOM_RESOLUTION_OPTIONS,
  ECOM_SEGMENT_COUNT_OPTIONS,
  canSaveEcomStitchedPreview,
  createEcomMasterPayload,
  createEcomWorkflowActions,
  describeEcomWorkflowStage,
  formatEcomError,
  hasAllSegmentUrls,
  isEcomWorkflowMutating,
  readFileAsInlineImage,
  segmentByIndex,
  segmentOrder,
  type EcomMasterDraft,
  type EcomWorkflowStudioClient,
} from "./ecomWorkflowStudioModel";
import { EcomWorkflowStudioView, type EcomWorkflowStudioViewSegment } from "./ecomWorkflowStudioView";

type EcomSharedProduct = {
  readonly platformId: WorkflowEcomPlatformId;
  readonly productName: string;
  readonly category: string;
  readonly sellingPointsInput: string;
  readonly extra: string;
  readonly referenceAssets: readonly WorkflowEcomImageAsset[];
  readonly remoteReferenceCount: number;
};

type EcomWorkflowStudioProps = {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
  readonly onDownloadImage?: (url: string) => void;
  readonly loadWorkflow?: WorkflowEcomWorkflow | null;
  readonly onActivity?: () => void;
  readonly client?: EcomWorkflowStudioClient;
  readonly shared?: EcomSharedProduct;
  readonly mainImages?: readonly { readonly assetId: string; readonly thumbnailUrl: string }[];
  readonly controlsHeader?: ReactNode;
  readonly historyFooter?: ReactNode;
};

type StitchedPreview = {
  readonly b64: string;
  readonly dataUrl: string;
};

export { EcomWorkflowStudioView } from "./ecomWorkflowStudioView";
export { createEcomMasterPayload, createEcomWorkflowActions, type EcomWorkflowStudioClient } from "./ecomWorkflowStudioModel";

const DEFAULT_CLIENT: EcomWorkflowStudioClient = workflowEcomApi;
const ECOM_POLL_MS = 3000;

export function EcomWorkflowStudio({ token, onBalanceRefresh, onDownloadImage, loadWorkflow, onActivity, client = DEFAULT_CLIENT, shared, mainImages, controlsHeader, historyFooter }: EcomWorkflowStudioProps) {
  const actions = useMemo(() => createEcomWorkflowActions(client, token), [client, token]);
  const [platforms, setPlatforms] = useState<readonly WorkflowEcomPlatform[]>(FALLBACK_PLATFORMS);
  const [templates, setTemplates] = useState<readonly WorkflowEcomTemplate[]>(FALLBACK_TEMPLATES);
  const [pricing, setPricing] = useState<WorkflowEcomPricing | null>(null);
  const [selectedPlatformId, setSelectedPlatformId] = useState<WorkflowEcomPlatformId>("taobao");
  const [selectedTemplateId, setSelectedTemplateId] = useState<WorkflowEcomTemplateId>("general");
  const [selectedResolution, setSelectedResolution] = useState<WorkflowEcomResolution>("1K");
  const [productName, setProductName] = useState("");
  const [category, setCategory] = useState("");
  const [sellingPointsInput, setSellingPointsInput] = useState("");
  const [extra, setExtra] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowEcomWorkflow | null>(null);
  const [referenceAssets, setReferenceAssets] = useState<readonly WorkflowEcomImageAsset[]>([]);
  const [stitchedPreview, setStitchedPreview] = useState<StitchedPreview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSubmittingMaster, setIsSubmittingMaster] = useState(false);
  const [isRetryingMaster, setIsRetryingMaster] = useState(false);
  const [isConfirmingSegments, setIsConfirmingSegments] = useState(false);
  const [isUploadingReference, setIsUploadingReference] = useState(false);
  const [isStitchingPreview, setIsStitchingPreview] = useState(false);
  const [isSavingStitched, setIsSavingStitched] = useState(false);
  const [redrawingIndexes, setRedrawingIndexes] = useState<readonly WorkflowEcomSegmentIndex[]>([]);
  const [selectedSegmentCount, setSelectedSegmentCount] = useState(3);
  const [selectedMasterAssetId, setSelectedMasterAssetId] = useState<string | null>(null);

  const applyWorkflow = useCallback((nextWorkflow: WorkflowEcomWorkflow | null) => {
    if (!nextWorkflow) return;
    setWorkflow(nextWorkflow);
    setSelectedTemplateId(nextWorkflow.template);
    setSelectedResolution(nextWorkflow.resolution);
    setSelectedSegmentCount(nextWorkflow.segmentCount);
    if (!shared) {
      setSelectedPlatformId(nextWorkflow.platform);
      setProductName(nextWorkflow.product.name);
      setCategory(nextWorkflow.product.category);
      setSellingPointsInput(nextWorkflow.product.sellingPoints.join("\n"));
      setExtra(nextWorkflow.product.extra);
    }
  }, [shared]);

  useEffect(() => {
    void (async () => {
      try {
        const [options, currentWorkflow] = await Promise.all([
          client.getWorkflowEcomOptions(token),
          client.getCurrentWorkflowEcom(token),
        ]);
        if (options.platforms.length > 0) setPlatforms(options.platforms);
        if (options.templates.length > 0) setTemplates(options.templates);
        applyWorkflow(currentWorkflow);
      } catch (loadError) {
        setError(formatEcomError(loadError, "加载电商长图工作台失败"));
      } finally {
        setIsBootstrapping(false);
      }
    })();
  }, [applyWorkflow, client, token]);

  useEffect(() => {
    if (loadWorkflow) {
      applyWorkflow(loadWorkflow);
      clearFeedback();
    }
  }, [loadWorkflow, applyWorkflow]);

  useEffect(() => {
    void (async () => {
      try {
        setPricing(await client.getWorkflowEcomPricing(token));
      } catch {
        setPricing(null);
      }
    })();
  }, [client, token]);

  const refreshCurrentWorkflow = useCallback(async () => {
    try {
      applyWorkflow(await client.getCurrentWorkflowEcom(token));
    } catch (loadError) {
      setError(formatEcomError(loadError, "恢复电商长图任务失败"));
    }
  }, [applyWorkflow, client, token]);

  const effPlatformId = shared?.platformId ?? selectedPlatformId;
  const effProductName = shared?.productName ?? productName;
  const effCategory = shared?.category ?? category;
  const effSellingPoints = shared?.sellingPointsInput ?? sellingPointsInput;
  const effExtra = shared?.extra ?? extra;
  const effReferenceAssets = shared?.referenceAssets ?? referenceAssets;

  const selectedPlatform = platforms.find((platform) => platform.id === effPlatformId) ?? FALLBACK_PLATFORMS[0];
  const masterPointCost = pricing ? pricing.master[selectedResolution]?.rate ?? null : null;
  const activeSegmentCount = workflow?.segmentCount ?? selectedSegmentCount;
  const segmentPointCost = pricing ? (pricing.segment[selectedResolution]?.rate ?? 0) * activeSegmentCount : null;
  const stitchPointCost = pricing ? pricing.stitch.rate : null;
  const isServerGenerating = workflow?.stage === "master_running" || workflow?.stage === "segments_running";
  const remoteReferenceCount = shared ? shared.remoteReferenceCount : Math.max((workflow?.referenceAssetIds.length ?? 0) - referenceAssets.length, 0);
  const canStitch = hasAllSegmentUrls(workflow);
  const segmentCards: readonly EcomWorkflowStudioViewSegment[] = segmentOrder(activeSegmentCount).map((index) => ({
    index,
    segment: workflow ? segmentByIndex(workflow.segments, index) : null,
  }));
  const stageLabel = workflow?.stage ?? "draft";
  const stageDescription = describeEcomWorkflowStage(workflow);
  const workflowMutating = isEcomWorkflowMutating({
    isSubmittingMaster,
    isRetryingMaster,
    isConfirmingSegments,
    isSavingStitched,
    isStitchingPreview,
    redrawingCount: redrawingIndexes.length,
    isServerGenerating,
  });
  const canSave = canSaveEcomStitchedPreview({
    canStitch,
    hasWorkflow: workflow !== null,
    hasPreview: stitchedPreview !== null,
    isWorkflowMutating: workflowMutating,
  });

  useEffect(() => {
    if (!isServerGenerating && !isSubmittingMaster && !isRetryingMaster && !isConfirmingSegments && redrawingIndexes.length === 0) return undefined;
    const timer = window.setInterval(() => {
      void refreshCurrentWorkflow();
    }, ECOM_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isConfirmingSegments, isRetryingMaster, isServerGenerating, isSubmittingMaster, redrawingIndexes.length, refreshCurrentWorkflow]);

  const clearFeedback = () => { setError(""); setNotice(""); };

  const refreshWorkflow = (nextWorkflow: WorkflowEcomWorkflow, successNotice: string) => { applyWorkflow(nextWorkflow); setNotice(successNotice); setError(""); onActivity?.(); onBalanceRefresh?.(); };

  const buildDraft = (): EcomMasterDraft => ({ platformId: effPlatformId, templateId: selectedTemplateId, resolution: selectedResolution, productName: effProductName, category: effCategory, sellingPointsInput: effSellingPoints, extra: effExtra, referenceAssetIds: effReferenceAssets.map((asset) => asset.id), segmentCount: selectedSegmentCount });
  const runWorkflowMutation = (args: {
    readonly start: () => void;
    readonly finish: () => void;
    readonly run: () => Promise<WorkflowEcomWorkflow>;
    readonly successNotice: string;
    readonly fallback: string;
    readonly invalidatePreview?: boolean;
  }) => {
    clearFeedback();
    if (args.invalidatePreview) setStitchedPreview(null);
    args.start();
    void (async () => {
      try {
        refreshWorkflow(await args.run(), args.successNotice);
      } catch (mutationError) {
        setError(formatEcomError(mutationError, args.fallback));
      } finally {
        args.finish();
      }
    })();
  };

  return (
    <EcomWorkflowStudioView
      platforms={platforms}
      templates={templates}
      selectedPlatformId={effPlatformId}
      selectedTemplateId={selectedTemplateId}
      selectedResolution={selectedResolution}
      resolutionOptions={ECOM_RESOLUTION_OPTIONS}
      selectedSegmentCount={selectedSegmentCount}
      segmentCountOptions={ECOM_SEGMENT_COUNT_OPTIONS}
      masterPointCost={masterPointCost}
      segmentPointCost={segmentPointCost}
      stitchPointCost={stitchPointCost}
      productName={effProductName}
      category={effCategory}
      sellingPointsInput={effSellingPoints}
      extra={effExtra}
      referenceAssets={effReferenceAssets}
      remoteReferenceCount={remoteReferenceCount}
      isForeignPlatform={selectedPlatform.market === "foreign"}
      stitchedPreviewDataUrl={stitchedPreview?.dataUrl ?? null}
      isBootstrapping={isBootstrapping}
      isSubmittingMaster={isSubmittingMaster}
      isRetryingMaster={isRetryingMaster}
      isConfirmingSegments={isConfirmingSegments}
      isUploadingReference={isUploadingReference}
      isStitchingPreview={isStitchingPreview}
      isSavingStitched={isSavingStitched}
      isWorkflowMutating={workflowMutating}
      redrawingIndexes={redrawingIndexes}
      error={error}
      notice={notice}
      workflowError={workflow?.error ?? null}
      stageLabel={stageLabel}
      stageDescription={stageDescription}
      isServerGenerating={isServerGenerating}
      masterAsset={workflow?.masterAsset ?? null}
      stitchedAsset={workflow?.stitchedAsset ?? null}
      segmentCards={segmentCards}
      canStitch={canStitch}
      canSave={canSave}
      hideProductForm={Boolean(shared)}
      controlsHeader={controlsHeader}
      historyFooter={historyFooter}
      onPlatformChange={(value) => { setSelectedPlatformId(value); clearFeedback(); }}
      onTemplateChange={(value) => { setSelectedTemplateId(value); clearFeedback(); }}
      onResolutionChange={(value) => { setSelectedResolution(value); clearFeedback(); setStitchedPreview(null); }}
      onSegmentCountChange={(value) => { setSelectedSegmentCount(Number(value)); clearFeedback(); setStitchedPreview(null); }}
      onProductNameChange={(value) => { setProductName(value); clearFeedback(); }}
      onCategoryChange={(value) => { setCategory(value); clearFeedback(); }}
      onSellingPointsChange={(value) => { setSellingPointsInput(value); clearFeedback(); }}
      onExtraChange={(value) => { setExtra(value); clearFeedback(); }}
      onReferenceUpload={(file) => {
        if (referenceAssets.length + remoteReferenceCount >= ECOM_MAX_REFERENCE_COUNT) return;
        clearFeedback();
        setIsUploadingReference(true);
        void (async () => {
          try {
            const inlineImage = await readFileAsInlineImage(file);
            const asset = await client.createWorkflowEcomReference(token, inlineImage);
            setReferenceAssets((current) => current.some((item) => item.id === asset.id) ? current : [...current, asset].slice(0, ECOM_MAX_REFERENCE_COUNT));
            setNotice("参考图已上传");
          } catch (uploadError) {
            setError(formatEcomError(uploadError, "上传参考图失败"));
          } finally {
            setIsUploadingReference(false);
          }
        })();
      }}
      onCreateMaster={() => {
        runWorkflowMutation({ start: () => setIsSubmittingMaster(true), finish: () => setIsSubmittingMaster(false), run: () => actions.createMaster(buildDraft()), successNotice: "母版生成请求已提交", fallback: "生成母版失败", invalidatePreview: true });
      }}
      onRetryMaster={() => {
        if (!workflow) return;
        runWorkflowMutation({ start: () => setIsRetryingMaster(true), finish: () => setIsRetryingMaster(false), run: () => actions.retryMaster(workflow.id), successNotice: "已重新提交母版生成", fallback: "重试主图失败", invalidatePreview: true });
      }}
      onConfirmSegments={() => {
        if (!workflow) return;
        runWorkflowMutation({ start: () => setIsConfirmingSegments(true), finish: () => setIsConfirmingSegments(false), run: () => actions.confirmSegments(workflow.id), successNotice: "分段生成请求已提交", fallback: "确认分段失败", invalidatePreview: true });
      }}
      onRedrawSegment={(index) => {
        if (!workflow) return;
        runWorkflowMutation({
          start: () => setRedrawingIndexes((current) => current.includes(index) ? current : [...current, index]),
          finish: () => setRedrawingIndexes((current) => current.filter((item) => item !== index)),
          run: () => actions.redrawSegment(workflow.id, index),
          successNotice: `第 ${index + 1} 段已重新生成`,
          fallback: "重绘分段失败",
          invalidatePreview: true,
        });
      }}
      onStitchPreview={() => {
        if (!workflow) return;
        clearFeedback();
        setIsStitchingPreview(true);
        void (async () => {
          try {
            const result = await stitchEcomSegments({
              segments: workflow.segments.map((segment) => ({
                index: segment.index,
                originalUrl: `/api/workflow/ecom/${encodeURIComponent(workflow.id)}/segments/${segment.index}/blob`,
              })),
              fetchBlob: async (url) => {
                const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (!response.ok) throw new Error("分段图片下载失败");
                return response.blob();
              },
            });
            setStitchedPreview({ b64: result.b64, dataUrl: result.dataUrl });
            setNotice("浏览器拼接完成，可下载或保存");
          } catch (stitchError) {
            setError(formatEcomError(stitchError, "浏览器拼接失败"));
          } finally {
            setIsStitchingPreview(false);
          }
        })();
      }}
      onSaveStitched={() => {
        if (!workflow || !stitchedPreview) return;
        runWorkflowMutation({ start: () => setIsSavingStitched(true), finish: () => setIsSavingStitched(false), run: () => actions.saveStitched(workflow.id, stitchedPreview.b64), successNotice: "已保存", fallback: "保存拼接长图失败" });
      }}
      onAdoptMaster={() => {
        if (!selectedMasterAssetId) return;
        runWorkflowMutation({ start: () => setIsSubmittingMaster(true), finish: () => setIsSubmittingMaster(false), run: () => actions.adoptMaster(buildDraft(), selectedMasterAssetId), successNotice: "已用所选主图作为母版", fallback: "选用主图失败", invalidatePreview: true });
      }}
      mainImages={mainImages ?? []}
      selectedMasterAssetId={selectedMasterAssetId}
      onSelectMainImage={(id) => { setSelectedMasterAssetId(id); clearFeedback(); }}
      onDownloadImage={onDownloadImage}
    />
  );
}
