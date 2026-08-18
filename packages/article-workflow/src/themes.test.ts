import { describe, expect, it } from "vitest";
import {
  ARTICLE_WORKFLOW_THEME_MAP,
  articleWorkflowTheme,
  articleWorkflowThemeConfig,
  buildStyles,
  themes,
} from "./themes.js";
import { ARTICLE_WORKFLOW_THEMES } from "./types.js";

describe("article workflow themes（md-wechat 移植）", () => {
  it("有 26 套主题，id 唯一且与枚举一致", () => {
    expect(themes).toHaveLength(26);
    const ids = themes.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(26);
    // 枚举 = auto + 26 套
    expect(ARTICLE_WORKFLOW_THEMES).toHaveLength(27);
    for (const id of ids) {
      expect(ARTICLE_WORKFLOW_THEMES as readonly string[]).toContain(id);
    }
  });

  it("每套主题字段齐全，buildStyles 能生成完整样式", () => {
    for (const theme of themes) {
      expect(theme.name.trim()).not.toBe("");
      expect(theme.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(typeof theme.styles).toBe("function");
      const styles = buildStyles(theme);
      expect(styles.container).toContain("font-size");
      expect(styles.h1).not.toBe("");
      expect(styles.p).not.toBe("");
      expect(styles.blockquote).not.toBe("");
    }
  });

  it("未知主题回落 auto，auto 无具体主题", () => {
    expect(articleWorkflowTheme("bogus")).toBe("auto");
    expect(articleWorkflowTheme(null)).toBe("auto");
    expect(articleWorkflowTheme("literary")).toBe("literary");
    expect(articleWorkflowThemeConfig("auto")).toBeNull();
    expect(articleWorkflowThemeConfig("bogus")).toBeNull();
    expect(articleWorkflowThemeConfig("literary")?.name).toBe("纸上散文");
  });

  it("buildStyles 支持主色覆盖（accent）", () => {
    const base = buildStyles(ARTICLE_WORKFLOW_THEME_MAP.literary);
    const accent = buildStyles(ARTICLE_WORKFLOW_THEME_MAP.literary, { accent: "#123456" });
    // strong/a 用 ${p} 引用主色，覆盖后应换成 accent
    expect(accent.strong).toContain("#123456");
    expect(base.strong).toContain("#9c4b3f");
  });

  it("buildStyles 支持字号与字体覆盖", () => {
    const styles = buildStyles(ARTICLE_WORKFLOW_THEME_MAP.literary, {
      fontSize: 18,
      fontFamily: "serif",
    });
    expect(styles.container).toContain("font-size:18px");
    expect(styles.container).toContain("Georgia");
  });
});
