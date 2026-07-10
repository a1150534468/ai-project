import type { RefObject } from "react";

interface ArticleWorkflowPreviewProps {
  readonly previewHtml: string;
  readonly previewBodyRef: RefObject<HTMLDivElement | null>;
}

export function ArticleWorkflowPreview({
  previewHtml,
  previewBodyRef,
}: ArticleWorkflowPreviewProps) {
  return (
    <section className="min-h-[640px] bg-[#f7f8fb] px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-[760px] rounded-[20px] border border-[#e7ebf2] bg-white px-5 py-6 shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
        <div
          ref={previewBodyRef}
          className="article-workflow-preview-body"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>
    </section>
  );
}
