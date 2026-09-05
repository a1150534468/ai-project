/**
 * 单个平台的编辑/预览画布。这一版收掉三处：
 *
 *  - **画布状态跟项目 id 一起算**。原来是 `useEffect(() => setCanvasMode("preview"), [project.id])`：
 *    换平台时先拿上一个平台的模式画一帧、提交后才改回预览，那一下是看得见的；而且 `previewScale`
 *    当时没跟着重置，在小红书调成手机宽度、切回公众号还留着。
 *  - **编辑态不再白算一遍预览**。`renderArticleWorkflowLocalPreview` 原来无条件执行，编辑态里预览
 *    压根没上屏，等于每敲一个键把整篇 Markdown 重排一次。
 *  - **复制菜单选完会关**。原来是 `<details>`，点完一项菜单还开着，得再点一次标题栏收起来。
 */
import { Icon } from "@iconify/react";
import type {
  ArticleWorkflowGalleryMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowPlatformConfig,
  ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { useMemo, useRef, useState, type RefObject } from "react";
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

const CANVAS_MODES: readonly { readonly key: CanvasMode; readonly label: string }[] = [
  { key: "preview", label: "预览" },
  { key: "edit", label: "编辑" },
  { key: "split", label: "对照" },
];

/** 画布怎么摆是「这一个项目」的事，换项目就整份作废，所以两个值和项目 id 绑在一起存。 */
interface CanvasView {
  readonly projectId: string;
  readonly mode: CanvasMode;
  readonly scale: ArticleWorkflowPreviewScale;
}

function freshCanvas(projectId: string): CanvasView {
  return { projectId, mode: "preview", scale: "full" };
}

export function ArticleWorkflowEditor(props: ArticleWorkflowEditorProps) {
  const [stored, setCanvas] = useState(() => freshCanvas(props.project.id));
  // 项目对不上就当场换成新的一份用上，再顺手写回 state；比 effect 少一帧旧模式
  const canvas = stored.projectId === props.project.id ? stored : freshCanvas(props.project.id);
  if (canvas !== stored) setCanvas(canvas);
  const [copyOpen, setCopyOpen] = useState(false);
  const captionPlatform = props.platformConfig.outputKind === "caption";
  const titleOver = props.titleDraft.trim().length > props.platformConfig.titleMaxLength;

  // 确定性主题换肤：正文 Markdown 非空时用本地渲染，预览即时换肤零延迟；
  // auto 主题（bodyMarkdown 为空）或渲染结果为 null 时回落到后端已落库的 bodyHtml。
  const theme = props.previewTheme ?? props.theme;
  const themeColor = props.previewThemeColor ?? props.themeColor;
  const galleryMode = props.previewGalleryMode ?? props.galleryMode;
  const hasMarkdown = props.bodyMarkdown.trim().length > 0;
  const previewOnScreen = canvas.mode !== "edit";
  const localPreviewHtml = useMemo(
    () =>
      captionPlatform || !previewOnScreen || !hasMarkdown
        ? null
        : renderArticleWorkflowLocalPreview({
            bodyMarkdown: props.bodyMarkdown,
            imageManifest: props.imageManifest,
            theme,
            themeColor,
            galleryMode,
          }),
    [captionPlatform, galleryMode, hasMarkdown, previewOnScreen, props.bodyMarkdown, props.imageManifest, theme, themeColor],
  );

  /** 状态胶囊：状态档位一颗，保存中与待保存互斥地再加一颗。 */
  const badges: readonly { readonly text: string; readonly tone: string }[] = [
    { text: formatArticleWorkflowStatus(props.project.status), tone: "bg-surface-muted text-ink-secondary" },
    ...(props.saving ? [{ text: "保存中", tone: "bg-info/10 text-info" }] : []),
    ...(!props.saving && props.dirty ? [{ text: "待保存", tone: "bg-warning/10 text-warning" }] : []),
  ];

  /** 复制菜单按平台出两套：caption 平台复制文案与标签，公众号复制正文与摘要，标题两边都给。 */
  const copyEntries: readonly { readonly label: string; readonly onSelect: () => void }[] = [
    ...(captionPlatform
      ? [
          { label: "复制文案", onSelect: props.onCopyCaption },
          { label: "复制标签", onSelect: props.onCopyTags },
        ]
      : [
          { label: "一键复制到公众号", onSelect: props.onCopyBody },
          { label: "复制摘要", onSelect: props.onCopySummary },
        ]),
    { label: "复制标题", onSelect: props.onCopyTitle },
  ];

  /** 对照模式的两个滚动容器，编辑驱动预览做比例同步 */
  const editScrollRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

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

  const editorPane = (
    <>
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
  );

  const previewPane = captionPlatform ? (
    <section className="min-h-[640px] bg-surface-subtle px-4 py-5 sm:px-6">
      <div className="mx-auto mb-4 flex max-w-[760px] justify-end">
        <ArticleWorkflowPreviewScaleToggle
          scale={canvas.scale}
          onChange={(scale) => setCanvas({ ...canvas, scale })}
        />
      </div>
      <article
        className={`mx-auto bg-surface ${previewScaleWidthClass(canvas.scale)} ${
          canvas.scale === "mobile" ? "overflow-hidden rounded-[32px] border-[8px] border-ink px-4 py-4" : "px-5 py-6"
        }`}
      >
        {canvas.scale === "mobile" && <div className="mx-auto mb-4 h-1.5 w-16 rounded-full bg-hairline" aria-hidden />}
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
      previewHtml={localPreviewHtml ?? props.bodyHtmlDraft}
      previewBodyRef={props.previewBodyRef}
      headerExtra={
        hasMarkdown ? (
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
              {badges.map((badge) => (
                <span key={badge.text} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${badge.tone}`}>
                  {badge.text}
                </span>
              ))}
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
                aria-pressed={canvas.mode === item.key}
                onClick={() => setCanvas({ ...canvas, mode: item.key })}
                className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                  canvas.mode === item.key ? "bg-surface text-ink shadow-sm" : "text-ink-secondary"
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

          <div className="relative">
            <button
              type="button"
              aria-expanded={copyOpen}
              onClick={() => setCopyOpen((open) => !open)}
              className="flex h-9 items-center gap-2 rounded-lg border border-hairline bg-surface px-3.5 text-sm font-semibold text-ink"
            >
              <Icon icon="mdi:content-copy" className="text-base" aria-hidden />
              复制
              <Icon
                icon="mdi:chevron-down"
                className={`text-base transition ${copyOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {copyOpen && (
              <div className="absolute right-0 top-11 z-20 grid w-52 overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-lg">
                {copyEntries.map((entry) => (
                  <button
                    key={entry.label}
                    type="button"
                    onClick={() => {
                      setCopyOpen(false);
                      entry.onSelect();
                    }}
                    className="rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {canvas.mode === "split" ? (
        <div className="grid h-[72vh] min-h-[560px] grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-hairline-subtle">
          <div ref={editScrollRef} onScroll={syncPreviewScroll} className="min-h-0 overflow-y-auto bg-surface">
            {editorPane}
          </div>
          <div ref={previewScrollRef} className="min-h-0 overflow-y-auto bg-surface-subtle">
            {previewPane}
          </div>
        </div>
      ) : (
        <div className="p-4 lg:p-6">
          <section className="mx-auto max-w-[980px] overflow-hidden rounded-lg border border-hairline-subtle bg-surface">
            {canvas.mode === "edit" ? editorPane : previewPane}
          </section>
        </div>
      )}
    </section>
  );
}
