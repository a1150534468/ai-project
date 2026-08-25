import type { ArticleWorkflowSourceFormat } from "@ai-assistant/article-workflow";

interface ArticleWorkflowSourceCanvasProps {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly onSourceFormatChange: (value: ArticleWorkflowSourceFormat) => void;
  readonly onSourceTextChange: (value: string) => void;
  readonly compact?: boolean;
}

const SOURCE_OPTIONS: readonly { key: ArticleWorkflowSourceFormat; label: string }[] = [
  { key: "plain-text", label: "纯文本" },
  { key: "markdown", label: "Markdown" },
];

export function ArticleWorkflowSourceCanvas(props: ArticleWorkflowSourceCanvasProps) {
  if (props.compact) {
    return (
      <section className="grid gap-2" aria-label="原文内容">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] text-ink-tertiary">{props.sourceText.trim().length} 字</span>
          <div className="grid grid-cols-2 rounded-lg bg-surface-muted p-1">
            {SOURCE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={props.sourceFormat === option.key}
                onClick={() => props.onSourceFormatChange(option.key)}
                className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                  props.sourceFormat === option.key
                    ? "bg-white text-ink shadow-sm"
                    : "text-ink-secondary"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          aria-label="文章原文"
          value={props.sourceText}
          onChange={(event) => props.onSourceTextChange(event.target.value)}
          className="min-h-[160px] w-full resize-y rounded-lg border border-hairline bg-white px-3.5 py-3 text-sm leading-6 text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/10"
          placeholder={props.sourceFormat === "markdown" ? "粘贴 Markdown 内容" : "粘贴文章正文"}
        />
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-[520px] flex-col bg-surface-subtle" aria-label="原文内容">
      <div className="flex h-12 flex-none items-center justify-between gap-3 border-b border-hairline-subtle bg-white px-4 lg:px-5">
        <span className="text-xs text-ink-tertiary">{props.sourceText.trim().length} 字</span>
        <div className="grid grid-cols-2 rounded-lg bg-surface-muted p-1">
          {SOURCE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={props.sourceFormat === option.key}
              onClick={() => props.onSourceFormatChange(option.key)}
              className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                props.sourceFormat === option.key
                  ? "bg-white text-ink shadow-sm"
                  : "text-ink-secondary"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 p-4 lg:p-5">
        <textarea
          aria-label="文章原文"
          value={props.sourceText}
          onChange={(event) => props.onSourceTextChange(event.target.value)}
          className="h-full min-h-[420px] w-full resize-none overflow-y-auto rounded-lg border border-hairline bg-white px-5 py-4 text-sm leading-7 text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/10"
          placeholder={props.sourceFormat === "markdown" ? "粘贴 Markdown 内容" : "粘贴文章正文"}
        />
      </div>
    </section>
  );
}
