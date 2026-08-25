import type { ArticleWorkflowPlatformConfig } from "@ai-assistant/article-workflow";
import { useState } from "react";
import { articleWorkflowTagsText } from "./articleWorkflowCopyActions";

interface ArticleWorkflowCaptionEditorProps {
  readonly captionDraft: string;
  readonly tagsDraft: readonly string[];
  readonly syncKey: string;
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  readonly onCaptionChange: (value: string) => void;
  readonly onTagsChange: (value: readonly string[]) => void;
}

/** 标签输入按空格 / 逗号 / 顿号 / 换行切分，`#` 只是展示前缀不入库 */
export function parseArticleWorkflowTagsInput(value: string): readonly string[] {
  return value
    .split(/[\s,，、\n]+/)
    .map((tag) => tag.replace(/^#+/, "").trim())
    .filter(Boolean);
}

export function ArticleWorkflowCaptionEditor(props: ArticleWorkflowCaptionEditorProps) {
  // 标签输入保留用户原始文本；只在换项目/换平台时回填，否则打字会被解析结果打断
  const [syncedKey, setSyncedKey] = useState(props.syncKey);
  const [tagsText, setTagsText] = useState(() => articleWorkflowTagsText(props.tagsDraft));
  if (syncedKey !== props.syncKey) {
    setSyncedKey(props.syncKey);
    setTagsText(articleWorkflowTagsText(props.tagsDraft));
  }

  const captionLength = props.captionDraft.trim().length;
  const captionMax = props.platformConfig.captionMaxLength;
  // 超限只标红提示，不拦保存：平台上限是软约束，用户自己删更合适
  const captionOver = captionMax > 0 && captionLength > captionMax;
  const tagsOver = props.tagsDraft.length > props.platformConfig.maxTags;
  const tagsShort = props.tagsDraft.length < props.platformConfig.minTags;

  return (
    <div className="grid gap-5 px-5 py-5 sm:px-6">
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="article-caption-text" className="text-sm font-semibold text-ink">正文文案</label>
          <span className={`text-xs ${captionOver ? "font-semibold text-red-600" : "text-ink-tertiary"}`}>
            {captionLength}{captionMax > 0 ? ` / ${captionMax}` : ""} 字
          </span>
        </div>
        <textarea
          id="article-caption-text"
          value={props.captionDraft}
          onChange={(event) => props.onCaptionChange(event.target.value)}
          rows={14}
          className="min-h-[320px] w-full resize-none whitespace-pre-wrap rounded-lg border border-hairline bg-[#f7f8fa] px-4 py-3 text-sm leading-7 text-ink outline-none transition focus:border-brand focus:bg-white"
          placeholder="输入正文文案，换行会原样保留"
        />
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="article-caption-tags" className="text-sm font-semibold text-ink">标签</label>
          <span className={`text-xs ${tagsOver || tagsShort ? "font-semibold text-red-600" : "text-ink-tertiary"}`}>
            {props.tagsDraft.length} / {props.platformConfig.minTags}-{props.platformConfig.maxTags} 个
          </span>
        </div>
        <input
          id="article-caption-tags"
          value={tagsText}
          onChange={(event) => {
            setTagsText(event.target.value);
            props.onTagsChange(parseArticleWorkflowTagsInput(event.target.value));
          }}
          className="w-full rounded-lg border border-hairline bg-[#f7f8fa] px-4 py-3 text-sm leading-6 text-ink outline-none transition focus:border-brand focus:bg-white"
          placeholder="#咖啡机 #居家好物（空格或逗号分隔）"
        />
        {props.tagsDraft.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {props.tagsDraft.map((tag) => (
              <span key={tag} className="rounded-md bg-brand-soft px-2.5 py-1 text-[11px] font-semibold text-brand-ink">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
