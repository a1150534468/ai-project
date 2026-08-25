import { useState } from "react";
import { Icon } from "@iconify/react";
import type { WorkflowImageAsset } from "../../api";

interface ImageCompareViewProps {
  readonly originalImage?: WorkflowImageAsset | null;
  readonly newImage?: WorkflowImageAsset | null;
  readonly onSetCurrent: (image: WorkflowImageAsset) => void;
  readonly onContinueModify: (image: WorkflowImageAsset) => void;
  readonly onDownload: (image: WorkflowImageAsset) => void;
}

function ComparePane({ label, image, missingText }: { readonly label: string; readonly image?: WorkflowImageAsset | null; readonly missingText: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded-full bg-surface-inverse px-2 py-1 text-xs font-semibold text-ink-inverse">{label}</span>
        {image && <span className="truncate text-xs text-ink-tertiary">{image.size}</span>}
      </div>
      {image ? (
        <div className="grid min-h-[300px] place-items-center overflow-hidden rounded-lg bg-surface-muted">
          <img src={image.originalUrl} alt={`${label} ${image.prompt}`} className="max-h-[56vh] w-full object-contain" />
        </div>
      ) : (
        <div className="grid min-h-[300px] place-items-center rounded-lg border border-dashed border-hairline bg-surface-subtle p-6 text-center text-sm font-semibold text-ink-secondary">
          <span><Icon icon="mdi:image-off-outline" className="mx-auto mb-2 text-3xl" aria-hidden />{missingText}</span>
        </div>
      )}
      <div className="mt-3">
        <p className="text-xs font-semibold text-ink-tertiary">{label === "V1 原图" ? "原始提示词" : "新提示词"}</p>
        <p className="mt-1 text-sm leading-6 text-ink">{image?.prompt ?? "--"}</p>
      </div>
    </div>
  );
}

export function ImageCompareView(props: ImageCompareViewProps) {
  const [mobileVersion, setMobileVersion] = useState<"original" | "new">("new");
  const mobileImage = mobileVersion === "original" ? props.originalImage : props.newImage;

  return (
    <section className="flex h-full min-h-[420px] flex-col bg-white px-4 py-4 lg:px-6" aria-label="版本对比">
      <div className="mb-4">
        <p className="text-xs font-semibold text-ink-secondary">版本对比</p>
        <h2 className="mt-1 text-base font-semibold text-ink">选择更符合预期的结果</h2>
      </div>

      <div className="mb-3 grid grid-cols-2 rounded-lg bg-surface-muted p-1 md:hidden">
        <button type="button" onClick={() => setMobileVersion("original")} className={`h-9 rounded-lg text-sm font-semibold ${mobileVersion === "original" ? "bg-white shadow-sm" : "text-ink-secondary"}`}>原图</button>
        <button type="button" onClick={() => setMobileVersion("new")} className={`h-9 rounded-lg text-sm font-semibold ${mobileVersion === "new" ? "bg-white shadow-sm" : "text-ink-secondary"}`}>新版本</button>
      </div>
      <div className="md:hidden">
        <ComparePane label={mobileVersion === "original" ? "V1 原图" : "V2 新版本"} image={mobileImage} missingText="原始图片已不在最近历史中" />
      </div>
      <div className="hidden min-h-0 flex-1 grid-cols-2 gap-5 md:grid">
        <ComparePane label="V1 原图" image={props.originalImage} missingText="原始图片已不在最近历史中" />
        <ComparePane label="V2 新版本" image={props.newImage} missingText="新版本暂不可用" />
      </div>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-hairline-subtle pt-3">
        {props.newImage && (
          <>
            <button type="button" onClick={() => props.onSetCurrent(props.newImage!)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-surface-inverse px-3 text-sm font-semibold text-ink-inverse">
              <Icon icon="mdi:check" className="text-base" aria-hidden />设为当前版本
            </button>
            <button type="button" onClick={() => props.onContinueModify(props.newImage!)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline px-3 text-sm font-semibold text-ink">
              <Icon icon="mdi:source-branch" className="text-base" aria-hidden />继续修改
            </button>
          </>
        )}
        {props.originalImage && <button type="button" onClick={() => props.onDownload(props.originalImage!)} className="h-9 rounded-lg border border-hairline px-3 text-sm font-semibold text-ink">下载 V1</button>}
        {props.newImage && <button type="button" onClick={() => props.onDownload(props.newImage!)} className="h-9 rounded-lg border border-hairline px-3 text-sm font-semibold text-ink">下载 V2</button>}
      </div>
    </section>
  );
}
