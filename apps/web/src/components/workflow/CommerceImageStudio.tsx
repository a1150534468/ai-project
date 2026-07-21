import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { InAppSelect } from "../agent-teams/InAppSelect";
import * as workflowEcomApi from "../../workflowEcomApi";
import type { WorkflowEcomImageAsset, WorkflowEcomPlatform, WorkflowEcomPlatformId, WorkflowEcomWorkflow } from "../../workflowEcomApi";
import { helpWriteEcom, getCurrentEcomMainJob, listEcomMainHistory, type EcomHelpWriteField, type EcomMainJob } from "../../workflowEcomMainApi";
import { DownloadLinkDialog, type DownloadDialogState } from "../ui/DownloadLinkDialog";
import { ECOM_MAX_REFERENCE_COUNT, FALLBACK_PLATFORMS, formatEcomError, readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import { EcomWorkflowStudio } from "./EcomWorkflowStudio";
import { EcomMainImageStudio } from "./EcomMainImageStudio";

interface CommerceImageStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
  readonly tab: "main" | "detail";
  readonly onTabChange: (tab: "main" | "detail") => void;
  readonly loadMainJob?: EcomMainJob | null;
  readonly loadDetailWorkflow?: WorkflowEcomWorkflow | null;
  readonly onActivity?: () => void;
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

  return (
    <div className="grid min-w-0 gap-5">
        <section className="rounded-[14px] border border-[#d2d2d7] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <h2 className="text-[18px] font-semibold text-[#1d1d1f]">产品资料</h2>
        <p className="mt-1 text-sm text-[#6e6e73]">填一次，主图与详情图共用。</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            平台
            <InAppSelect icon="mdi:storefront-outline" label="平台" value={platformId} options={platforms.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => setPlatformId(v as WorkflowEcomPlatformId)} />
          </div>
          <label className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            商品名称
            <input value={productName} onChange={(e) => setProductName(e.target.value)} className="h-11 rounded-[10px] border border-[#d2d2d7] px-3 text-sm text-[#1d1d1f]" />
          </label>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f]">
            商品类目
            <InAppSelect icon="mdi:shape-outline" label="商品类目" value={categoryChoice} options={CATEGORY_OPTIONS} onChange={setCategoryChoice} />
            {categoryChoice === CATEGORY_OTHER && (
              <input value={categoryOther} onChange={(e) => setCategoryOther(e.target.value)} placeholder="请填写商品类目" className="h-11 rounded-[10px] border border-[#d2d2d7] px-3 text-sm font-normal text-[#1d1d1f]" />
            )}
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f] sm:col-span-2">
            <div className="flex items-center justify-between">
              <span>卖点文案</span>
              <button type="button" onClick={() => handleHelpWrite("sellingPoints")} disabled={helpWriting !== null} className="flex items-center gap-1 rounded-[8px] border border-brand/40 px-2 py-1 text-xs font-semibold text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-50">
                <Icon icon={helpWriting === "sellingPoints" ? "mdi:loading" : "mdi:auto-fix"} className={helpWriting === "sellingPoints" ? "animate-spin" : ""} aria-hidden />
                {helpWriting === "sellingPoints" ? "生成中…" : "AI 帮我写"}
              </button>
            </div>
            <textarea value={sellingPointsInput} onChange={(e) => setSellingPointsInput(e.target.value)} placeholder="一行一个卖点" className="min-h-[96px] rounded-[10px] border border-[#d2d2d7] p-3 text-sm font-normal leading-6 text-[#1d1d1f]" />
          </div>
          <div className="grid gap-2 text-sm font-semibold text-[#1d1d1f] sm:col-span-2">
            <div className="flex items-center justify-between">
              <span>额外说明</span>
              <button type="button" onClick={() => handleHelpWrite("extra")} disabled={helpWriting !== null} className="flex items-center gap-1 rounded-[8px] border border-brand/40 px-2 py-1 text-xs font-semibold text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-50">
                <Icon icon={helpWriting === "extra" ? "mdi:loading" : "mdi:auto-fix"} className={helpWriting === "extra" ? "animate-spin" : ""} aria-hidden />
                {helpWriting === "extra" ? "生成中…" : "AI 帮我写"}
              </button>
            </div>
            <textarea value={extra} onChange={(e) => setExtra(e.target.value)} className="min-h-[72px] rounded-[10px] border border-[#d2d2d7] p-3 text-sm font-normal leading-6 text-[#1d1d1f]" />
          </div>
        </div>
        {helpWriteError && <p className="mt-2 rounded-[8px] bg-red-50 px-3 py-2 text-xs text-red-700">{helpWriteError}</p>}

        <div className="mt-4 rounded-[10px] border border-[#e8e8ed] bg-[#f7faf9] p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[#1d1d1f]">参考图 ({referenceAssets.length}/{ECOM_MAX_REFERENCE_COUNT})</p>
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading || referenceAssets.length >= ECOM_MAX_REFERENCE_COUNT} className="h-10 rounded-[10px] border border-dashed border-[#d2d2d7] px-3 text-sm font-semibold text-[#1d1d1f] disabled:cursor-not-allowed disabled:text-[#8a8a8f]">
              {isUploading ? "上传中" : "上传参考图"}
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) handleUpload(file); e.currentTarget.value = ""; }} />
          <div className="mt-3 flex flex-wrap gap-2">
            {referenceAssets.map((asset) => (
              <img key={asset.id} src={asset.thumbnailUrl || asset.originalUrl} alt="参考图缩略图" className="h-16 w-16 rounded-[8px] border border-[#d2d2d7] object-cover" />
            ))}
            {referenceAssets.length === 0 && <div className="rounded-[8px] border border-dashed border-[#d2d2d7] px-3 py-4 text-xs text-[#8a8a8f]">上传后会展示本地缩略图。</div>}
          </div>
          {uploadError && <p className="mt-2 rounded-[8px] bg-red-50 px-3 py-2 text-xs text-red-700">{uploadError}</p>}
        </div>
      </section>

      <div className="flex gap-2">
        <RippleButton type="button" onClick={() => onTabChange("main")} className={`h-10 rounded-[10px] px-4 text-sm font-semibold ${tab === "main" ? "bg-brand text-white" : "border border-[#d2d2d7] text-[#1d1d1f]"}`}>商品主图</RippleButton>
        <RippleButton type="button" onClick={() => onTabChange("detail")} className={`h-10 rounded-[10px] px-4 text-sm font-semibold ${tab === "detail" ? "bg-brand text-white" : "border border-[#d2d2d7] text-[#1d1d1f]"}`}>商品详情图</RippleButton>
      </div>

        {tab === "main"
          ? <EcomMainImageStudio token={token} shared={mainShared} loadJob={loadMainJob} onActivity={onActivity} onBalanceRefresh={onBalanceRefresh} onDownloadImage={openDownload} />
          : <EcomWorkflowStudio token={token} shared={detailShared} mainImages={mainImages} loadWorkflow={loadDetailWorkflow} onActivity={onActivity} onBalanceRefresh={onBalanceRefresh} onDownloadImage={openDownload} />}

        {downloadDialog && <DownloadLinkDialog dialog={downloadDialog} onClose={() => setDownloadDialog(null)} />}
    </div>
  );
}
