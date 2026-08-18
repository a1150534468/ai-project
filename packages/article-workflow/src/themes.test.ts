import { describe, expect, it } from "vitest";
import {
  ARTICLE_WORKFLOW_THEME_MAP,
  articleWorkflowTheme,
  articleWorkflowThemeConfig,
} from "./themes.js";
import { ARTICLE_WORKFLOW_THEMES } from "./types.js";

const NON_AUTO_THEMES = ARTICLE_WORKFLOW_THEMES.filter((theme) => theme !== "auto");

describe("article workflow themes", () => {
  it("枚举含 auto 且共 6 个", () => {
    expect(ARTICLE_WORKFLOW_THEMES).toContain("auto");
    expect(ARTICLE_WORKFLOW_THEMES).toHaveLength(6);
  });

  it("未知主题回落 auto", () => {
    expect(articleWorkflowTheme("bogus")).toBe("auto");
    expect(articleWorkflowTheme(null)).toBe("auto");
    expect(articleWorkflowTheme(undefined)).toBe("auto");
    expect(articleWorkflowTheme("minimal")).toBe("minimal");
  });

  it("每套非 auto 主题的色板/字号/节奏字段齐全且非空", () => {
    for (const key of NON_AUTO_THEMES) {
      const theme = ARTICLE_WORKFLOW_THEME_MAP[key as keyof typeof ARTICLE_WORKFLOW_THEME_MAP];
      expect(theme.key).toBe(key);
      expect(theme.label.trim()).not.toBe("");
      expect(theme.description.trim()).not.toBe("");
      for (const color of Object.values(theme.palette)) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      for (const value of Object.values(theme.typography)) {
        expect(value.trim()).not.toBe("");
      }
      for (const value of Object.values(theme.rhythm)) {
        expect(value.trim()).not.toBe("");
      }
    }
  });

  it("auto 没有具体主题配置，返回 null", () => {
    expect(articleWorkflowThemeConfig("auto")).toBeNull();
    expect(articleWorkflowThemeConfig("bogus")).toBeNull();
    expect(articleWorkflowThemeConfig("minimal")?.label).toBe("极简");
  });
});
