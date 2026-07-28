import { Icon } from "@iconify/react";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowPlatform,
  ArticleWorkflowPlatformConfig,
} from "@ai-assistant/article-workflow";
import { useState, type RefObject } from "react";
import { RippleButton } from "../../motion";
import type { ArticleWorkflowPricing, ArticleWorkflowProject } from "../../workflowArticleApi";
import { ArticleWorkflowCaptionEditor } from "./ArticleWorkflowCaptionEditor";
import { ArticleWorkflowImageAssetPanel } from "./ArticleWorkflowImageAssetPanel";
import { ArticleWorkflowPlatformTabs } from "./ArticleWorkflowPlatformTabs";
import { ArticleWorkflowPreview } from "./ArticleWorkflowPreview";
import { ArticleWorkflowRichEditor } from "./ArticleWorkflowRichEditor";
import {
  articleWorkflowPricingText,
  formatArticleWorkflowStatus,
  formatArticleWorkflowTime,
} from "./articleWorkflowStudioModel";

interface ArticleWorkflowEditorProps {
  readonly project: ArticleWorkflowProject;
  readonly batchProjects: readonly ArticleWorkflowProject[];
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  readonly dirtyPlatforms: readonly ArticleWorkflowPlatform[];
  readonly titleDraft: string;
  readonly summaryDraft: string;
  readonly bodyHtmlDraft: string;
  readonly captionDraft: string;
  readonly tagsDraft: readonly string[];
  readonly editorSyncKey: string;
  readonly rewriteInstruction: string;
  readonly rewriteGenerationMode: ArticleWorkflowGenerationMode;
  readonly rewriteRegenerateImages: boolean;
  readonly pricing: ArticleWorkflowPricing | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly rewriting: boolean;
  readonly regeneratingSlot: string | null;
  readonly canSave: boolean;
  readonly canRewrite: boolean;
  readonly previewBodyRef: RefObject<HTMLDivElement | null>;
  readonly onSelectPlatform: (platform: ArticleWorkflowPlatform) => void;
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
  readonly onRewriteInstructionChange: (value: string) => void;
  readonly onRewriteGenerationModeChange: (value: ArticleWorkflowGenerationMode) => void;
  readonly onRewriteRegenerateImagesChange: (value: boolean) => void;
  readonly onRewrite: () => void;
  readonly onRegenerateImage: (slot: string) => void;
}

type CanvasMode = "edit" | "preview";

export function ArticleWorkflowEditor(props: ArticleWorkflowEditorProps) {
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("edit");
  const captionPlatform = props.platformConfig.outputKind === "caption";
  // 小红书标题只有 20 字，超了只标红不拦保存
  const titleOver = props.titleDraft.trim().length > props.platformConfig.titleMaxLength;

  return (
    <section className="grid gap-4">
      <ArticleWorkflowPlatformTabs
        projects={props.batchProjects}
        activePlatform={props.project.platform}
        dirtyPlatforms={props.dirtyPlatforms}
        onSelectPlatform={props.onSelectPlatform}
      />

      <div className="flex flex-col gap-3 rounded-[16px] border border-[#e7e9f0] bg-white px-4 py-3 shadow-[0_16px_40px_rgba(15,23,42,0.05)] xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#eef8f5] px-2.5 py-1 text-[11px] font-semibold text-brand-ink">{props.platformConfig.label}</span>
            <span className="rounded-full bg-[#f5f6fa] px-2.5 py-1 text-[11px] font-semibold text-[#667085]">
              {formatArticleWorkflowStatus(props.project.status)}
            </span>
            {props.saving && <span className="rounded-full bg-[#eef4ff] px-2.5 py-1 text-[11px] font-semibold text-[#2d63c8]">保存中</span>}
            {!props.saving && props.dirty && <span className="rounded-full bg-[#fff4e8] px-2.5 py-1 text-[11px] font-semibold text-[#c26a12]">待保存</span>}
          </div>
          <p className="mt-2 text-xs leading-5 text-[#8a8f98]">最近更新 {formatArticleWorkflowTime(props.project.updatedAt)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <RippleButton
            type="button"
            onClick={props.onSave}
            disabled={!props.canSave}
            className="flex h-9 items-center gap-2 rounded-[10px] bg-brand px-3.5 text-sm font-semibold text-white disabled:bg-brand/40"
          >
            <Icon icon={props.saving ? "mdi:loading" : "mdi:content-save-outline"} className={props.saving ? "animate-spin" : ""} aria-hidden />
            {props.saving ? "保存中" : "保存修改"}
          </RippleButton>
          {captionPlatform ? (
            <>
              <button type="button" onClick={props.onCopyCaption} className="h-9 rounded-[10px] border border-[#d2d7e0] px-3.5 text-sm font-semibold text-[#1d2433]">
                复制文案
              </button>
              <button type="button" onClick={props.onCopyTags} className="h-9 rounded-[10px] border border-[#d2d7e0] px-3.5 text-sm font-semibold text-[#1d2433]">
                复制标签
              </button>
            </>
          ) : (
            <button type="button" onClick={props.onCopyBody} className="h-9 rounded-[10px] border border-[#d2d7e0] px-3.5 text-sm font-semibold text-[#1d2433]">
              一键复制到公众号
            </button>
          )}
          <button type="button" onClick={props.onCopyTitle} className="h-9 rounded-[10px] border border-[#d2d7e0] px-3.5 text-sm font-semibold text-[#1d2433]">
            复制标题
          </button>
          {!captionPlatform && (
            <button type="button" onClick={props.onCopySummary} className="h-9 rounded-[10px] border border-[#d2d7e0] px-3.5 text-sm font-semibold text-[#1d2433]">
              复制摘要
            </button>
          )}
        </div>
      </div>

      <section className="overflow-hidden rounded-[20px] border border-[#e7e9f0] bg-white shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
        <div className="border-b border-[#edf0f5] px-5 py-4 sm:px-6">
          {/* caption 平台没有富文本正文，编辑/预览切换没有意义 */}
          {!captionPlatform && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-full bg-[#f5f6fa] p-1">
                {[
                  { key: "edit", label: "编辑" },
                  { key: "preview", label: "预览" },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setCanvasMode(item.key as CanvasMode)}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                      canvasMode === item.key ? "bg-white text-[#14151a] shadow-sm" : "text-[#667085]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className={`grid gap-4 ${captionPlatform ? "" : "mt-4"}`}>
            <div className="grid gap-1">
              <input
                value={props.titleDraft}
                onChange={(event) => props.onTitleChange(event.target.value)}
                className="w-full border-0 p-0 text-[28px] font-semibold leading-[1.35] text-[#14151a] outline-none placeholder:text-[#b2b7c2]"
                placeholder="输入标题"
              />
              <span className={`text-xs ${titleOver ? "font-semibold text-red-600" : "text-[#8a8f98]"}`}>
                标题 {props.titleDraft.trim().length} / {props.platformConfig.titleMaxLength} 字
              </span>
            </div>
            {!captionPlatform && (
              <textarea
                value={props.summaryDraft}
                onChange={(event) => props.onSummaryChange(event.target.value)}
                rows={2}
                className="w-full rounded-[14px] border border-[#e3e7ee] bg-[#fbfcff] px-4 py-3 text-sm leading-6 text-[#344054] outline-none"
                placeholder="输入摘要"
              />
            )}
          </div>
        </div>

        {captionPlatform && (
          <ArticleWorkflowCaptionEditor
            captionDraft={props.captionDraft}
            tagsDraft={props.tagsDraft}
            syncKey={props.editorSyncKey}
            platformConfig={props.platformConfig}
            onCaptionChange={props.onCaptionChange}
            onTagsChange={props.onTagsChange}
          />
        )}

        {!captionPlatform && (canvasMode === "edit" ? (
          <ArticleWorkflowRichEditor
            value={props.bodyHtmlDraft}
            syncKey={props.editorSyncKey}
            placeholder="开始编辑正文"
            onChange={props.onBodyHtmlChange}
            onBlurCommit={props.onBodyBlur}
          />
        ) : (
          <ArticleWorkflowPreview
            previewHtml={props.bodyHtmlDraft}
            previewBodyRef={props.previewBodyRef}
          />
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="rounded-[16px] border border-[#e7e9f0] bg-white p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#14151a]">AI 重新生成</h3>
              <p className="mt-1 text-xs leading-5 text-[#667085]">
                重新生成按首次生成同价扣费，失败自动退费。
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-[#475467]">
              <input
                type="checkbox"
                checked={props.rewriteRegenerateImages}
                onChange={(event) => props.onRewriteRegenerateImagesChange(event.target.checked)}
              />
              同时重配图
            </label>
          </div>

          {/* caption 平台固定重写文案，没有「保持原文」这一档 */}
          {!captionPlatform && (
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                { key: "preserve-text", label: "保持原文排版" },
                { key: "polish-text", label: "AI 润色后排版" },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => props.onRewriteGenerationModeChange(item.key as ArticleWorkflowGenerationMode)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                    props.rewriteGenerationMode === item.key
                      ? "bg-brand text-white"
                      : "bg-[#f5f6fa] text-[#475467]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          <textarea
            value={props.rewriteInstruction}
            onChange={(event) => props.onRewriteInstructionChange(event.target.value)}
            rows={4}
            className="mt-3 w-full rounded-[12px] border border-[#d5dae3] px-3 py-3 text-sm leading-6 outline-none"
            placeholder="例如：开头更有代入感，整体语气更自然，保留促销信息。"
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-[#667085]">
              文本：{articleWorkflowPricingText(props.pricing?.text, "每 1000 字 1 点")}
              <br />
              图片：{articleWorkflowPricingText(props.pricing?.image1k, "1K 生图价格")}
            </p>
            <RippleButton
              type="button"
              onClick={props.onRewrite}
              disabled={!props.canRewrite}
              className="flex h-10 items-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:bg-brand/40"
            >
              <Icon icon={props.rewriting ? "mdi:loading" : "mdi:auto-fix"} className={props.rewriting ? "animate-spin" : ""} aria-hidden />
              {props.rewriting ? "提交中" : "按要求重新生成"}
            </RippleButton>
          </div>
        </section>

        <ArticleWorkflowImageAssetPanel
          imageManifest={props.project.imageManifestJson}
          platform={props.project.platform}
          regeneratingSlot={props.regeneratingSlot}
          onRegenerateImage={props.onRegenerateImage}
        />
      </div>
    </section>
  );
}
