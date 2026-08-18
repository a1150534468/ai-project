import { Icon } from "@iconify/react";
import { useState, type ReactNode, type RefObject } from "react";

export type ArticleWorkflowPreviewScale = "full" | "desktop" | "mobile";

const SCALE_OPTIONS: readonly {
  readonly key: ArticleWorkflowPreviewScale;
  readonly icon: string;
  readonly label: string;
}[] = [
  { key: "full", icon: "mdi:monitor-screenshot", label: "满屏" },
  { key: "desktop", icon: "mdi:laptop", label: "桌面" },
  { key: "mobile", icon: "mdi:cellphone", label: "手机" },
];

/** 三档预览宽度。必须返回完整静态 class，Tailwind 无法动态拼接。 */
export function previewScaleWidthClass(scale: ArticleWorkflowPreviewScale): string {
  if (scale === "mobile") return "max-w-[375px]";
  if (scale === "desktop") return "max-w-[640px]";
  return "max-w-[760px]";
}

/** 三档比例切换，公众号预览与 caption 预览共用同一套。 */
export function ArticleWorkflowPreviewScaleToggle(props: {
  readonly scale: ArticleWorkflowPreviewScale;
  readonly onChange: (scale: ArticleWorkflowPreviewScale) => void;
}) {
  return (
    <div className="inline-grid grid-cols-3 rounded-lg bg-[#ececf0] p-1" role="tablist" aria-label="预览比例">
      {SCALE_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={props.scale === option.key}
          title={option.label}
          aria-label={option.label}
          onClick={() => props.onChange(option.key)}
          className={`flex h-8 w-10 items-center justify-center rounded-md transition ${
            props.scale === option.key ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73]"
          }`}
        >
          <Icon icon={option.icon} className="text-base" aria-hidden />
        </button>
      ))}
    </div>
  );
}

interface ArticleWorkflowPreviewProps {
  readonly title: string;
  readonly summary: string;
  readonly previewHtml: string;
  readonly previewBodyRef: RefObject<HTMLDivElement | null>;
  /** 预览区顶部的额外控件（如主题换肤条），渲染在比例切换左侧 */
  readonly headerExtra?: ReactNode;
}

export function ArticleWorkflowPreview({
  title,
  summary,
  previewHtml,
  previewBodyRef,
  headerExtra,
}: ArticleWorkflowPreviewProps) {
  const [scale, setScale] = useState<ArticleWorkflowPreviewScale>("full");
  const mobile = scale === "mobile";

  return (
    <section className="min-h-[640px] bg-[#f7f8fa] px-4 py-5 sm:px-6">
      <div className="mx-auto mb-4 flex max-w-[760px] items-center justify-between gap-3">
        {headerExtra}
        <ArticleWorkflowPreviewScaleToggle scale={scale} onChange={setScale} />
      </div>
      <div
        className={`mx-auto bg-white ${previewScaleWidthClass(scale)} ${
          mobile ? "overflow-hidden rounded-[32px] border-[8px] border-[#1d1d1f] px-4 py-4" : "px-5 py-6"
        }`}
      >
        {mobile && <div className="mx-auto mb-4 h-1.5 w-16 rounded-full bg-[#d2d2d7]" aria-hidden />}
        <header className="mb-6 border-b border-[#ececf0] pb-5">
          <h1 className="text-[24px] font-semibold leading-[1.4] text-[#1d1d1f]">{title || "未命名图文"}</h1>
          {summary && <p className="mt-2 text-sm leading-6 text-[#6e6e73]">{summary}</p>}
        </header>
        <div
          ref={previewBodyRef}
          className="article-workflow-preview-body"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>
    </section>
  );
}
