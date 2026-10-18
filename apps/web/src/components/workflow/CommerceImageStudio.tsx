import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { useAuthGate } from "../../app/authGate";
import { InAppSelect } from "../ui/InAppSelect";
import { cx } from "../ui/cx";
import { SETTINGS_CONTROL, SETTINGS_TEXTAREA, SettingsField, SettingsGroup } from "./SettingsSlots";
import * as workflowEcomApi from "../../workflowEcomApi";
import type {
  WorkflowEcomImageAsset,
  WorkflowEcomPlatform,
  WorkflowEcomPlatformId,
  WorkflowEcomWorkflow,
} from "../../workflowEcomApi";
import {
  helpWriteEcom,
  getCurrentEcomMainJob,
  type EcomHelpWriteField,
  type EcomMainJob,
} from "../../workflowEcomMainApi";
import { DownloadLinkDialog, type DownloadDialogState } from "../ui/DownloadLinkDialog";
import {
  ECOM_MAX_REFERENCE_COUNT,
  FALLBACK_PLATFORMS,
  formatEcomError,
  readFileAsInlineImage,
} from "./ecomWorkflowStudioModel";
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

/** 「AI 帮我写」小按钮：卖点文案与额外说明各一颗，两处长得一样，抽出来只写一遍。 */
function HelpWriteButton({
  busy,
  disabled,
  onClick,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1 rounded-[10px] border border-brand/40 px-2 text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon icon={busy ? "mdi:loading" : "mdi:auto-fix"} className={busy ? "animate-spin" : ""} aria-hidden />
      {busy ? "生成中" : "AI 帮我写"}
    </button>
  );
}

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
  const { requireAuth } = useAuthGate();
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
  const [mainImages, setMainImages] = useState<readonly { readonly assetId: string; readonly thumbnailUrl: string }[]>(
    [],
  );
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const options = await workflowEcomApi.getWorkflowEcomOptions(token);
        if (options.platforms.length > 0) setPlatforms(options.platforms);
      } catch {
        /* 忽略：回落内置平台 */
      }
    })();
  }, [token]);

  useEffect(() => {
    if (tab !== "detail") return;
    void (async () => {
      try {
        const { job } = await getCurrentEcomMainJob(token);
        const ready = (job?.images ?? []).filter((i) => i.status === "ready" && i.assetId);
        setMainImages(
          ready.map((i) => ({ assetId: i.assetId as string, thumbnailUrl: i.thumbnailUrl ?? i.originalUrl ?? "" })),
        );
      } catch {
        setMainImages([]);
      }
    })();
  }, [tab, token]);

  const handleUpload = (file: File) => {
    if (!requireAuth()) return;
    if (referenceAssets.length >= ECOM_MAX_REFERENCE_COUNT) return;
    setUploadError("");
    setIsUploading(true);
    void (async () => {
      try {
        const inlineImage = await readFileAsInlineImage(file);
        const asset = await workflowEcomApi.createWorkflowEcomReference(token, inlineImage);
        setReferenceAssets((current) =>
          current.some((item) => item.id === asset.id)
            ? current
            : [...current, asset].slice(0, ECOM_MAX_REFERENCE_COUNT),
        );
      } catch (error) {
        setUploadError(formatEcomError(error, "上传参考图失败"));
      } finally {
        setIsUploading(false);
      }
    })();
  };

  const effectiveCategory = categoryChoice === CATEGORY_OTHER ? categoryOther.trim() : categoryChoice;

  const handleHelpWrite = (field: EcomHelpWriteField) => {
    if (!requireAuth()) return;
    if (helpWriting !== null) return;
    if (!productName.trim()) {
      setHelpWriteError("请先填写商品名称，再让 AI 帮我写");
      return;
    }
    setHelpWriteError("");
    setHelpWriting(field);
    void (async () => {
      try {
        const sellingPoints = sellingPointsInput
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        const { text } = await helpWriteEcom(token, {
          field,
          productName: productName.trim(),
          category: effectiveCategory,
          sellingPoints,
        });
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
      variant="rail"
      onSelectMain={onSelectMainHistory}
      onSelectDetail={onSelectDetailHistory}
    />
  );

  const productControls = (
    <SettingsGroup title="产品资料" hint="主图与详情图共用">
      <SettingsField label="平台">
        <InAppSelect
          icon="mdi:storefront-outline"
          label="平台"
          value={platformId}
          options={platforms.map((platform) => ({ value: platform.id, label: platform.name }))}
          onChange={(value) => setPlatformId(value as WorkflowEcomPlatformId)}
        />
      </SettingsField>
      <SettingsField label="商品名称">
        <input
          value={productName}
          onChange={(event) => setProductName(event.target.value)}
          className={SETTINGS_CONTROL}
        />
      </SettingsField>
      <SettingsField label="商品类目">
        <InAppSelect
          icon="mdi:shape-outline"
          label="商品类目"
          value={categoryChoice}
          options={CATEGORY_OPTIONS}
          onChange={setCategoryChoice}
        />
        {categoryChoice === CATEGORY_OTHER && (
          <input
            value={categoryOther}
            onChange={(event) => setCategoryOther(event.target.value)}
            placeholder="请填写商品类目"
            className={SETTINGS_CONTROL}
          />
        )}
      </SettingsField>
      <SettingsField
        label="卖点文案"
        hint={(
          <HelpWriteButton
            busy={helpWriting === "sellingPoints"}
            disabled={helpWriting !== null}
            onClick={() => handleHelpWrite("sellingPoints")}
          />
        )}
      >
        <textarea
          value={sellingPointsInput}
          onChange={(event) => setSellingPointsInput(event.target.value)}
          placeholder="一行一个卖点"
          className={cx(SETTINGS_TEXTAREA, "min-h-[88px]")}
        />
      </SettingsField>
      <SettingsField
        label="额外说明"
        hint={(
          <HelpWriteButton
            busy={helpWriting === "extra"}
            disabled={helpWriting !== null}
            onClick={() => handleHelpWrite("extra")}
          />
        )}
      >
        <textarea
          value={extra}
          onChange={(event) => setExtra(event.target.value)}
          className={cx(SETTINGS_TEXTAREA, "min-h-[72px]")}
        />
      </SettingsField>
      {helpWriteError && (
        <p className="rounded-[10px] bg-danger/10 px-3 py-2 text-xs text-danger-ink">{helpWriteError}</p>
      )}

      <SettingsField
        label={`参考图 (${referenceAssets.length}/${ECOM_MAX_REFERENCE_COUNT})`}
        hint={(
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || referenceAssets.length >= ECOM_MAX_REFERENCE_COUNT}
            className="inline-flex h-8 items-center gap-1 text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:text-ink-tertiary"
          >
            <Icon
              icon={isUploading ? "mdi:loading" : "mdi:plus"}
              className={isUploading ? "animate-spin" : ""}
              aria-hidden
            />
            {isUploading ? "上传中" : "上传"}
          </button>
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleUpload(file);
            event.currentTarget.value = "";
          }}
        />
        <div className="flex flex-wrap gap-2">
          {referenceAssets.map((asset) => (
            <img
              key={asset.id}
              src={asset.thumbnailUrl || asset.originalUrl}
              alt="参考图缩略图"
              className="h-14 w-14 rounded-[10px] border border-hairline object-cover"
            />
          ))}
          {referenceAssets.length === 0 && <p className="text-xs text-ink-tertiary">暂无参考图</p>}
        </div>
        {uploadError && <p className="rounded-[10px] bg-danger/10 px-3 py-2 text-xs text-danger-ink">{uploadError}</p>}
      </SettingsField>
    </SettingsGroup>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 二级切换（一级 tab「电商图」在页面顶栏下面）：主图 / 详情图 共用这一行，与生图场景 tab
          同款 —— 通栏、无底、只圈住按钮本身；「生成概览」是工作区的附属视图，靠右。 */}
      <div className="flex flex-none items-center gap-3 px-3.5 pt-3.5">
        <div role="group" aria-label="电商图类型" className="inline-flex gap-1">
          <RippleButton
            type="button"
            onClick={() => onTabChange("main")}
            className={`h-9 flex-none whitespace-nowrap rounded-[10px] px-4 text-sm font-medium ${tab === "main" ? "bg-surface text-ink" : "text-ink-secondary"}`}
          >
            商品主图
          </RippleButton>
          <RippleButton
            type="button"
            onClick={() => onTabChange("detail")}
            className={`h-9 flex-none whitespace-nowrap rounded-[10px] px-4 text-sm font-medium ${tab === "detail" ? "bg-surface text-ink" : "text-ink-secondary"}`}
          >
            商品详情图
          </RippleButton>
        </div>
        <button
          type="button"
          onClick={() => setIsOverviewOpen(true)}
          aria-expanded={isOverviewOpen}
          className="ml-auto inline-flex h-9 flex-none items-center gap-2 rounded-[10px] border border-hairline bg-surface px-3 text-xs font-semibold text-ink"
        >
          <Icon icon="mdi:view-dashboard-outline" className="text-base" aria-hidden />
          生成概览
        </button>
      </div>

      {/* 主图 / 详情图两个档位也走同一段依次入场（`wf-studio-in`：三个区 40ms 间隔）。
          这里的 DOM 是条件渲染（两个档位不同时挂载），所以 key 加不加都能重播；
          但给 key 更直白 —— 换档就是换一棵子树，旧树卸载、新树从 initial 起步。 */}
      {tab === "main" ? (
        <EcomMainImageStudio
          key="ecom-main"
          token={token}
          shared={mainShared}
          controlsHeader={productControls}
          historyFooter={historyFooter}
          loadJob={loadMainJob}
          onActivity={onActivity}
          onBalanceRefresh={onBalanceRefresh}
          onDownloadImage={openDownload}
        />
      ) : (
        <EcomWorkflowStudio
          key="ecom-detail"
          token={token}
          shared={detailShared}
          controlsHeader={productControls}
          historyFooter={historyFooter}
          mainImages={mainImages}
          loadWorkflow={loadDetailWorkflow}
          onActivity={onActivity}
          onBalanceRefresh={onBalanceRefresh}
          onDownloadImage={openDownload}
        />
      )}

      {isOverviewOpen && (
        <div className="fixed inset-0 z-50 bg-scrim/20" onClick={() => setIsOverviewOpen(false)}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="电商图生成概览"
            onClick={(event) => event.stopPropagation()}
            className="ml-auto flex h-full w-full flex-col bg-surface shadow-2xl sm:w-[320px]"
          >
            <div className="flex h-16 items-center justify-between border-b border-hairline-subtle px-4">
              <div>
                <p className="text-xs font-semibold text-ink-secondary">当前配置</p>
                <h2 className="text-base font-semibold text-ink">生成概览</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsOverviewOpen(false)}
                aria-label="关闭生成概览"
                className="grid h-9 w-9 place-items-center rounded-[10px] hover:bg-surface-muted"
              >
                <Icon icon="mdi:close" className="text-xl" aria-hidden />
              </button>
            </div>
            <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4">
              <div className="rounded-[10px] border border-hairline-subtle bg-surface-subtle p-3">
                <p className="text-xs font-semibold text-ink-tertiary">当前视图</p>
                <p className="mt-1 text-sm font-semibold text-ink">{tab === "main" ? "商品主图" : "商品详情图"}</p>
              </div>
              <div className="rounded-[10px] border border-hairline-subtle bg-surface p-3">
                <p className="text-xs font-semibold text-ink-tertiary">平台</p>
                <p className="mt-1 truncate text-sm font-semibold text-ink">
                  {platforms.find((p) => p.id === platformId)?.name ?? platformId}
                </p>
              </div>
              <div className="rounded-[10px] border border-hairline-subtle bg-surface p-3">
                <p className="text-xs font-semibold text-ink-tertiary">商品名称</p>
                <p className="mt-1 truncate text-sm font-semibold text-ink">{productName.trim() || "未填写"}</p>
              </div>
              <div className="rounded-[10px] border border-hairline-subtle bg-surface p-3">
                <p className="text-xs font-semibold text-ink-tertiary">商品类目</p>
                <p className="mt-1 truncate text-sm font-semibold text-ink">{effectiveCategory || "未选择"}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[10px] border border-hairline-subtle bg-surface p-3">
                  <p className="text-xs font-semibold text-ink-tertiary">卖点</p>
                  <p className="mt-1 text-sm font-semibold text-ink">
                    {
                      sellingPointsInput
                        .split(/\r?\n/)
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0).length
                    }{" "}
                    条
                  </p>
                </div>
                <div className="rounded-[10px] border border-hairline-subtle bg-surface p-3">
                  <p className="text-xs font-semibold text-ink-tertiary">参考图</p>
                  <p className="mt-1 text-sm font-semibold text-ink">{referenceAssets.length} 张</p>
                </div>
              </div>
              <p className="rounded-[10px] bg-brand-soft px-3 py-2 text-xs font-semibold text-brand-ink">
                主图与详情图共用产品资料，可在中间工作区设置生成参数。
              </p>
            </div>
          </aside>
        </div>
      )}

      {downloadDialog && <DownloadLinkDialog dialog={downloadDialog} onClose={() => setDownloadDialog(null)} />}
    </div>
  );
}
