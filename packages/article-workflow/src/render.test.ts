import { describe, expect, it } from "vitest";
import { articleWorkflowMarkdownWithImages, renderArticleWorkflowHtml } from "./render.js";
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

describe("articleWorkflowMarkdownWithImages", () => {
  it("封面在前、正文居中、内页图连续排在末尾", () => {
    const markdown = articleWorkflowMarkdownWithImages("正文段落。", [
      { slot: "inline-1", imageUrl: "https://a/1.png" },
      { slot: "cover", imageUrl: "https://a/cover.png" },
      { slot: "inline-2", imageUrl: "https://a/2.png" },
    ]);
    const lines = markdown.split("\n");
    expect(lines[0]).toContain("cover.png");
    expect(markdown).toContain("正文段落。");
    expect(lines[lines.length - 1]).toContain("2.png");
    // 封面与内页图之间隔着正文，不会被拼进画廊
    const coverIndex = markdown.indexOf("cover.png");
    const bodyIndex = markdown.indexOf("正文段落。");
    const inlineIndex = markdown.indexOf("1.png");
    expect(coverIndex).toBeLessThan(bodyIndex);
    expect(bodyIndex).toBeLessThan(inlineIndex);
  });

  it("图片用空 alt，正文可见文字不受图注污染", () => {
    const markdown = articleWorkflowMarkdownWithImages("正文段落。", [
      { slot: "cover", imageUrl: "https://a/cover.png" },
      { slot: "inline-1", imageUrl: "https://a/1.png" },
      { slot: "inline-2", imageUrl: "https://a/2.png" },
    ]);
    const html = renderArticleWorkflowHtml(markdown, literary, { galleryMode: "collage" });
    // 正文文字仍在，图片本身不产生可见文字
    expect(html).toContain("正文段落。");
    expect(html).toContain("<img");
    expect(html).toContain("cover.png");
  });

  it("无图清单时原样返回正文", () => {
    expect(articleWorkflowMarkdownWithImages("正文。", [])).toBe("正文。");
    expect(articleWorkflowMarkdownWithImages("正文。", [{ slot: "cover", imageUrl: "" }])).toBe("正文。");
  });

  it("带空格/括号的地址被尖括号保护，可正常渲染", () => {
    const markdown = articleWorkflowMarkdownWithImages("正文。", [
      { slot: "cover", imageUrl: "https://a/img (1).png" },
    ]);
    const html = renderArticleWorkflowHtml(markdown, literary);
    // markdown-it 会把空格编码成 %20，括号得以保留——关键是不能因括号把语法拆坏
    expect(html).toContain("https://a/img%20(1).png");
  });
});
