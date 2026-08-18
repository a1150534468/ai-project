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

interface ThemePreview {
  readonly background: string;
  readonly text: string;
  readonly primary: string;
}

export function ArticleWorkflowThemePicker(props: ArticleWorkflowThemePickerProps) {
  const activeConfig = props.selectedTheme === "auto"
    ? null
    : ARTICLE_WORKFLOW_THEME_MAP[props.selectedTheme];
  const effectiveColor = activeConfig
    ? (props.selectedThemeColor || activeConfig.palette.primary)
    : "";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <ThemeCard
          label="AI 自动"
          preview={{ background: "#f5f5f7", text: "#1d1d1f", primary: "#888780" }}
          selected={props.selectedTheme === "auto"}
          onClick={() => props.onThemeChange("auto")}
        />
        {NON_AUTO_THEMES.map((key) => {
          const theme = ARTICLE_WORKFLOW_THEME_MAP[key];
          return (
            <ThemeCard
              key={key}
              label={theme.label}
              preview={{
                background: theme.palette.background,
                text: theme.palette.text,
                primary: theme.palette.primary,
              }}
              selected={props.selectedTheme === key}
              onClick={() => props.onThemeChange(key)}
            />
          );
        })}
      </div>

      {activeConfig && (
        <div className="flex items-center gap-3 rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] px-3 py-2">
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

/** 主题卡片：用主题色渲染一个迷你排版示意（主色标题条 + 正文段落条），替代单调的色块。 */
function ThemeCard(props: {
  readonly label: string;
  readonly preview: ThemePreview;
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  const { preview } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={props.onClick}
      className={`min-w-0 rounded-xl border p-2 text-left transition ${
        props.selected ? "border-brand ring-1 ring-brand/20" : "border-[#e1e5e3] hover:border-[#cbd3d0]"
      }`}
    >
      <span className="block rounded-lg p-2" style={{ backgroundColor: preview.background }} aria-hidden>
        <span className="block h-1.5 w-3/4 rounded-sm" style={{ backgroundColor: preview.primary }} />
        <span className="mt-1.5 block h-1 w-full rounded-sm" style={{ backgroundColor: preview.text, opacity: 0.35 }} />
        <span className="mt-1 block h-1 w-5/6 rounded-sm" style={{ backgroundColor: preview.text, opacity: 0.35 }} />
        <span className="mt-1 block h-1 w-full rounded-sm" style={{ backgroundColor: preview.text, opacity: 0.35 }} />
      </span>
      <span className="mt-1.5 block truncate text-xs font-semibold text-[#1d1d1f]">{props.label}</span>
    </button>
  );
}
