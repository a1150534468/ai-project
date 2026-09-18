import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { InAppSelect } from "../ui/InAppSelect";
import * as workflowEcomApi from "../../workflowEcomApi";
import type { WorkflowEcomImageAsset, WorkflowEcomPlatform, WorkflowEcomPlatformId, WorkflowEcomWorkflow } from "../../workflowEcomApi";
import { helpWriteEcom, getCurrentEcomMainJob, type EcomHelpWriteField, type EcomMainJob } from "../../workflowEcomMainApi";
import { DownloadLinkDialog, type DownloadDialogState } from "../ui/DownloadLinkDialog";
import { ECOM_MAX_REFERENCE_COUNT, FALLBACK_PLATFORMS, formatEcomError, readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import { EcomWorkflowStudio } from "./EcomWorkflowStudio";
import { EcomMainImageStudio } from "./EcomMainImageStudio";
import { EcomHistorySidebar } from "./EcomHistorySidebar";

interface CommerceImageStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
  readonly tab: "main" | "detail";
  readonly onTabChange: (tab: "main" | "detail") => void;
  readonly loadMainJob?: EcomMainJob | null;
  readonly loadDetailWorkflow?: WorkflowEcomWorkflow | null;
  readonly onActivity?: () => void;
  readonly historyRefreshKey: number;
  readonly onSelectMainHistory: (job: EcomMainJob) => void;
  readonly onSelectDetailHistory: (workflow: WorkflowEcomWorkflow) => void;
}

const CATEGORY_OTHER = "other";
const CATEGORY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "电子产品", label: "电子产品" },
  { value: "家用电器", label: "家用电器" },
  { value: "服饰鞋包", label: "服饰鞋包" },
  { value: "美妆个护", label: "美妆个护" },
  { value: "食品饮料", label: "食品饮料" },
  { value: "母婴玩具", label: "母婴玩具" },
  { value: "家居日用", label: "家居日用" },
  { value: "运动户外", label: "运动户外" },
  { value: "珠宝配饰", label: "珠宝配饰" },
  { value: CATEGORY_OTHER, label: "其他" },
];

export function CommerceImageStudio({
  token,
  onBalanceRefresh,
  tab,
  onTabChange,
  loadMainJob,
  loadDetailWorkflow,
  onActivity,
  historyRefreshKey,
  onSelectMainHistory,
  onSelectDetailHistory,
}: CommerceImageStudioProps) {
  const [platforms, setPlatforms] = useState<readonly WorkflowEcomPlatform[]>(FALLBACK_PLATFORMS);
  const [platformId, setPlatformId] = useState<WorkflowEcomPlatformId>("taobao");
  const [productName, setProductName] = useState("");
  const [categoryChoice, setCategoryChoice] = useState<string>(CATEGORY_OPTIONS[0].value);
  const [categoryOther, setCategoryOther] = useState("");
  const [sellingPointsInput, setSellingPointsInput] = useState("");
  const [extra, setExtra] = useState("");
  const [referenceAssets, setReferenceAssets] = useState<readonly WorkflowEcomImageAsset[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [helpWriting, setHelpWriting] = useState<EcomHelpWriteField | null>(null);
  const [helpWriteError, setHelpWriteError] = useState("");
  const [downloadDialog, setDownloadDialog] = useState<DownloadDialogState | null>(null);
  const [mainImages, setMainImages] = useState<readonly { readonly assetId: string; readonly thumbnailUrl: string }[]>([]);
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const options = await workflowEcomApi.getWorkflowEcomOptions(token);
        if (options.platforms.length > 0) setPlatforms(options.platforms);
      } catch { /* 忽略：回落内置平台 */ }
    })();
  }, [token]);

  useEffect(() => {
    if (tab !== "detail") return;
    void (async () => {
      try {
        const { job } = await getCurrentEcomMainJob(token);
        const ready = (job?.images ?? []).filter((i) => i.status === "ready" && i.assetId);
        setMainImages(ready.map((i) => ({ assetId: i.assetId as string, thumbnailUrl: i.thumbnailUrl ?? i.originalUrl ?? "" })));
      } catch {
        setMainImages([]);
      }
    })();
  }, [tab, token]);

  const handleUpload = (file: File) => {
    if (referenceAssets.length >= ECOM_MAX_REFERENCE_COUNT) return;
    setUploadError("");
    setIsUploading(true);
    void (async () => {
      try {
        const inlineImage = await readFileAsInlineImage(file);
        const asset = await workflowEcomApi.createWorkflowEcomReference(token, inlineImage);
        setReferenceAssets((current) => current.some((item) => item.id === asset.id) ? current : [...current, asset].slice(0, ECOM_MAX_REFERENCE_COUNT));
      } catch (error) {
        setUploadError(formatEcomError(error, "上传参考图失败"));
      } finally {
        setIsUploading(false);
      }
    })();
  };

  const effectiveCategory = categoryChoice === CATEGORY_OTHER ? categoryOther.trim() : categoryChoice;

  const handleHelpWrite = (field: EcomHelpWriteField) => {
    if (helpWriting !== null) return;
    if (!productName.trim()) { setHelpWriteError("请先填写商品名称，再让 AI 帮我写"); return; }
    setHelpWriteError("");
    setHelpWriting(field);
    void (async () => {
      try {
        const sellingPoints = sellingPointsInput.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.length > 0);
        const { text } = await helpWriteEcom(token, { field, productName: productName.trim(), category: effectiveCategory, sellingPoints });
        if (field === "sellingPoints") setSellingPointsInput(text);
        else setExtra(text);
      } catch (error) {
        setHelpWriteError(formatEcomError(error, "帮我写失败，请稍后重试"));
      } finally {
        setHelpWriting(null);
      }
    })();
  };

  const openDownload = (url: string) => {
    setDownloadDialog({ title: "原图下载链接", links: [url] });
  };

  const mainShared = {
    platformId,
    productName,
    category: effectiveCategory,
    sellingPointsInput,
    extra,
    referenceAssetIds: referenceAssets.map((asset) => asset.id),
  };
  const detailShared = {
    platformId,
    productName,
    category: effectiveCategory,
    sellingPointsInput,
    extra,
    referenceAssets,
    remoteReferenceCount: 0,
  };
  const historyFooter = (
    <EcomHistorySidebar
      token={token}
      refreshKey={historyRefreshKey}
      onSelectMain={onSelectMainHistory}
      onSelectDetail={onSelectDetailHistory}
    />
  );

  const productControls = (
    <section className="border-b border-hairline-subtle pb-5">
      <p className="text-xs font-semibold text-ink-secondary">生成配置</p>
      <h2 className="mt-1 text-base font-semibold text-ink">产品资料</h2>
      <p className="mt-1 text-xs leading-5 text-ink-tertiary">主图与详情图共用。</p>
      <div className="mt-4 grid gap-3">
        <div className="grid gap-2 text-sm font-semibold text-ink">
          平台
          <InAppSelect icon="mdi:storefront-outline" label="平台" value={platformId} options={platforms.map((platform) => ({ value: platform.id, label: platform.name }))} onChange={(value) => setPlatformId(value as WorkflowEcomPlatformId)} />
        </div>
        <label className="grid gap-2 text-sm font-semibold text-ink">
          商品名称
          <input value={productName} onChange={(event) => setProductName(event.target.value)} className="h-10 rounded-lg border border-hairline px-3 text-sm font-normal text-ink" />
        </label>
        <div className="grid gap-2 text-sm font-semibold text-ink">
          商品类目
          <InAppSelect icon="mdi:shape-outline" label="商品类目" value={categoryChoice} options={CATEGORY_OPTIONS} onChange={setCategoryChoice} />
          {categoryChoice === CATEGORY_OTHER && (
            <input value={categoryOther} onChange={(event) => setCategoryOther(event.target.value)} placeholder="请填写商品类目" className="h-10 rounded-lg border border-hairline px-3 text-sm font-normal text-ink" />
          )}
        </div>
        <div className="grid gap-2 text-sm font-semibold text-ink">
          <div className="flex items-center justify-between gap-3">
            <span>卖点文案</span>
            <button type="button" onClick={() => handleHelpWrite("sellingPoints")} disabled={helpWriting !== null} className="inline-flex h-8 items-center gap-1 rounded-lg border border-brand/40 px-2 text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:opacity-50">
              <Icon icon={helpWriting === "sellingPoints" ? "mdi:loading" : "mdi:auto-fix"} className={helpWriting === "sellingPoints" ? "animate-spin" : ""} aria-hidden />
              {helpWriting === "sellingPoints" ? "生成中" : "AI 帮我写"}
            </button>
          </div>
          <textarea value={sellingPointsInput} onChange={(event) => setSellingPointsInput(event.target.value)} placeholder="一行一个卖点" className="min-h-[88px] rounded-lg border border-hairline p-3 text-sm font-normal leading-5" />
        </div>
        <div className="grid gap-2 text-sm font-semibold text-ink">
          <div className="flex items-center justify-between gap-3">
            <span>额外说明</span>
            <button type="button" onClick={() => handleHelpWrite("extra")} disabled={helpWriting !== null} className="inline-flex h-8 items-center gap-1 rounded-lg border border-brand/40 px-2 text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:opacity-50">
              <Icon icon={helpWriting === "extra" ? "mdi:loading" : "mdi:auto-fix"} className={helpWriting === "extra" ? "animate-spin" : ""} aria-hidden />
              {helpWriting === "extra" ? "生成中" : "AI 帮我写"}
            </button>
          </div>
          <textarea value={extra} onChange={(event) => setExtra(event.target.value)} className="min-h-[72px] rounded-lg border border-hairline p-3 text-sm font-normal leading-5" />
        </div>
      </div>
      {helpWriteError && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger-ink">{helpWriteError}</p>}
      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-ink">参考图 ({referenceAssets.length}/{ECOM_MAX_REFERENCE_COUNT})</p>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading || referenceAssets.length >= ECOM_MAX_REFERENCE_COUNT} className="inline-flex h-9 items-center gap-1 rounded-lg border border-dashed border-hairline px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:text-ink-tertiary">
            <Icon icon={isUploading ? "mdi:loading" : "mdi:plus"} className={isUploading ? "animate-spin" : ""} aria-hidden />
            {isUploading ? "上传中" : "上传"}
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) handleUpload(file); event.currentTarget.value = ""; }} />
        <div className="mt-3 flex flex-wrap gap-2">
          {referenceAssets.map((asset) => <img key={asset.id} src={asset.thumbnailUrl || asset.originalUrl} alt="参考图缩略图" className="h-14 w-14 rounded-lg border border-hairline object-cover" />)}
          {referenceAssets.length === 0 && <p className="text-xs text-ink-tertiary">暂无参考图</p>}
        </div>
        {uploadError && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger-ink">{uploadError}</p>}
      </div>
    </section>
  );

  return (
    <section className="relative flex min-h-0 flex-col bg-surface xl:h-full xl:overflow-hidden">
      <header className="flex h-14 flex-none items-center justify-between gap-3 border-b border-hairline-subtle bg-surface px-4 lg:px-6">
        <div className="inline-flex rounded-lg bg-surface-muted p-1" aria-label="电商图类型">
          <RippleButton type="button" onClick={() => onTabChange("main")} className={`h-8 rounded-lg px-3 text-xs font-semibold ${tab === "main" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary"}`}>商品主图</RippleButton>
          <RippleButton type="button" onClick={() => onTabChange("detail")} className={`h-8 rounded-lg px-3 text-xs font-semibold ${tab === "detail" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary"}`}>商品详情图</RippleButton>
        </div>
        <button type="button" onClick={() => setIsOverviewOpen(true)} aria-expanded={isOverviewOpen} className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline px-3 text-xs font-semibold text-ink">
          <Icon icon="mdi:view-dashboard-outline" className="text-base" aria-hidden />生成概览
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto xl:overflow-hidden">
        {tab === "main"
          ? <EcomMainImageStudio token={token} shared={mainShared} controlsHeader={productControls} historyFooter={historyFooter} loadJob={loadMainJob} onActivity={onActivity} onBalanceRefresh={onBalanceRefresh} onDownloadImage={openDownload} />
          : <EcomWorkflowStudio token={token} shared={detailShared} controlsHeader={productControls} historyFooter={historyFooter} mainImages={mainImages} loadWorkflow={loadDetailWorkflow} onActivity={onActivity} onBalanceRefresh={onBalanceRefresh} onDownloadImage={openDownload} />}
      </div>

      {isOverviewOpen && (
        <div className="fixed inset-0 z-50 bg-scrim/20" onClick={() => setIsOverviewOpen(false)}>
          <aside role="dialog" aria-modal="true" aria-label="电商图生成概览" onClick={(event) => event.stopPropagation()} className="ml-auto flex h-full w-full flex-col bg-surface shadow-2xl sm:w-[320px]">
            <div className="flex h-16 items-center justify-between border-b border-hairline-subtle px-4">
              <div><p className="text-xs font-semibold text-ink-secondary">当前配置</p><h2 className="text-base font-semibold text-ink">生成概览</h2></div>
              <button type="button" onClick={() => setIsOverviewOpen(false)} aria-label="关闭生成概览" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-surface-muted"><Icon icon="mdi:close" className="text-xl" aria-hidden /></button>
            </div>
            <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4">
          <div className="rounded-[11px] border border-hairline-subtle bg-surface-subtle p-3">
            <p className="text-[11px] font-semibold text-ink-tertiary">当前视图</p>
            <p className="mt-1 text-sm font-semibold text-ink">{tab === "main" ? "商品主图" : "商品详情图"}</p>
          </div>
          <div className="rounded-[11px] border border-hairline-subtle bg-surface p-3">
            <p className="text-[11px] font-semibold text-ink-tertiary">平台</p>
            <p className="mt-1 truncate text-sm font-semibold text-ink">{platforms.find((p) => p.id === platformId)?.name ?? platformId}</p>
          </div>
          <div className="rounded-[11px] border border-hairline-subtle bg-surface p-3">
            <p className="text-[11px] font-semibold text-ink-tertiary">商品名称</p>
            <p className="mt-1 truncate text-sm font-semibold text-ink">{productName.trim() || "未填写"}</p>
          </div>
          <div className="rounded-[11px] border border-hairline-subtle bg-surface p-3">
            <p className="text-[11px] font-semibold text-ink-tertiary">商品类目</p>
            <p className="mt-1 truncate text-sm font-semibold text-ink">{effectiveCategory || "未选择"}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[11px] border border-hairline-subtle bg-surface p-3">
              <p className="text-[11px] font-semibold text-ink-tertiary">卖点</p>
              <p className="mt-1 text-sm font-semibold text-ink">{sellingPointsInput.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0).length} 条</p>
            </div>
            <div className="rounded-[11px] border border-hairline-subtle bg-surface p-3">
              <p className="text-[11px] font-semibold text-ink-tertiary">参考图</p>
              <p className="mt-1 text-sm font-semibold text-ink">{referenceAssets.length} 张</p>
            </div>
          </div>
          <p className="rounded-[11px] bg-brand-soft px-3 py-2 text-xs font-semibold text-brand-ink">
            主图与详情图共用产品资料，可在中间工作区设置生成参数。
          </p>
            </div>
          </aside>
        </div>
      )}

      {downloadDialog && <DownloadLinkDialog dialog={downloadDialog} onClose={() => setDownloadDialog(null)} />}
    </section>
  );
}
