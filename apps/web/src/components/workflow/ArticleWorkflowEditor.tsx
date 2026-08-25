import { Icon } from "@iconify/react";
import type {
  ArticleWorkflowGalleryMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowPlatformConfig,
  ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { useEffect, useRef, useState, type RefObject } from "react";
import { RippleButton } from "../../motion";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import { ArticleWorkflowCaptionEditor } from "./ArticleWorkflowCaptionEditor";
import { ArticleWorkflowPreviewThemeBar } from "./ArticleWorkflowPreviewThemeBar";
import {
  ArticleWorkflowPreview,
  ArticleWorkflowPreviewScaleToggle,
  previewScaleWidthClass,
  type ArticleWorkflowPreviewScale,
} from "./ArticleWorkflowPreview";
import { ArticleWorkflowRichEditor } from "./ArticleWorkflowRichEditor";
import { renderArticleWorkflowLocalPreview } from "./articleWorkflowLocalPreview";
import { formatArticleWorkflowStatus, formatArticleWorkflowTime } from "./articleWorkflowStudioModel";

interface ArticleWorkflowEditorProps {
  readonly project: ArticleWorkflowProject;
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  readonly titleDraft: string;
  readonly summaryDraft: string;
  readonly bodyHtmlDraft: string;
  readonly captionDraft: string;
  readonly tagsDraft: readonly string[];
  readonly editorSyncKey: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly previewBodyRef: RefObject<HTMLDivElement | null>;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly bodyMarkdown: string;
  readonly theme: ArticleWorkflowThemeKey;
  readonly themeColor: string | null;
  readonly galleryMode: ArticleWorkflowGalleryMode;
  readonly previewTheme: ArticleWorkflowThemeKey | null;
  readonly previewThemeColor: string | null;
  readonly previewGalleryMode: ArticleWorkflowGalleryMode | null;
  readonly applyingTheme: boolean;
  readonly onTitleChange: (value: string) => void;
  readonly onSummaryChange: (value: string) => void;
  readonly onBodyHtmlChange: (value: string) => void;
  readonly onBodyBlur: (value: string) => void;
  readonly onCaptionChange: (value: string) => void;
  readonly onTagsChange: (value: readonly string[]) => void;
  readonly onPreviewTheme: (theme: ArticleWorkflowThemeKey) => void;
  readonly onPreviewThemeColor: (color: string) => void;
  readonly onPreviewGalleryMode: (mode: ArticleWorkflowGalleryMode) => void;
  readonly onResetPreviewTheme: () => void;
  readonly onApplyTheme: () => void;
  readonly onSave: () => void;
  readonly onCopyBody: () => void;
  readonly onCopyTitle: () => void;
  readonly onCopySummary: () => void;
  readonly onCopyCaption: () => void;
  readonly onCopyTags: () => void;
}

type CanvasMode = "edit" | "preview" | "split";

const CANVAS_MODES: readonly { key: CanvasMode; label: string }[] = [
  { key: "preview", label: "预览" },
  { key: "edit", label: "编辑" },
  { key: "split", label: "对照" },
];

export function ArticleWorkflowEditor(props: ArticleWorkflowEditorProps) {
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("preview");
  const [previewScale, setPreviewScale] = useState<ArticleWorkflowPreviewScale>("full");
  const captionPlatform = props.platformConfig.outputKind === "caption";
  const titleOver = props.titleDraft.trim().length > props.platformConfig.titleMaxLength;

  // 确定性主题换肤：正文 Markdown 非空时用本地渲染，预览即时换肤零延迟；
  // auto 主题（bodyMarkdown 为空）或渲染结果为 null 时回落到后端已落库的 bodyHtml。
  const effectivePreviewTheme = props.previewTheme ?? props.theme;
  const effectivePreviewThemeColor = props.previewThemeColor ?? props.themeColor;
  const effectivePreviewGalleryMode = props.previewGalleryMode ?? props.galleryMode;
  const localPreviewHtml =
    !captionPlatform && props.bodyMarkdown.trim()
      ? renderArticleWorkflowLocalPreview({
          bodyMarkdown: props.bodyMarkdown,
          imageManifest: props.imageManifest,
          theme: effectivePreviewTheme,
          themeColor: effectivePreviewThemeColor,
          galleryMode: effectivePreviewGalleryMode,
        })
      : null;
  const previewHtml = localPreviewHtml ?? props.bodyHtmlDraft;

  /** 对照模式的两个滚动容器，编辑驱动预览做比例同步 */
  const editScrollRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    setCanvasMode("preview");
  }, [props.project.id]);

  const syncPreviewScroll = () => {
    const editor = editScrollRef.current;
    const preview = previewScrollRef.current;
    if (!editor || !preview || syncingRef.current) return;
    const editorMax = editor.scrollHeight - editor.clientHeight;
    const previewMax = preview.scrollHeight - preview.clientHeight;
    if (editorMax <= 0 || previewMax <= 0) return;
    syncingRef.current = true;
    preview.scrollTop = (editor.scrollTop / editorMax) * previewMax;
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  };

  const editorHeader = (
    <div className="border-b border-hairline-subtle px-5 py-4 sm:px-6">
      <div className="grid gap-4">
        <div className="grid gap-1">
          <input
            aria-label="图文标题"
            value={props.titleDraft}
            onChange={(event) => props.onTitleChange(event.target.value)}
            className="w-full border-0 bg-transparent p-0 text-[24px] font-semibold leading-[1.35] text-ink outline-none placeholder:text-ink-tertiary focus:shadow-none"
            placeholder="输入标题"
          />
          <span className={`text-xs ${titleOver ? "font-semibold text-danger-ink" : "text-ink-tertiary"}`}>
            标题 {props.titleDraft.trim().length} / {props.platformConfig.titleMaxLength} 字
          </span>
        </div>
        {!captionPlatform && (
          <textarea
            aria-label="图文摘要"
            value={props.summaryDraft}
            onChange={(event) => props.onSummaryChange(event.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-hairline bg-surface-subtle px-4 py-3 text-sm leading-6 text-ink outline-none focus:border-brand focus:bg-surface"
            placeholder="输入摘要"
          />
        )}
      </div>
    </div>
  );

  const editorBody = captionPlatform ? (
    <ArticleWorkflowCaptionEditor
      captionDraft={props.captionDraft}
      tagsDraft={props.tagsDraft}
      syncKey={props.editorSyncKey}
      platformConfig={props.platformConfig}
      onCaptionChange={props.onCaptionChange}
      onTagsChange={props.onTagsChange}
    />
  ) : (
    <ArticleWorkflowRichEditor
      value={props.bodyHtmlDraft}
      syncKey={props.editorSyncKey}
      placeholder="开始编辑正文"
      onChange={props.onBodyHtmlChange}
      onBlurCommit={props.onBodyBlur}
    />
  );

  const previewContent = captionPlatform ? (
    <section className="min-h-[640px] bg-surface-subtle px-4 py-5 sm:px-6">
      <div className="mx-auto mb-4 flex max-w-[760px] justify-end">
        <ArticleWorkflowPreviewScaleToggle scale={previewScale} onChange={setPreviewScale} />
      </div>
      <article
        className={`mx-auto bg-surface ${previewScaleWidthClass(previewScale)} ${
          previewScale === "mobile"
            ? "overflow-hidden rounded-[32px] border-[8px] border-ink px-4 py-4"
            : "px-5 py-6"
        }`}
      >
        {previewScale === "mobile" && <div className="mx-auto mb-4 h-1.5 w-16 rounded-full bg-hairline" aria-hidden />}
        <h1 className="text-[24px] font-semibold leading-[1.4] text-ink">{props.titleDraft || "未命名图文"}</h1>
        <p className="mt-5 whitespace-pre-wrap text-[15px] leading-7 text-ink">{props.captionDraft}</p>
        {props.tagsDraft.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2">
            {props.tagsDraft.map((tag) => (
              <span key={tag} className="text-sm font-semibold text-brand-ink">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </article>
    </section>
  ) : (
    <ArticleWorkflowPreview
      title={props.titleDraft}
      summary={props.summaryDraft}
      previewHtml={previewHtml}
      previewBodyRef={props.previewBodyRef}
      headerExtra={
        props.bodyMarkdown.trim() ? (
          <ArticleWorkflowPreviewThemeBar
            projectTheme={props.theme}
            projectThemeColor={props.themeColor}
            projectGalleryMode={props.galleryMode}
            previewTheme={props.previewTheme}
            previewThemeColor={props.previewThemeColor}
            previewGalleryMode={props.previewGalleryMode}
            applying={props.applyingTheme}
            onPreviewTheme={props.onPreviewTheme}
            onPreviewThemeColor={props.onPreviewThemeColor}
            onPreviewGalleryMode={props.onPreviewGalleryMode}
            onReset={props.onResetPreviewTheme}
            onApply={props.onApplyTheme}
          />
        ) : undefined
      }
    />
  );

  return (
    <section className="flex min-h-full flex-col bg-surface-subtle">
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-hairline-subtle bg-surface/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden min-w-0 sm:block">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-surface-muted px-2 py-1 text-[11px] font-semibold text-ink-secondary">
                {formatArticleWorkflowStatus(props.project.status)}
              </span>
              {props.saving && (
                <span className="rounded-md bg-info/10 px-2 py-1 text-[11px] font-semibold text-info">
                  保存中
                </span>
              )}
              {!props.saving && props.dirty && (
                <span className="rounded-md bg-warning/10 px-2 py-1 text-[11px] font-semibold text-warning">
                  待保存
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-xs text-ink-tertiary">
              最近更新 {formatArticleWorkflowTime(props.project.updatedAt)}
            </p>
          </div>
          <div className="inline-grid shrink-0 grid-cols-3 rounded-lg bg-surface-muted p-1">
            {CANVAS_MODES.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={canvasMode === item.key}
                onClick={() => setCanvasMode(item.key)}
                className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                  canvasMode === item.key ? "bg-surface text-ink shadow-sm" : "text-ink-secondary"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <RippleButton
            type="button"
            onClick={props.onSave}
            disabled={!props.canSave}
            className="flex h-9 items-center gap-2 rounded-lg bg-brand px-3.5 text-sm font-semibold text-white disabled:bg-brand/40"
          >
            <Icon
              icon={props.saving ? "mdi:loading" : "mdi:content-save-outline"}
              className={props.saving ? "animate-spin" : ""}
              aria-hidden
            />
            {props.saving ? "保存中" : "保存修改"}
          </RippleButton>

          <details className="group relative">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border border-hairline bg-surface px-3.5 text-sm font-semibold text-ink marker:content-none">
              <Icon icon="mdi:content-copy" className="text-base" aria-hidden />
              复制
              <Icon icon="mdi:chevron-down" className="text-base transition group-open:rotate-180" aria-hidden />
            </summary>
            <div className="absolute right-0 top-11 z-20 grid w-52 overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-lg">
              {captionPlatform ? (
                <>
                  <button
                    type="button"
                    onClick={props.onCopyCaption}
                    className="rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    复制文案
                  </button>
                  <button
                    type="button"
                    onClick={props.onCopyTags}
                    className="rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    复制标签
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={props.onCopyBody}
                    className="rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    一键复制到公众号
                  </button>
                  <button
                    type="button"
                    onClick={props.onCopySummary}
                    className="rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    复制摘要
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={props.onCopyTitle}
                className="rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
              >
                复制标题
              </button>
            </div>
          </details>
        </div>
      </div>

      {canvasMode === "split" ? (
        <div className="grid h-[72vh] min-h-[560px] grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-hairline-subtle">
          <div ref={editScrollRef} onScroll={syncPreviewScroll} className="min-h-0 overflow-y-auto bg-surface">
            {editorHeader}
            {editorBody}
          </div>
          <div ref={previewScrollRef} className="min-h-0 overflow-y-auto bg-surface-subtle">
            {previewContent}
          </div>
        </div>
      ) : (
        <div className="p-4 lg:p-6">
          <section className="mx-auto max-w-[980px] overflow-hidden rounded-lg border border-hairline-subtle bg-surface">
            {canvasMode === "edit" && (
              <>
                {editorHeader}
                {editorBody}
              </>
            )}
            {canvasMode === "preview" && previewContent}
          </section>
        </div>
      )}
    </section>
  );
}
