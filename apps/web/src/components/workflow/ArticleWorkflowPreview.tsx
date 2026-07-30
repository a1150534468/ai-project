import type { RefObject } from "react";

interface ArticleWorkflowPreviewProps {
  readonly title: string;
  readonly summary: string;
  readonly previewHtml: string;
  readonly previewBodyRef: RefObject<HTMLDivElement | null>;
}

export function ArticleWorkflowPreview({
  title,
  summary,
  previewHtml,
  previewBodyRef,
}: ArticleWorkflowPreviewProps) {
  return (
    <section className="min-h-[640px] bg-[#f7f8fa] px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-[760px] bg-white px-5 py-6">
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
