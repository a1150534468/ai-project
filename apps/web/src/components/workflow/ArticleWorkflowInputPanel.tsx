import { Icon } from "@iconify/react";
import {
  ARTICLE_WORKFLOW_PLATFORMS,
  articleWorkflowPlatformConfig,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import type { ArticleWorkflowPricing } from "../../workflowArticleApi";
import { ArticleWorkflowCreationCanvas } from "./ArticleWorkflowCreationCanvas";
import { ArticleWorkflowThemePicker } from "./ArticleWorkflowThemePicker";
import type { ArticleWorkflowCreationDraft } from "./articleWorkflowCreationDraft";
import { articleWorkflowPricingText } from "./articleWorkflowStudioModel";
import { SubmitCostBar } from "./SubmitCostBar";

interface ArticleWorkflowInputPanelProps {
  readonly creationDraft: ArticleWorkflowCreationDraft;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly generateImages: boolean;
  readonly selectedPlatforms: readonly ArticleWorkflowPlatform[];
  readonly pricing: ArticleWorkflowPricing | null;
  readonly creating: boolean;
  readonly canGenerate: boolean;
  readonly onGenerationModeChange: (value: ArticleWorkflowGenerationMode) => void;
  readonly onCreationDraftChange: (value: ArticleWorkflowCreationDraft) => void;
  readonly onCreationModeChange: (value: ArticleWorkflowCreationDraft["mode"]) => void;
  readonly onGenerateImagesChange: (value: boolean) => void;
  readonly onTogglePlatform: (value: ArticleWorkflowPlatform) => void;
  readonly selectedTheme: ArticleWorkflowThemeKey;
  readonly selectedThemeColor: string;
  readonly galleryMode: ArticleWorkflowGalleryMode;
  readonly onThemeChange: (value: ArticleWorkflowThemeKey) => void;
  readonly onThemeColorChange: (value: string) => void;
  readonly onGalleryModeChange: (value: ArticleWorkflowGalleryMode) => void;
  readonly onGenerate: () => void;
  readonly onClose?: () => void;
}

const MODE_OPTIONS: readonly { key: ArticleWorkflowGenerationMode; label: string }[] = [
  { key: "preserve-text", label: "保持原文" },
  { key: "polish-text", label: "AI 润色" },
];

const PLATFORM_HINTS: Record<ArticleWorkflowPlatform, string> = {
  wechat: "公众号正文与配图",
  xiaohongshu: "标题、文案、标签与竖版配图",
  douyin: "口播文案、标签与 9:16 配图",
};

const PLATFORM_ICONS: Record<ArticleWorkflowPlatform, string> = {
  wechat: "mdi:message-text-outline",
  xiaohongshu: "mdi:notebook-outline",
  douyin: "mdi:music-note-outline",
};

export function ArticleWorkflowInputPanel(props: ArticleWorkflowInputPanelProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-white" aria-label="图文生成配置">
      <div className="flex h-14 flex-none items-center justify-between gap-2 border-b border-hairline-subtle px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-ink">
            <Icon icon="mdi:tune-variant" className="text-lg" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[9px] font-bold uppercase tracking-[0.18em] text-brand-ink">Content Studio</p>
            <h2 className="truncate text-sm font-semibold text-ink">多平台图文生成</h2>
          </div>
        </div>
        {props.onClose && (
          <button
            type="button"
            onClick={props.onClose}
            aria-label="关闭生成配置"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink hover:bg-surface-muted"
          >
            <Icon icon="mdi:close" className="text-lg" aria-hidden />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable] [scrollbar-width:thin]">
        <ArticleWorkflowCreationCanvas
          draft={props.creationDraft}
          onChange={props.onCreationDraftChange}
          onModeChange={props.onCreationModeChange}
          variant="panel"
        />

        <fieldset className="mt-5 border-t border-hairline-subtle pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <legend className="text-xs font-semibold text-ink">发布平台</legend>
            <span className="text-[10px] text-ink-tertiary">可多选</span>
          </div>
          <div className="grid gap-2">
            {ARTICLE_WORKFLOW_PLATFORMS.map((platform) => {
              const checked = props.selectedPlatforms.includes(platform);
              const config = articleWorkflowPlatformConfig(platform);
              return (
                <button
                  key={platform}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => props.onTogglePlatform(platform)}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                    checked
                      ? "border-brand bg-brand-soft ring-1 ring-brand/20"
                      : "border-hairline-subtle bg-white hover:border-hairline"
                  }`}
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${checked ? "bg-brand text-white" : "bg-surface-muted text-ink-secondary"}`}
                  >
                    <Icon icon={PLATFORM_ICONS[platform]} className="text-lg" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{config.label}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-tertiary">{PLATFORM_HINTS[platform]}</span>
                  </span>
                  <Icon
                    icon={checked ? "mdi:check-circle" : "mdi:circle-outline"}
                    className={`shrink-0 text-lg ${checked ? "text-brand" : "text-hairline"}`}
                    aria-hidden
                  />
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="mt-4 flex items-center justify-between gap-4 border-t border-hairline-subtle pt-4">
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-ink">同时生成配图</span>
            <span className="mt-1 block text-[10px] text-ink-tertiary">
              {props.generateImages ? "文案与配图一起完成" : "先确认文案，再生成配图"}
            </span>
          </span>
          <span className="relative inline-flex h-6 w-10 shrink-0 items-center">
            <input
              type="checkbox"
              role="switch"
              aria-label="同时生成配图"
              checked={props.generateImages}
              onChange={(event) => props.onGenerateImagesChange(event.target.checked)}
              className="peer absolute inset-0 cursor-pointer opacity-0"
            />
            <span
              className="h-6 w-10 rounded-full bg-hairline transition peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/30"
              aria-hidden
            />
            <span
              className="pointer-events-none absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4"
              aria-hidden
            />
          </span>
        </label>

        {props.creationDraft.mode === "source" && props.selectedPlatforms.includes("wechat") && (
          <fieldset className="mt-4">
            <legend className="mb-2 text-xs font-semibold text-ink">公众号生成方式</legend>
            <div className="grid grid-cols-2 rounded-lg bg-surface-muted p-1">
              {MODE_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={props.generationMode === option.key}
                  onClick={() => props.onGenerationModeChange(option.key)}
                  className={`h-9 rounded-md px-2 text-xs font-semibold transition ${
                    props.generationMode === option.key ? "bg-white text-ink shadow-sm" : "text-ink-secondary"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {props.selectedPlatforms.includes("wechat") && (
          <fieldset className="mt-4 border-t border-hairline-subtle pt-4">
            <legend className="mb-2 text-xs font-semibold text-ink">排版主题</legend>
            <ArticleWorkflowThemePicker
              selectedTheme={props.selectedTheme}
              selectedThemeColor={props.selectedThemeColor}
              galleryMode={props.galleryMode}
              onThemeChange={props.onThemeChange}
              onThemeColorChange={props.onThemeColorChange}
              onGalleryModeChange={props.onGalleryModeChange}
            />
          </fieldset>
        )}

        <details className="group mt-4 border-t border-hairline-subtle pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-ink-secondary marker:content-none">
            <span>计费规则</span>
            <Icon icon="mdi:chevron-down" className="text-base transition group-open:rotate-180" aria-hidden />
          </summary>
          <p className="mt-2 text-[11px] leading-5 text-ink-tertiary">
            文本 {articleWorkflowPricingText(props.pricing?.text, "每 1000 字 1 点")}；配图{" "}
            {articleWorkflowPricingText(props.pricing?.image1k, "按 1K 生图价格")}。失败任务自动退费。
          </p>
        </details>
      </div>

      <SubmitCostBar
        estimatedPointCost={null}
        costLabel="计费方式"
        costValue={
          props.generateImages
            ? `${props.selectedPlatforms.length} 个平台分别计费`
            : `先生成 ${props.selectedPlatforms.length} 个平台文案`
        }
        submitLabel={`生成 ${props.selectedPlatforms.length} 个平台${props.generateImages ? "图文" : "文案"}`}
        submitIcon="mdi:auto-fix"
        submitDisabled={!props.canGenerate}
        busy={props.creating}
        busyLabel="提交中"
        onSubmit={props.onGenerate}
      />
    </section>
  );
}
