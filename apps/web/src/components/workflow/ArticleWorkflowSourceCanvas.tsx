import type { ArticleWorkflowSourceFormat } from "@ai-assistant/article-workflow";
import {
  SETTINGS_SEGMENT,
  SETTINGS_SEGMENT_OFF,
  SETTINGS_SEGMENT_ON,
  SETTINGS_TEXTAREA,
  SettingsField,
} from "./SettingsSlots";
import { cx } from "../ui/cx";

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

/** 两个分支共用：格式切换的分段控件。 */
function SourceFormatSegment({
  value,
  onChange,
}: {
  readonly value: ArticleWorkflowSourceFormat;
  readonly onChange: (value: ArticleWorkflowSourceFormat) => void;
}) {
  return (
    <div className={cx(SETTINGS_SEGMENT, "grid-cols-2")}>
      {SOURCE_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
          className={cx(
            "h-8 border-r border-hairline-subtle px-3 text-xs last:border-r-0",
            value === option.key ? SETTINGS_SEGMENT_ON : SETTINGS_SEGMENT_OFF,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ArticleWorkflowSourceCanvas(props: ArticleWorkflowSourceCanvasProps) {
  if (props.compact) {
    return (
      <section className="grid gap-2" aria-label="原文内容">
        <SettingsField label="文章原文" htmlFor="article-source" hint={`${props.sourceText.trim().length} 字`}>
          <textarea
            id="article-source"
            aria-label="文章原文"
            value={props.sourceText}
            onChange={(event) => props.onSourceTextChange(event.target.value)}
            className={cx(SETTINGS_TEXTAREA, "min-h-[160px]")}
            placeholder={props.sourceFormat === "markdown" ? "粘贴 Markdown 内容" : "粘贴文章正文"}
          />
        </SettingsField>
        <SourceFormatSegment value={props.sourceFormat} onChange={props.onSourceFormatChange} />
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-[520px] flex-col bg-surface-subtle" aria-label="原文内容">
      <div className="flex h-12 flex-none items-center justify-between gap-3 border-b border-hairline-subtle bg-surface px-4 lg:px-5">
        <span className="text-xs text-ink-tertiary">{props.sourceText.trim().length} 字</span>
        <SourceFormatSegment value={props.sourceFormat} onChange={props.onSourceFormatChange} />
      </div>

      <div className="flex min-h-0 flex-1 p-4 lg:p-5">
        <textarea
          aria-label="文章原文"
          value={props.sourceText}
          onChange={(event) => props.onSourceTextChange(event.target.value)}
          className="h-full min-h-[420px] w-full resize-none overflow-y-auto rounded-[10px] border border-hairline bg-surface px-5 py-4 text-sm leading-7 text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/10"
          placeholder={props.sourceFormat === "markdown" ? "粘贴 Markdown 内容" : "粘贴文章正文"}
        />
      </div>
    </section>
  );
}
