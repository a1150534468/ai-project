import {
  ARTICLE_WORKFLOW_THEME_MAP,
  ARTICLE_WORKFLOW_THEMES,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";

interface ArticleWorkflowThemePickerProps {
  readonly selectedTheme: ArticleWorkflowThemeKey;
  readonly selectedThemeColor: string;
  readonly onThemeChange: (theme: ArticleWorkflowThemeKey) => void;
  readonly onThemeColorChange: (color: string) => void;
}

const NON_AUTO_THEMES = ARTICLE_WORKFLOW_THEMES.filter((theme) => theme !== "auto");

export function ArticleWorkflowThemePicker(props: ArticleWorkflowThemePickerProps) {
  const activeConfig = props.selectedTheme === "auto"
    ? null
    : ARTICLE_WORKFLOW_THEME_MAP[props.selectedTheme];
  const effectiveColor = activeConfig
    ? (props.selectedThemeColor || activeConfig.palette.primary)
    : "";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <ThemeCard
          label="AI 自动"
          swatchColor="#888780"
          selected={props.selectedTheme === "auto"}
          onClick={() => props.onThemeChange("auto")}
        />
        {NON_AUTO_THEMES.map((key) => {
          const theme = ARTICLE_WORKFLOW_THEME_MAP[key];
          return (
            <ThemeCard
              key={key}
              label={theme.label}
              swatchColor={theme.palette.primary}
              selected={props.selectedTheme === key}
              onClick={() => props.onThemeChange(key)}
            />
          );
        })}
      </div>

      {activeConfig && (
        <div className="flex items-center gap-3 rounded-lg border border-[#e5e7eb] bg-[#f7f8fa] px-3 py-2">
          <span className="text-xs font-semibold text-[#1d1d1f]">主色</span>
          <input
            type="color"
            aria-label="自定义主色"
            value={effectiveColor}
            onChange={(event) => props.onThemeColorChange(event.target.value)}
            className="h-8 w-12 cursor-pointer rounded border border-[#d2d2d7] bg-white p-0.5"
          />
          <span className="font-mono text-[11px] text-[#8a8a8f]">{effectiveColor}</span>
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
      )}
    </div>
  );
}

function ThemeCard(props: {
  readonly label: string;
  readonly swatchColor: string;
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={props.onClick}
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
        props.selected
          ? "border-brand bg-brand-soft text-brand-ink"
          : "border-[#d2d2d7] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]"
      }`}
    >
      <span
        className="h-4 w-4 shrink-0 rounded-full border border-black/10"
        style={{ backgroundColor: props.swatchColor }}
        aria-hidden
      />
      {props.label}
    </button>
  );
}
