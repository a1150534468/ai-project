import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "../../motion/Toast";
import { ArticleWorkflowPlatformTabs } from "./ArticleWorkflowPlatformTabs";
import { ArticleWorkflowStudio } from "./ArticleWorkflowStudio";

function buildCaptionProject() {
  return {
    ...buildProject(),
    id: "article-2",
    platform: "xiaohongshu" as const,
    generationMode: "polish-text" as const,
    title: "夏天必囤的咖啡机",
    summary: "",
    bodyHtml: "",
    captionText: "第一次用就回不去了。\n\n出杯快，清洗也简单。",
    tags: ["咖啡机", "居家好物", "夏日饮品"] as readonly string[],
  };
}

function buildProject() {
  return {
    id: "article-1",
    creationMode: "source" as const,
    creationConfig: { mode: "source" as const, generateImages: true },
    sourceFormat: "markdown" as const,
    sourceText: "# 标题\n\n正文",
    generationMode: "preserve-text" as const,
    platform: "wechat" as const,
    batchId: "batch-1",
    title: "咖啡机夏促",
    summary: "适合公众号摘要",
    bodyHtml: [
      '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
      '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">开头第一段。</p>',
      '<section data-ai-assistant-image-slot="cover"><img src="https://example.test/cover.png" alt="头图" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:12px;"/></section>',
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
    captionText: "",
    tags: [] as readonly string[],
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
  it("renders the three platform switches as top-level tabs", () => {
    const wechat = buildProject();
    const xiaohongshu = buildCaptionProject();
    const douyin = { ...buildCaptionProject(), id: "article-3", platform: "douyin" as const };
    const html = renderToStaticMarkup(
      <ArticleWorkflowPlatformTabs
        projects={[wechat, xiaohongshu, douyin]}
        activePlatform="wechat"
        dirtyPlatforms={["xiaohongshu"]}
        onSelectPlatform={() => undefined}
      />,
    );

    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain("公众号");
    expect(html).toContain("小红书");
    expect(html).toContain("抖音");
  });

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

    expect(html).toContain("创建平台图文");
    expect(html).toContain("输入原文");
    expect(html).toContain("项目历史");
    expect(html).toContain("纯文本");
    expect(html).toContain("Markdown");
    // 三个平台默认全选，按钮上带数量
    expect(html).toContain("生成 3 个平台图文");
    expect(html).toContain("微信公众号");
    expect(html).toContain("小红书");
    expect(html).toContain("抖音");
    expect(html).toContain("公众号生成方式");
    expect(html).toContain("xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]");
    expect(html).not.toContain("xl:grid-cols-[220px_minmax(0,1fr)_300px]");
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
            creationMode: project.creationMode,
            platform: project.platform,
            batchId: project.batchId,
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
    expect(html).toContain("AI 重写");
    expect(html).toContain("配图素材");
    expect(html).toContain("预览");
  });

  it("renders the xiaohongshu preview first without html body controls", () => {
    const project = buildCaptionProject();
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ArticleWorkflowStudio
          token="token"
          initialHistory={[]}
          initialProject={project}
          initialBootstrapping={false}
        />
      </ToastProvider>,
    );

    expect(html).toContain("小红书");
    expect(html).toContain("预览");
    expect(html).toContain("编辑");
    expect(html).toContain("第一次用就回不去了。");
    expect(html).toContain("复制文案");
    expect(html).toContain("复制标签");
    expect(html).toContain("#咖啡机");
    expect(html).toContain('aria-label="平台配图"');
    expect(html).toContain("aspect-ratio:768 / 1024");
    expect(html).not.toContain("mdi:image-outline");
    // caption 平台不给 HTML 正文相关入口
    expect(html).not.toContain("一键复制到公众号");
    expect(html).not.toContain("复制摘要");
    expect(html).not.toContain("保持原文排版");
  });
});
