import { Icon } from "@iconify/react";
import type { ArticleWorkflowPlatformConfig } from "@ai-assistant/article-workflow";
import { useEffect, useState, type RefObject } from "react";
import { RippleButton } from "../../motion";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import { ArticleWorkflowCaptionEditor } from "./ArticleWorkflowCaptionEditor";
import {
  ArticleWorkflowPreview,
  ArticleWorkflowPreviewScaleToggle,
  previewScaleWidthClass,
  type ArticleWorkflowPreviewScale,
} from "./ArticleWorkflowPreview";
import { ArticleWorkflowRichEditor } from "./ArticleWorkflowRichEditor";
import {
  formatArticleWorkflowStatus,
  formatArticleWorkflowTime,
} from "./articleWorkflowStudioModel";

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
  readonly onTitleChange: (value: string) => void;
  readonly onSummaryChange: (value: string) => void;
  readonly onBodyHtmlChange: (value: string) => void;
  readonly onBodyBlur: (value: string) => void;
  readonly onCaptionChange: (value: string) => void;
  readonly onTagsChange: (value: readonly string[]) => void;
  readonly onSave: () => void;
  readonly onCopyBody: () => void;
  readonly onCopyTitle: () => void;
  readonly onCopySummary: () => void;
  readonly onCopyCaption: () => void;
  readonly onCopyTags: () => void;
}

type CanvasMode = "edit" | "preview";

export function ArticleWorkflowEditor(props: ArticleWorkflowEditorProps) {
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("preview");
  const [previewScale, setPreviewScale] = useState<ArticleWorkflowPreviewScale>("full");
  const captionPlatform = props.platformConfig.outputKind === "caption";
  const titleOver = props.titleDraft.trim().length > props.platformConfig.titleMaxLength;

  useEffect(() => {
    setCanvasMode("preview");
  }, [props.project.id]);

  return (
    <section className="flex min-h-full flex-col bg-[#f7f8fa]">
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-[#e5e7eb] bg-white/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden min-w-0 sm:block">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-[#f0f0f2] px-2 py-1 text-[11px] font-semibold text-[#6e6e73]">
                {formatArticleWorkflowStatus(props.project.status)}
              </span>
              {props.saving && <span className="rounded-md bg-[#eef4ff] px-2 py-1 text-[11px] font-semibold text-[#2d63c8]">保存中</span>}
              {!props.saving && props.dirty && <span className="rounded-md bg-[#fff4e8] px-2 py-1 text-[11px] font-semibold text-[#c26a12]">待保存</span>}
            </div>
            <p className="mt-1 truncate text-xs text-[#8a8a8f]">最近更新 {formatArticleWorkflowTime(props.project.updatedAt)}</p>
          </div>
          <div className="inline-grid shrink-0 grid-cols-2 rounded-lg bg-[#ececf0] p-1">
            {([
              { key: "preview", label: "预览" },
              { key: "edit", label: "编辑" },
            ] as const).map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={canvasMode === item.key}
                onClick={() => setCanvasMode(item.key)}
                className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                  canvasMode === item.key ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73]"
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
            <Icon icon={props.saving ? "mdi:loading" : "mdi:content-save-outline"} className={props.saving ? "animate-spin" : ""} aria-hidden />
            {props.saving ? "保存中" : "保存修改"}
          </RippleButton>

          <details className="group relative">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border border-[#d2d2d7] bg-white px-3.5 text-sm font-semibold text-[#1d1d1f] marker:content-none">
              <Icon icon="mdi:content-copy" className="text-base" aria-hidden />
              复制
              <Icon icon="mdi:chevron-down" className="text-base transition group-open:rotate-180" aria-hidden />
            </summary>
            <div className="absolute right-0 top-11 z-20 grid w-52 overflow-hidden rounded-lg border border-[#d2d2d7] bg-white p-1 shadow-lg">
              {captionPlatform ? (
                <>
                  <button type="button" onClick={props.onCopyCaption} className="rounded-md px-3 py-2 text-left text-sm text-[#1d1d1f] hover:bg-[#f5f5f7]">复制文案</button>
                  <button type="button" onClick={props.onCopyTags} className="rounded-md px-3 py-2 text-left text-sm text-[#1d1d1f] hover:bg-[#f5f5f7]">复制标签</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={props.onCopyBody} className="rounded-md px-3 py-2 text-left text-sm text-[#1d1d1f] hover:bg-[#f5f5f7]">一键复制到公众号</button>
                  <button type="button" onClick={props.onCopySummary} className="rounded-md px-3 py-2 text-left text-sm text-[#1d1d1f] hover:bg-[#f5f5f7]">复制摘要</button>
                </>
              )}
              <button type="button" onClick={props.onCopyTitle} className="rounded-md px-3 py-2 text-left text-sm text-[#1d1d1f] hover:bg-[#f5f5f7]">复制标题</button>
            </div>
          </details>
        </div>
      </div>

      <div className="p-4 lg:p-6">
        <section className="mx-auto max-w-[980px] overflow-hidden rounded-lg border border-[#e5e7eb] bg-white">
          {canvasMode === "edit" && (
            <>
              <div className="border-b border-[#e5e7eb] px-5 py-4 sm:px-6">
                <div className="grid gap-4">
                  <div className="grid gap-1">
                    <input
                      aria-label="图文标题"
                      value={props.titleDraft}
                      onChange={(event) => props.onTitleChange(event.target.value)}
                      className="w-full border-0 bg-transparent p-0 text-[24px] font-semibold leading-[1.35] text-[#1d1d1f] outline-none placeholder:text-[#b2b2b7] focus:shadow-none"
                      placeholder="输入标题"
                    />
                    <span className={`text-xs ${titleOver ? "font-semibold text-red-600" : "text-[#8a8a8f]"}`}>
                      标题 {props.titleDraft.trim().length} / {props.platformConfig.titleMaxLength} 字
                    </span>
                  </div>
                  {!captionPlatform && (
                    <textarea
                      aria-label="图文摘要"
                      value={props.summaryDraft}
                      onChange={(event) => props.onSummaryChange(event.target.value)}
                      rows={2}
                      className="w-full resize-none rounded-lg border border-[#d2d2d7] bg-[#f7f8fa] px-4 py-3 text-sm leading-6 text-[#1d1d1f] outline-none focus:border-brand focus:bg-white"
                      placeholder="输入摘要"
                    />
                  )}
                </div>
              </div>

              {captionPlatform ? (
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
              )}
            </>
          )}

          {canvasMode === "preview" && (captionPlatform ? (
            <section className="min-h-[640px] bg-[#f7f8fa] px-4 py-5 sm:px-6">
              <div className="mx-auto mb-4 flex max-w-[760px] justify-end">
                <ArticleWorkflowPreviewScaleToggle scale={previewScale} onChange={setPreviewScale} />
              </div>
              <article
                className={`mx-auto bg-white ${previewScaleWidthClass(previewScale)} ${
                  previewScale === "mobile"
                    ? "overflow-hidden rounded-[32px] border-[8px] border-[#1d1d1f] px-4 py-4"
                    : "px-5 py-6"
                }`}
              >
                {previewScale === "mobile" && (
                  <div className="mx-auto mb-4 h-1.5 w-16 rounded-full bg-[#d2d2d7]" aria-hidden />
                )}
                <h1 className="text-[24px] font-semibold leading-[1.4] text-[#1d1d1f]">{props.titleDraft || "未命名图文"}</h1>
                <p className="mt-5 whitespace-pre-wrap text-[15px] leading-7 text-[#1d1d1f]">{props.captionDraft}</p>
                {props.tagsDraft.length > 0 && (
                  <div className="mt-5 flex flex-wrap gap-2">
                    {props.tagsDraft.map((tag) => (
                      <span key={tag} className="text-sm font-semibold text-brand-ink">#{tag}</span>
                    ))}
                  </div>
                )}
              </article>
            </section>
          ) : (
            <ArticleWorkflowPreview
              title={props.titleDraft}
              summary={props.summaryDraft}
              previewHtml={props.bodyHtmlDraft}
              previewBodyRef={props.previewBodyRef}
            />
          ))}
        </section>
      </div>
    </section>
  );
}
