import { Icon } from "@iconify/react";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowPlatformConfig,
} from "@ai-assistant/article-workflow";
import { useState } from "react";
import { RippleButton } from "../../motion";
import type { ArticleWorkflowPricing, ArticleWorkflowProject } from "../../workflowArticleApi";
import { ArticleWorkflowImageAssetPanel } from "./ArticleWorkflowImageAssetPanel";
import {
  articleWorkflowPricingText,
  formatArticleWorkflowStatus,
} from "./articleWorkflowStudioModel";

interface ArticleWorkflowResultToolsProps {
  readonly project: ArticleWorkflowProject;
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  readonly rewriteInstruction: string;
  readonly rewriteGenerationMode: ArticleWorkflowGenerationMode;
  readonly rewriteRegenerateImages: boolean;
  readonly pricing: ArticleWorkflowPricing | null;
  readonly rewriting: boolean;
  readonly retryingProjectId: string | null;
  readonly regeneratingSlot: string | null;
  readonly canRewrite: boolean;
  readonly batchMissingProjectCount: number;
  readonly generatingImages: boolean;
  readonly canGenerateImages: boolean;
  readonly onRewriteInstructionChange: (value: string) => void;
  readonly onRewriteGenerationModeChange: (value: ArticleWorkflowGenerationMode) => void;
  readonly onRewriteRegenerateImagesChange: (value: boolean) => void;
  readonly onRewrite: () => void;
  readonly onRetry: (projectId: string) => void;
  readonly onRegenerateImage: (slot: string) => void;
  readonly onGenerateImages: (scope: "current" | "batch") => void;
}

type ResultSection = "images" | "rewrite";

const RESULT_SECTIONS: readonly { key: ResultSection; label: string; icon: string }[] = [
  { key: "images", label: "配图素材", icon: "mdi:image-outline" },
  { key: "rewrite", label: "AI 重写", icon: "mdi:auto-fix" },
];

const REWRITE_MODES: readonly { key: ArticleWorkflowGenerationMode; label: string }[] = [
  { key: "preserve-text", label: "保持原文" },
  { key: "polish-text", label: "AI 润色" },
];

export function ArticleWorkflowResultTools(props: ArticleWorkflowResultToolsProps) {
  const [activeSection, setActiveSection] = useState<ResultSection | null>(null);
  const [imageMenuOpen, setImageMenuOpen] = useState(false);
  const captionPlatform = props.platformConfig.outputKind === "caption";
  const failed = props.project.status === "failed";
  const retrying = props.retryingProjectId === props.project.id;
  const missingImageCount = props.project.imageManifestJson.filter((image) => !image.imageUrl.trim()).length;
  const hasProjectError = Boolean(props.project.error);

  return (
    <section className="flex-none border-b border-[#e5e7eb] bg-white" aria-label="当前平台工具">
      <div className="flex min-h-11 items-center justify-between gap-3 px-4 lg:px-5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-[#6e6e73]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${failed ? "bg-red-500" : "bg-brand"}`} aria-hidden />
          <span className="truncate">{formatArticleWorkflowStatus(props.project.status)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {missingImageCount > 0 && (
            <div className="relative flex items-center">
              <button
                type="button"
                onClick={() => props.onGenerateImages("current")}
                disabled={!props.canGenerateImages || props.generatingImages}
                className={`inline-flex h-8 items-center gap-1.5 bg-brand px-2.5 text-xs font-semibold text-white disabled:bg-brand/40 ${
                  props.batchMissingProjectCount > 1 ? "rounded-l-lg" : "rounded-lg"
                }`}
              >
                <Icon icon={props.generatingImages ? "mdi:loading" : "mdi:image-plus-outline"} className={props.generatingImages ? "animate-spin text-base" : "text-base"} aria-hidden />
                <span className="hidden sm:inline">生成配图</span>
              </button>
              {props.batchMissingProjectCount > 1 && (
                <button
                  type="button"
                  aria-label="选择配图生成范围"
                  aria-expanded={imageMenuOpen}
                  disabled={!props.canGenerateImages || props.generatingImages}
                  onClick={() => setImageMenuOpen((open) => !open)}
                  className="grid h-8 w-8 place-items-center rounded-r-lg border-l border-white/30 bg-brand text-white disabled:bg-brand/40"
                >
                  <Icon icon="mdi:chevron-down" aria-hidden />
                </button>
              )}
              {imageMenuOpen && props.batchMissingProjectCount > 1 && (
                <div className="absolute right-0 top-10 z-30 w-44 rounded-lg border border-[#d2d2d7] bg-white p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setImageMenuOpen(false);
                      props.onGenerateImages("batch");
                    }}
                    className="flex h-9 w-full items-center rounded-md px-2.5 text-left text-xs font-semibold text-[#1d1d1f] hover:bg-[#f5f5f7]"
                  >
                    生成全部平台配图
                  </button>
                </div>
              )}
            </div>
          )}
          {RESULT_SECTIONS.filter((item) => !captionPlatform || item.key !== "images").map((item) => {
            const active = activeSection === item.key;
            const label = item.key === "images"
              ? `${item.label} ${props.project.imageManifestJson.length}`
              : item.label;
            return (
              <button
                key={item.key}
                type="button"
                aria-expanded={active}
                onClick={() => setActiveSection(active ? null : item.key)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition ${
                  active ? "bg-brand-soft text-brand-ink" : "text-[#6e6e73] hover:bg-[#f5f5f7]"
                }${item.key === "images" ? " xl:hidden" : ""}`}
              >
                <Icon icon={item.icon} className="text-base" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {(failed || hasProjectError) && (
        <div role="alert" className="flex flex-col gap-3 border-t border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-red-700">
              {failed ? `${props.platformConfig.label}生成失败` : "配图生成失败"}
            </p>
            <p className="mt-0.5 break-words text-[11px] leading-5 text-red-600">{props.project.error || "未知原因"}</p>
          </div>
          {failed && (
            <button
              type="button"
              onClick={() => props.onRetry(props.project.id)}
              disabled={retrying}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 text-xs font-semibold text-white disabled:bg-red-300"
            >
              <Icon icon={retrying ? "mdi:loading" : "mdi:refresh"} className={retrying ? "animate-spin" : ""} aria-hidden />
              {retrying ? "提交中" : "重新生成"}
            </button>
          )}
        </div>
      )}

      {!captionPlatform && activeSection === "images" && (
        <div className="max-h-[360px] overflow-y-auto border-t border-[#e5e7eb] px-4 py-4 [scrollbar-width:thin] lg:px-5 xl:hidden">
          <div className="mx-auto max-w-[980px]">
            <ArticleWorkflowImageAssetPanel
              imageManifest={props.project.imageManifestJson}
              platform={props.project.platform}
              regeneratingSlot={props.regeneratingSlot}
              onRegenerateImage={props.onRegenerateImage}
            />
          </div>
        </div>
      )}

      {activeSection === "rewrite" && (
        <div className="border-t border-[#e5e7eb] px-4 py-4 lg:px-5">
          <div className="mx-auto grid max-w-[980px] gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold text-[#1d1d1f]">AI 重新生成</h3>
                  <p className="mt-1 text-[11px] leading-5 text-[#6e6e73]">仅调整当前平台版本</p>
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-[#6e6e73]">
                  <input
                    type="checkbox"
                    checked={props.rewriteRegenerateImages}
                    onChange={(event) => props.onRewriteRegenerateImagesChange(event.target.checked)}
                  />
                  重新配图
                </label>
              </div>
              <textarea
                aria-label="重新生成要求"
                value={props.rewriteInstruction}
                onChange={(event) => props.onRewriteInstructionChange(event.target.value)}
                rows={4}
                className="mt-3 w-full resize-none rounded-lg border border-[#d2d2d7] bg-[#f7f8fa] px-3 py-2.5 text-sm leading-6 text-[#1d1d1f] outline-none focus:border-brand focus:bg-white"
                placeholder="例如：开头更有代入感，整体语气更自然。"
              />
            </div>

            <div className="flex flex-col justify-end">
              {!captionPlatform && (
                <div className="mb-3 grid grid-cols-2 rounded-lg bg-[#ececf0] p-1">
                  {REWRITE_MODES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      aria-pressed={props.rewriteGenerationMode === item.key}
                      onClick={() => props.onRewriteGenerationModeChange(item.key)}
                      className={`h-9 rounded-md text-xs font-semibold transition ${
                        props.rewriteGenerationMode === item.key
                          ? "bg-white text-[#1d1d1f] shadow-sm"
                          : "text-[#6e6e73]"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
              <p className="mb-2 text-[10px] leading-4 text-[#8a8a8f]">
                文本 {articleWorkflowPricingText(props.pricing?.text, "每 1000 字 1 点")} · 图片 {articleWorkflowPricingText(props.pricing?.image1k, "按 1K 生图价格")}
              </p>
              <RippleButton
                type="button"
                onClick={props.onRewrite}
                disabled={!props.canRewrite || props.rewriting}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand px-3 text-xs font-semibold text-white disabled:bg-brand/40"
              >
                <Icon icon={props.rewriting ? "mdi:loading" : "mdi:auto-fix"} className={props.rewriting ? "animate-spin" : ""} aria-hidden />
                {props.rewriting ? "提交中" : "按要求重新生成"}
              </RippleButton>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
