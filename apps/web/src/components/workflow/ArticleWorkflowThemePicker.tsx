import { useMemo } from "react";
import {
  ARTICLE_WORKFLOW_GALLERY_MODES,
  ARTICLE_WORKFLOW_THEME_MAP,
  ARTICLE_WORKFLOW_THEMES,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { articleWorkflowThemeThumbnail } from "./articleWorkflowLocalPreview";

interface ArticleWorkflowThemePickerProps {
  readonly selectedTheme: ArticleWorkflowThemeKey;
  readonly selectedThemeColor: string;
  readonly galleryMode: ArticleWorkflowGalleryMode;
  readonly onThemeChange: (theme: ArticleWorkflowThemeKey) => void;
  readonly onThemeColorChange: (color: string) => void;
  readonly onGalleryModeChange: (mode: ArticleWorkflowGalleryMode) => void;
}

const NON_AUTO_THEMES = ARTICLE_WORKFLOW_THEMES.filter((theme) => theme !== "auto");

const GALLERY_MODE_OPTIONS: readonly { key: ArticleWorkflowGalleryMode; label: string }[] = [
  { key: "collage", label: "拼贴" },
  { key: "grid", label: "网格" },
  { key: "stack", label: "单列" },
];

export function ArticleWorkflowThemePicker(props: ArticleWorkflowThemePickerProps) {
  const activeConfig = props.selectedTheme === "auto" ? null : ARTICLE_WORKFLOW_THEME_MAP[props.selectedTheme];
  const effectiveColor = activeConfig ? props.selectedThemeColor || activeConfig.primary : "";

  // 26 套主题的缩略 HTML 只渲染一次（theme 数据是静态常量）
  const thumbnails = useMemo(() => {
    const cache = new Map<string, string>();
    for (const key of NON_AUTO_THEMES) cache.set(key, articleWorkflowThemeThumbnail(key));
    return cache;
  }, []);

  return (
    <div className="space-y-3">
      <div className="grid max-h-[320px] grid-cols-3 gap-2 overflow-y-auto pr-1">
        <ThemeCard
          label="AI 自动"
          selected={props.selectedTheme === "auto"}
          onClick={() => props.onThemeChange("auto")}
          placeholder
        />
        {NON_AUTO_THEMES.map((key) => {
          const theme = ARTICLE_WORKFLOW_THEME_MAP[key];
          return (
            <ThemeCard
              key={key}
              label={theme.name}
              thumbnailHtml={thumbnails.get(key) ?? ""}
              selected={props.selectedTheme === key}
              onClick={() => props.onThemeChange(key)}
            />
          );
        })}
      </div>

      {activeConfig && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl border border-hairline-subtle bg-surface-subtle px-3 py-2">
            <span className="text-xs font-semibold text-ink">主色</span>
            <input
              type="color"
              aria-label="自定义主色"
              value={effectiveColor}
              onChange={(event) => props.onThemeColorChange(event.target.value)}
              className="h-8 w-12 cursor-pointer rounded border border-hairline bg-white p-0.5"
            />
            <span className="font-mono text-[11px] text-ink-tertiary">{effectiveColor}</span>
            {props.selectedThemeColor && (
              <button
                type="button"
                onClick={() => props.onThemeColorChange("")}
                className="ml-auto text-xs font-semibold text-brand"
              >
                恢复默认
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink">配图排列</span>
            <div className="inline-grid flex-1 grid-cols-3 rounded-lg bg-surface-muted p-1">
              {GALLERY_MODE_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={props.galleryMode === option.key}
                  onClick={() => props.onGalleryModeChange(option.key)}
                  className={`h-8 rounded-md px-2 text-xs font-semibold transition ${
                    props.galleryMode === option.key ? "bg-white text-ink shadow-sm" : "text-ink-secondary"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 主题卡片：非 auto 主题用真实渲染的缩略 HTML 展示排版气质。 */
function ThemeCard(props: {
  readonly label: string;
  readonly thumbnailHtml?: string;
  readonly placeholder?: boolean;
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={props.onClick}
      className={`min-w-0 overflow-hidden rounded-xl border p-2 text-left transition ${
        props.selected ? "border-brand ring-1 ring-brand/20" : "border-hairline-subtle hover:border-hairline"
      }`}
    >
      {props.placeholder ? (
        <span className="block rounded-lg bg-surface-muted p-2" aria-hidden>
          <span className="block h-1.5 w-3/4 rounded-sm bg-[#888780]" />
          <span className="mt-1.5 block h-1 w-full rounded-sm bg-[#1d1d1f] opacity-30" />
          <span className="mt-1 block h-1 w-5/6 rounded-sm bg-[#1d1d1f] opacity-30" />
        </span>
      ) : (
        <span className="pointer-events-none block h-20 overflow-hidden rounded-lg bg-white" aria-hidden>
          <span
            className="block origin-top-left scale-[0.28]"
            style={{ width: 360 }}
            dangerouslySetInnerHTML={{ __html: props.thumbnailHtml ?? "" }}
          />
        </span>
      )}
      <span className="mt-1.5 block truncate text-xs font-semibold text-ink">{props.label}</span>
    </button>
  );
}
