import { describe, expect, it } from "vitest";
import {
  buildArticleWorkflowApp,
  buildArticleWorkflowHtml,
  buildArticleWorkflowImageManifest,
  buildArticleWorkflowPlan,
  createArticleWorkflowPrismaMock,
} from "./article-workflow-test-helpers.js";

describe("article-workflow routes", () => {
  it("creates a text project and finishes generation", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const { app, prisma } = await buildArticleWorkflowApp({
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "preserve-text",
      },
    });

    expect(response.statusCode).toBe(201);
    await scheduledTask!();
    expect(prisma.__state.projects[0]?.bodyHtml).toContain("data-ai-assistant-image-slot");
    expect(prisma.__state.projects[0]?.generationMode).toBe("preserve-text");
  });

  it("falls back to preserved source body when preserve-text planning rewrites the正文", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const { app, prisma } = await buildArticleWorkflowApp({
      llmResponses: [
        {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...buildArticleWorkflowPlan(),
              title: "文章标题",
              bodyMarkdown: "AI 改写后的正文。",
            }),
          }],
        },
        {
          content: [{
            type: "text",
            text: [
              '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
              '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">第一段。</p>',
              '<section data-ai-assistant-image-slot="cover"></section>',
              '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">第二段。</p>',
              '<section data-ai-assistant-image-slot="inline-1"></section>',
              "</section>",
            ].join(""),
          }],
        },
      ],
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "文章标题\n\n第一段。\n\n第二段。",
        generationMode: "preserve-text",
      },
    });

    expect(response.statusCode).toBe(201);
    await scheduledTask!();
    expect(prisma.__state.projects[0]?.status).toBe("ready");
    expect(prisma.__state.projects[0]?.title).toBe("文章标题");
    expect(prisma.__state.projects[0]?.bodyHtml).toContain("第一段。");
    expect(prisma.__state.projects[0]?.bodyHtml).not.toContain("AI 改写后的正文");
  });

  it("lists only current user's history", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [
        {
          id: "p-1",
          userId: "u1",
          sourceFormat: "plain-text",
          sourceText: "one",
          generationMode: "preserve-text",
          title: "我的项目",
          summary: "",
          bodyHtml: buildArticleWorkflowHtml(),
          imageManifestJson: buildArticleWorkflowImageManifest(),
          status: "ready",
          progressStage: "ready",
          progressPercent: 100,
          progressMessage: null,
          error: null,
          createdAt: new Date("2026-07-08T05:00:00.000Z"),
          updatedAt: new Date("2026-07-08T05:00:00.000Z"),
        },
        {
          id: "p-2",
          userId: "u2",
          sourceFormat: "plain-text",
          sourceText: "two",
          generationMode: "preserve-text",
          title: "别人的项目",
          summary: "",
          bodyHtml: buildArticleWorkflowHtml(),
          imageManifestJson: buildArticleWorkflowImageManifest(),
          status: "ready",
          progressStage: "ready",
          progressPercent: 100,
          progressMessage: null,
          error: null,
          createdAt: new Date("2026-07-08T05:00:00.000Z"),
          updatedAt: new Date("2026-07-08T05:00:00.000Z"),
        },
      ],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/history" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].id).toBe("p-1");
  });

  it("saves edited html via PATCH without charging", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "preserve-text",
        title: "旧标题",
        summary: "旧摘要",
        bodyHtml: buildArticleWorkflowHtml(),
        imageManifestJson: buildArticleWorkflowImageManifest(),
        status: "ready",
        progressStage: "ready",
        progressPercent: 100,
        progressMessage: null,
        error: null,
        createdAt: new Date("2026-07-08T05:00:00.000Z"),
        updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app, billing } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/workflow/article-workflow/p-1",
      payload: {
        title: "新标题",
        summary: "新摘要",
        bodyHtml: [
          '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
          '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">开头第一段。</p>',
          '<section data-ai-assistant-image-slot="cover"></section>',
          '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">第二段继续说明。</p>',
          "</section>",
        ].join(""),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.title).toBe("新标题");
    expect(response.json().data.bodyHtml).toContain("cover.png");
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(billing.chargeResource).not.toHaveBeenCalled();
  });

  it("submits rewrite with generation mode and regenerateImages flag", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        sourceFormat: "plain-text",
        sourceText: "原文内容",
        generationMode: "preserve-text",
        title: "旧标题",
        summary: "",
        bodyHtml: buildArticleWorkflowHtml(),
        imageManifestJson: buildArticleWorkflowImageManifest(),
        status: "ready",
        progressStage: "ready",
        progressPercent: 100,
        progressMessage: null,
        error: null,
        createdAt: new Date("2026-07-08T05:00:00.000Z"),
        updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({
      prisma,
      llmResponses: [
        {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...buildArticleWorkflowPlan(),
              bodyMarkdown: "重写后的正文。",
            }),
          }],
        },
        {
          content: [{
            type: "text",
            text: [
              '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
              '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">重写后的正文。</p>',
              '<section data-ai-assistant-image-slot="cover"></section>',
              '<section data-ai-assistant-image-slot="inline-1"></section>',
              "</section>",
            ].join(""),
          }],
        },
      ],
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/rewrite",
      payload: {
        instruction: "整体语气更像真实种草",
        generationMode: "polish-text",
        regenerateImages: false,
      },
    });

    expect(response.statusCode).toBe(200);
    await scheduledTask!();
    expect(prisma.__state.projects[0]?.generationMode).toBe("polish-text");
    expect(prisma.__state.projects[0]?.bodyHtml).toContain("重写后的正文");
  });

  it("rejects regenerate-image for a missing slot", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        sourceFormat: "plain-text",
        sourceText: "原文内容",
        generationMode: "preserve-text",
        title: "标题",
        summary: "",
        bodyHtml: buildArticleWorkflowHtml(),
        imageManifestJson: buildArticleWorkflowImageManifest(),
        status: "ready",
        progressStage: "ready",
        progressPercent: 100,
        progressMessage: null,
        error: null,
        createdAt: new Date("2026-07-08T05:00:00.000Z"),
        updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/images/inline-4/regenerate",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});
