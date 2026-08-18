import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleWorkflowThemePicker } from "./ArticleWorkflowThemePicker";

describe("ArticleWorkflowThemePicker", () => {
  it("renders the auto card plus all preset themes", () => {
    const html = renderToStaticMarkup(
      <ArticleWorkflowThemePicker
        selectedTheme="auto"
        selectedThemeColor=""
        onThemeChange={() => undefined}
        onThemeColorChange={() => undefined}
      />,
    );
    expect(html).toContain("AI 自动");
    expect(html).toContain("极简");
    expect(html).toContain("商务");
    expect(html).toContain("暖阳");
    expect(html).toContain("清新");
    expect(html).toContain("杂志");
  });

  it("hides the color picker when auto is selected", () => {
    const html = renderToStaticMarkup(
      <ArticleWorkflowThemePicker
        selectedTheme="auto"
        selectedThemeColor=""
        onThemeChange={() => undefined}
        onThemeColorChange={() => undefined}
      />,
    );
    expect(html).not.toContain("自定义主色");
  });

  it("shows the color picker seeded with the theme default color", () => {
    const html = renderToStaticMarkup(
      <ArticleWorkflowThemePicker
        selectedTheme="magazine"
        selectedThemeColor=""
        onThemeChange={() => undefined}
        onThemeColorChange={() => undefined}
      />,
    );
    expect(html).toContain("自定义主色");
    expect(html).toContain("#c0392b");
  });

  it("prefers the user override color over the theme default", () => {
    const html = renderToStaticMarkup(
      <ArticleWorkflowThemePicker
        selectedTheme="magazine"
        selectedThemeColor="#123456"
        onThemeChange={() => undefined}
        onThemeColorChange={() => undefined}
      />,
    );
    expect(html).toContain("#123456");
    expect(html).toContain("恢复默认");
  });
});
