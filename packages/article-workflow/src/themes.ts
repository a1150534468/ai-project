import {
  ARTICLE_WORKFLOW_THEMES,
  type ArticleWorkflowThemeKey,
} from "./types.js";

/**
 * 公众号排版视觉主题：layout 步骤的约束来源。
 *
 * 这是「视觉排版主题」的唯一事实来源，与「内容风格」（TopicStyle，preset/custom/imitate）
 * 严格区分：TopicStyle 决定 plan 阶段写什么调性，这里决定 layout 阶段用什么颜色/字号/节奏。
 *
 * 服务端 prompt 注入、前端主题选择卡片都读这里，不要在各自模块再抄一份。
 */

export interface ArticleWorkflowTheme {
  /** 主题 key，不含 "auto"（auto 是「AI 自由发挥」的特殊值，不是一套具体主题）。 */
  readonly key: Exclude<ArticleWorkflowThemeKey, "auto">;
  readonly label: string;
  /** 自然语言风格描述，注入 layout prompt，告诉模型这套主题的观感。 */
  readonly description: string;
  readonly palette: {
    /** 主色：强调/标题/链接。可被用户 themeColor 覆盖。 */
    readonly primary: string;
    /** 辅色：背景块/分隔线。 */
    readonly secondary: string;
    /** 页面底色。 */
    readonly background: string;
    /** 正文文字色。 */
    readonly text: string;
    /** 弱化文字色（摘要、说明、图注）。 */
    readonly muted: string;
    /** 强调背景（引用块/卡片底）。 */
    readonly accentBg: string;
  };
  readonly typography: {
    readonly baseFontSize: string;
    readonly lineHeight: string;
    readonly letterSpacing: string;
    /** 标题字号相对正文的倍数描述，注入 prompt 用自然语言而非精确数值。 */
    readonly headingScale: string;
  };
  readonly rhythm: {
    readonly sectionPadding: string;
    readonly radius: string;
    readonly borderWidth: string;
  };
}

export const ARTICLE_WORKFLOW_THEME_MAP: Readonly<
  Record<Exclude<ArticleWorkflowThemeKey, "auto">, ArticleWorkflowTheme>
> = {
  minimal: {
    key: "minimal",
    label: "极简",
    description: "极简黑白灰，大留白、细边框，克制冷静，靠内容本身说话。",
    palette: {
      primary: "#1d1d1f",
      secondary: "#e5e7eb",
      background: "#ffffff",
      text: "#333333",
      muted: "#8a8a8f",
      accentBg: "#f5f5f7",
    },
    typography: {
      baseFontSize: "15px",
      lineHeight: "1.8",
      letterSpacing: "0.01em",
      headingScale: "1.4",
    },
    rhythm: {
      sectionPadding: "16px 20px",
      radius: "4px",
      borderWidth: "1px",
    },
  },
  business: {
    key: "business",
    label: "商务",
    description: "商务专业风，深蓝主色，结构清晰，强调重点结论。",
    palette: {
      primary: "#185fa5",
      secondary: "#b5d4f4",
      background: "#ffffff",
      text: "#1d1d1f",
      muted: "#6e6e73",
      accentBg: "#e6f1fb",
    },
    typography: {
      baseFontSize: "15px",
      lineHeight: "1.75",
      letterSpacing: "0",
      headingScale: "1.5",
    },
    rhythm: {
      sectionPadding: "16px 20px",
      radius: "6px",
      borderWidth: "1px",
    },
  },
  warm: {
    key: "warm",
    label: "暖阳",
    description: "暖橙亲和，暖白底，行距宽松，生活化、有人情味。",
    palette: {
      primary: "#e08b1c",
      secondary: "#fac775",
      background: "#fffaf5",
      text: "#3a2f24",
      muted: "#8a7a66",
      accentBg: "#faeeda",
    },
    typography: {
      baseFontSize: "15px",
      lineHeight: "1.85",
      letterSpacing: "0.01em",
      headingScale: "1.5",
    },
    rhythm: {
      sectionPadding: "18px 20px",
      radius: "10px",
      borderWidth: "1px",
    },
  },
  fresh: {
    key: "fresh",
    label: "清新",
    description: "浅绿清新，清爽轻盈，圆角柔和，适合生活方式与成长类内容。",
    palette: {
      primary: "#1d9e75",
      secondary: "#9fe1cb",
      background: "#ffffff",
      text: "#1d1d1f",
      muted: "#6e6e73",
      accentBg: "#e1f5ee",
    },
    typography: {
      baseFontSize: "15px",
      lineHeight: "1.8",
      letterSpacing: "0.01em",
      headingScale: "1.5",
    },
    rhythm: {
      sectionPadding: "16px 20px",
      radius: "8px",
      borderWidth: "1px",
    },
  },
  magazine: {
    key: "magazine",
    label: "杂志",
    description: "杂志感，大标题强调，红色点缀，节奏感强，适合观点与深度内容。",
    palette: {
      primary: "#c0392b",
      secondary: "#f5c4b3",
      background: "#ffffff",
      text: "#1d1d1f",
      muted: "#6e6e73",
      accentBg: "#fbeaea",
    },
    typography: {
      baseFontSize: "15px",
      lineHeight: "1.7",
      letterSpacing: "0.02em",
      headingScale: "1.8",
    },
    rhythm: {
      sectionPadding: "16px 20px",
      radius: "2px",
      borderWidth: "2px",
    },
  },
};

function isArticleWorkflowThemeKey(value: unknown): value is ArticleWorkflowThemeKey {
  return typeof value === "string"
    && (ARTICLE_WORKFLOW_THEMES as readonly string[]).includes(value);
}

/** 未知主题一律回落 auto，保证存量数据与旧客户端不炸。 */
export function articleWorkflowTheme(key: unknown): ArticleWorkflowThemeKey {
  return isArticleWorkflowThemeKey(key) ? key : "auto";
}

/**
 * 取具体主题配置；auto 返回 null（表示「不注入，AI 自由发挥」）。
 * 调用方拿 null 判断要不要往 layout prompt 里追加风格段。
 */
export function articleWorkflowThemeConfig(key: unknown): ArticleWorkflowTheme | null {
  const theme = articleWorkflowTheme(key);
  return theme === "auto" ? null : ARTICLE_WORKFLOW_THEME_MAP[theme];
}
