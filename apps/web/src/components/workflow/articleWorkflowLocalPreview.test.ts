import { describe, expect, it } from "vitest";
import { articleWorkflowThemeThumbnail, renderArticleWorkflowLocalPreview } from "./articleWorkflowLocalPreview";

const imageManifest = [
  { slot: "cover", role: "cover", assetId: "a1", imageUrl: "https://example.test/cover.png", thumbnailUrl: "", alt: "头图", caption: "", prompt: "p" },
  { slot: "inline-1", role: "inline", assetId: "a2", imageUrl: "https://example.test/1.png", thumbnailUrl: "", alt: "细节", caption: "", prompt: "p" },
] as const;

describe("renderArticleWorkflowLocalPreview", () => {
  it("渲染非 auto 主题为带主题样式的 HTML", () => {
    const html = renderArticleWorkflowLocalPreview({
      bodyMarkdown: "开头第一段。\n\n第二段继续说明。",
      imageManifest,
      theme: "literary",
      themeColor: null,
      galleryMode: "collage",
    });
    expect(html).not.toBeNull();
    expect(html).toContain("<img");
    expect(html).toContain("cover.png");
    expect(html).toContain("开头第一段。");
  });

  it("auto 主题返回 null，回落到后端 bodyHtml", () => {
    expect(renderArticleWorkflowLocalPreview({
      bodyMarkdown: "正文。",
      imageManifest,
      theme: "auto",
      themeColor: null,
      galleryMode: "collage",
    })).toBeNull();
  });

  it("主色覆盖生效于渲染结果", () => {
    // literary 的 strong/h4 用主色，h2 是写死的装饰色
    const html = renderArticleWorkflowLocalPreview({
      bodyMarkdown: "**加粗文字** 正文。",
      imageManifest,
      theme: "literary",
      themeColor: "#123456",
      galleryMode: "collage",
    });
    expect(html).toContain("#123456");
  });

  it("画廊模式切换产生不同布局", () => {
    const markdown = "![一](https://a/1.png)\n\n![二](https://a/2.png)";
    const collage = renderArticleWorkflowLocalPreview({
      bodyMarkdown: markdown,
      imageManifest: [
        { slot: "inline-1", role: "inline", assetId: "a1", imageUrl: "https://a/1.png", thumbnailUrl: "", alt: "一", caption: "", prompt: "p" },
        { slot: "inline-2", role: "inline", assetId: "a2", imageUrl: "https://a/2.png", thumbnailUrl: "", alt: "二", caption: "", prompt: "p" },
      ],
      theme: "literary",
      themeColor: null,
      galleryMode: "collage",
    });
    const grid = renderArticleWorkflowLocalPreview({
      bodyMarkdown: markdown,
      imageManifest: [
        { slot: "inline-1", role: "inline", assetId: "a1", imageUrl: "https://a/1.png", thumbnailUrl: "", alt: "一", caption: "", prompt: "p" },
        { slot: "inline-2", role: "inline", assetId: "a2", imageUrl: "https://a/2.png", thumbnailUrl: "", alt: "二", caption: "", prompt: "p" },
      ],
      theme: "literary",
      themeColor: null,
      galleryMode: "grid",
    });
    expect(collage).not.toBe(grid);
  });
});

describe("articleWorkflowThemeThumbnail", () => {
  it("渲染固定示例正文作为缩略", () => {
    expect(articleWorkflowThemeThumbnail("literary")).toContain("标题");
    expect(articleWorkflowThemeThumbnail("auto")).toBe("");
  });
});
