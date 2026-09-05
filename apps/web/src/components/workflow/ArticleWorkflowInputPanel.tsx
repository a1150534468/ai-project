import { Icon } from "@iconify/react";
import {
  ARTICLE_WORKFLOW_PLATFORMS,
  articleWorkflowPlatformConfig,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { ArticleWorkflowCreationCanvas } from "./ArticleWorkflowCreationCanvas";
import { ArticleWorkflowThemePicker } from "./ArticleWorkflowThemePicker";
import { Switch } from "../ui/Switch";
import type { ArticleWorkflowCreationDraft } from "./articleWorkflowCreationDraft";
import { SubmitBar } from "./SubmitBar";

interface ArticleWorkflowInputPanelProps {
  readonly creationDraft: ArticleWorkflowCreationDraft;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly generateImages: boolean;
  readonly selectedPlatforms: readonly ArticleWorkflowPlatform[];
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
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="图文生成配置">
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
                      : "border-hairline-subtle bg-surface hover:border-hairline"
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

        <Switch
          checked={props.generateImages}
          label="同时生成配图"
          description={props.generateImages ? "文案与配图一起完成" : "先确认文案，再生成配图"}
          onToggle={() => props.onGenerateImagesChange(!props.generateImages)}
          className="mt-4 w-full border-t border-hairline-subtle pt-4"
        />

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
                    props.generationMode === option.key ? "bg-surface text-ink shadow-sm" : "text-ink-secondary"
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
      </div>

      <SubmitBar
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
