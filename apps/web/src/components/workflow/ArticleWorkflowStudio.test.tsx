import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "../../motion/Toast";
import { ArticleWorkflowStudio } from "./ArticleWorkflowStudio";

function buildProject() {
  return {
    id: "article-1",
    sourceFormat: "markdown" as const,
    sourceText: "# 标题\n\n正文",
    generationMode: "preserve-text" as const,
    title: "咖啡机夏促",
    summary: "适合公众号摘要",
    bodyHtml: [
      '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
      '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">开头第一段。</p>',
      '<section data-yc-image-slot="cover"><img src="https://example.test/cover.png" alt="头图" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:12px;"/></section>',
      "</section>",
    ].join(""),
    imageManifestJson: [{
      slot: "cover" as const,
      role: "cover" as const,
      assetId: "asset-1",
      imageUrl: "https://example.test/cover.png",
      thumbnailUrl: "https://example.test/cover-thumb.png",
      alt: "头图",
      caption: "",
      prompt: "cover prompt",
    }],
    status: "ready" as const,
    progressStage: "ready",
    progressPercent: 100,
    progressMessage: "已生成完成",
    error: null,
    createdAt: "2026-07-08T06:00:00.000Z",
    updatedAt: "2026-07-08T06:00:00.000Z",
  };
}

describe("ArticleWorkflowStudio", () => {
  it("renders the input state with text and markdown entry", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ArticleWorkflowStudio
          token="token"
          initialHistory={[]}
          initialProject={null}
          initialBootstrapping={false}
        />
      </ToastProvider>,
    );

    expect(html).toContain("公众号图文工作流");
    expect(html).toContain("纯文本");
    expect(html).toContain("Markdown");
    expect(html).toContain("生成图文");
  });

  it("renders the editor state with preview and rewrite controls", () => {
    const project = buildProject();
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ArticleWorkflowStudio
          token="token"
          initialHistory={[{
            id: project.id,
            title: project.title,
            summary: project.summary,
            generationMode: project.generationMode,
            status: project.status,
            progressStage: project.progressStage,
            progressPercent: project.progressPercent,
            progressMessage: project.progressMessage,
            error: project.error,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          }]}
          initialProject={project}
          initialBootstrapping={false}
        />
      </ToastProvider>,
    );

    expect(html).toContain("保存修改");
    expect(html).toContain("一键复制到公众号");
    expect(html).toContain("AI 重新生成");
    expect(html).toContain("配图素材");
    expect(html).toContain("预览");
  });
});
