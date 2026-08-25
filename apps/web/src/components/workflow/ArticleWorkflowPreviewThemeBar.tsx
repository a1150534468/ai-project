import { Icon } from "@iconify/react";
import { useMemo, useState } from "react";
import {
  ARTICLE_WORKFLOW_GALLERY_MODES,
  ARTICLE_WORKFLOW_THEME_MAP,
  ARTICLE_WORKFLOW_THEMES,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { articleWorkflowThemeThumbnail } from "./articleWorkflowLocalPreview";

const NON_AUTO_THEMES = ARTICLE_WORKFLOW_THEMES.filter((theme) => theme !== "auto");

const GALLERY_MODE_OPTIONS: readonly { key: ArticleWorkflowGalleryMode; label: string }[] = [
  { key: "collage", label: "拼贴" },
  { key: "grid", label: "网格" },
  { key: "stack", label: "单列" },
];

interface ArticleWorkflowPreviewThemeBarProps {
  /** 项目已落库的主题（未覆盖时显示它） */
  readonly projectTheme: ArticleWorkflowThemeKey;
  readonly projectThemeColor: string | null;
  readonly projectGalleryMode: ArticleWorkflowGalleryMode;
  /** 预览态覆盖值，null 表示跟随项目 */
  readonly previewTheme: ArticleWorkflowThemeKey | null;
  readonly previewThemeColor: string | null;
  readonly previewGalleryMode: ArticleWorkflowGalleryMode | null;
  readonly applying: boolean;
  readonly onPreviewTheme: (theme: ArticleWorkflowThemeKey) => void;
  readonly onPreviewThemeColor: (color: string) => void;
  readonly onPreviewGalleryMode: (mode: ArticleWorkflowGalleryMode) => void;
  readonly onReset: () => void;
  readonly onApply: () => void;
}

export function ArticleWorkflowPreviewThemeBar(props: ArticleWorkflowPreviewThemeBarProps) {
  const [open, setOpen] = useState(false);
  const effectiveTheme = props.previewTheme ?? props.projectTheme;
  const effectiveColor = (props.previewThemeColor ?? props.projectThemeColor) || "";
  const effectiveGalleryMode = props.previewGalleryMode ?? props.projectGalleryMode;
  const themeLabel =
    effectiveTheme === "auto" ? "AI 自动排版" : (ARTICLE_WORKFLOW_THEME_MAP[effectiveTheme]?.name ?? "AI 自动排版");
  const dirty = props.previewTheme !== null || props.previewThemeColor !== null || props.previewGalleryMode !== null;

  const thumbnails = useMemo(() => {
    const cache = new Map<string, string>();
    for (const key of NON_AUTO_THEMES) cache.set(key, articleWorkflowThemeThumbnail(key));
    return cache;
  }, []);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-white px-2.5 text-xs font-semibold text-ink hover:bg-surface-subtle"
      >
        <Icon icon="mdi:palette-outline" className="text-base" aria-hidden />
        {themeLabel}
        {effectiveTheme !== "auto" && (
          <span
            className="h-3 w-3 rounded-full border border-hairline"
            style={{ backgroundColor: effectiveColor || ARTICLE_WORKFLOW_THEME_MAP[effectiveTheme]?.primary }}
            aria-hidden
          />
        )}
        <Icon icon="mdi:chevron-down" className="text-base transition" aria-hidden />
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-30 w-[440px] max-w-[calc(100vw-2rem)] rounded-xl border border-[#e5e7eb] bg-white p-3 shadow-xl">
          <div className="grid max-h-[280px] grid-cols-4 gap-2 overflow-y-auto pr-1">
            {NON_AUTO_THEMES.map((key) => {
              const theme = ARTICLE_WORKFLOW_THEME_MAP[key];
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={effectiveTheme === key}
                  onClick={() => props.onPreviewTheme(key)}
                  onMouseEnter={() => props.onPreviewTheme(key)}
                  onMouseLeave={() => props.onReset()}
                  className={`min-w-0 overflow-hidden rounded-lg border p-1.5 text-left transition ${
                    effectiveTheme === key
                      ? "border-brand ring-1 ring-brand/20"
                      : "border-hairline-subtle hover:border-[#cbd3d0]"
                  }`}
                >
                  <span className="pointer-events-none block h-16 overflow-hidden rounded-md bg-white" aria-hidden>
                    <span
                      className="block origin-top-left scale-[0.22]"
                      style={{ width: 360 }}
                      dangerouslySetInnerHTML={{ __html: thumbnails.get(key) ?? "" }}
                    />
                  </span>
                  <span className="mt-1 block truncate text-[10px] font-semibold text-ink">{theme.name}</span>
                </button>
              );
            })}
          </div>

          {effectiveTheme !== "auto" && (
            <div className="mt-3 space-y-2 border-t border-[#e5e7eb] pt-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink">主色</span>
                <input
                  type="color"
                  aria-label="主色"
                  value={effectiveColor || ARTICLE_WORKFLOW_THEME_MAP[effectiveTheme]?.primary}
                  onChange={(event) => props.onPreviewThemeColor(event.target.value)}
                  className="h-7 w-10 cursor-pointer rounded border border-hairline bg-white p-0.5"
                />
                <span className="font-mono text-[11px] text-ink-tertiary">
                  {effectiveColor || ARTICLE_WORKFLOW_THEME_MAP[effectiveTheme]?.primary}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink">配图排列</span>
                <div className="inline-grid flex-1 grid-cols-3 rounded-lg bg-[#ececf0] p-1">
                  {GALLERY_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      role="radio"
                      aria-checked={effectiveGalleryMode === option.key}
                      onClick={() => props.onPreviewGalleryMode(option.key)}
                      className={`h-7 rounded-md px-2 text-xs font-semibold transition ${
                        effectiveGalleryMode === option.key ? "bg-white text-ink shadow-sm" : "text-ink-secondary"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center justify-end gap-2 border-t border-[#e5e7eb] pt-3">
            {dirty && (
              <button
                type="button"
                onClick={props.onReset}
                className="h-8 rounded-lg px-3 text-xs font-semibold text-ink-secondary hover:bg-[#f5f5f7]"
              >
                重置
              </button>
            )}
            <button
              type="button"
              onClick={props.onApply}
              disabled={props.applying || !dirty}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-semibold text-white disabled:bg-brand/40"
            >
              <Icon
                icon={props.applying ? "mdi:loading" : "mdi:check"}
                className={props.applying ? "animate-spin" : ""}
                aria-hidden
              />
              {props.applying ? "应用中" : "应用主题"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
