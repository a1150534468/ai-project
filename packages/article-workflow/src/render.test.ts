import { describe, expect, it } from "vitest";
import { renderArticleWorkflowHtml } from "./render.js";
import { ARTICLE_WORKFLOW_THEME_MAP } from "./themes.js";

const literary = ARTICLE_WORKFLOW_THEME_MAP.literary!;

describe("renderArticleWorkflowHtml", () => {
  it("渲染标题、段落、列表、引用为内联 CSS HTML", () => {
    const html = renderArticleWorkflowHtml(
      ["## 二级标题", "", "正文段落。", "", "- 列表项一", "- 列表项二", "", "> 引用内容"].join("\n"),
      literary,
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<p");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<blockquote");
    expect(html).toContain("style=");
    expect(html).toContain("二级标题");
    expect(html).toContain("正文段落。");
    expect(html).toContain("引用内容");
  });

  it("行内样式（加粗/斜体/删除线/高亮/行内代码）输出对应标签", () => {
    const html = renderArticleWorkflowHtml("**加粗** *斜体* ~~删除~~ ==高亮== `代码`", literary);
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html).toContain("<s");
    expect(html).toContain("<mark");
    expect(html).toContain("<code");
    expect(html).toContain("加粗");
    expect(html).toContain("斜体");
    expect(html).toContain("删除");
    expect(html).toContain("高亮");
  });

  it("连续图片拼成画廊，三种模式都可用", () => {
    const md = "![一](https://a/1.png)\n\n![二](https://a/2.png)\n\n![三](https://a/3.png)";
    const collage = renderArticleWorkflowHtml(md, literary, { galleryMode: "collage" });
    const grid = renderArticleWorkflowHtml(md, literary, { galleryMode: "grid" });
    const stack = renderArticleWorkflowHtml(md, literary, { galleryMode: "stack" });
    expect(collage).toContain('data-gallery-mode="collage"');
    expect(grid).toContain('data-gallery-mode="grid"');
    expect(stack).toContain('data-gallery-mode="stack"');
    for (const html of [collage, grid, stack]) {
      expect(html).toContain("<img");
    }
  });

  it("表格渲染为带横向滚动容器的表格", () => {
    const html = renderArticleWorkflowHtml("| A | B |\n| - | - |\n| 1 | 2 |", literary);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("主题切换产出不同样式", () => {
    const md = "## 标题\n\n正文。";
    const a = renderArticleWorkflowHtml(md, literary);
    const b = renderArticleWorkflowHtml(md, ARTICLE_WORKFLOW_THEME_MAP["swiss-index"]!);
    expect(a).not.toBe(b);
  });
});
