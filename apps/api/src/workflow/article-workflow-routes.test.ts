import { describe, expect, it } from "vitest";
import {
  buildArticleWorkflowApp,
  buildArticleWorkflowCaptionPlan,
  buildArticleWorkflowHtml,
  buildArticleWorkflowImageManifest,
  buildArticleWorkflowPlan,
  createArticleWorkflowLlmResponse,
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

  it("fans out one row per platform under a shared batch id", async () => {
    const scheduled: (() => Promise<void>)[] = [];
    const { app, prisma } = await buildArticleWorkflowApp({
      llmResponses: [
        createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowPlan())),
        createArticleWorkflowLlmResponse(buildArticleWorkflowHtml()),
        createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowCaptionPlan())),
        createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowCaptionPlan())),
      ],
      scheduleTask: (work) => {
        scheduled.push(work);
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "preserve-text",
        platforms: ["wechat", "xiaohongshu", "douyin", "xiaohongshu"],
      },
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    expect(data.projects.map((item: { platform: string }) => item.platform))
      .toEqual(["wechat", "xiaohongshu", "douyin"]);
    expect(data.projectId).toBe(data.projects[0].projectId);
    expect(new Set(prisma.__state.projects.map((row) => row.batchId))).toEqual(new Set([data.batchId]));
    // caption 平台不支持保留原文，落库时已被降级
    expect(prisma.__state.projects.map((row) => row.generationMode))
      .toEqual(["preserve-text", "polish-text", "polish-text"]);

    for (const work of scheduled) await work();
    expect(prisma.__state.projects[0]?.bodyHtml).toContain("data-ai-assistant-image-slot");
    expect(prisma.__state.projects[1]?.bodyHtml).toBe("");
    expect(prisma.__state.projects[1]?.captionText).toContain("第一次用就回不去了");
    // 标签前导 # 在归一化时去掉
    expect(prisma.__state.projects[1]?.tagsJson).toEqual(["咖啡机", "居家好物", "夏日饮品"]);
    expect(prisma.__state.projects.map((row) => row.status)).toEqual(["ready", "ready", "ready"]);
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

  it("returns a batch's projects ordered by creation and scoped to the owner", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [
        {
          id: "p-3", userId: "u1", platform: "douyin", batchId: "b-1", captionText: "抖音文案",
          sourceFormat: "plain-text", sourceText: "one", status: "ready", progressStage: "ready",
          progressPercent: 100,
          createdAt: new Date("2026-07-08T05:00:02.000Z"), updatedAt: new Date("2026-07-08T05:00:02.000Z"),
        },
        {
          id: "p-1", userId: "u1", platform: "wechat", batchId: "b-1",
          bodyHtml: buildArticleWorkflowHtml(), imageManifestJson: buildArticleWorkflowImageManifest(),
          sourceFormat: "plain-text", sourceText: "one", status: "ready", progressStage: "ready",
          progressPercent: 100,
          createdAt: new Date("2026-07-08T05:00:00.000Z"), updatedAt: new Date("2026-07-08T05:00:00.000Z"),
        },
        {
          id: "p-2", userId: "u1", platform: "xiaohongshu", batchId: "b-1", captionText: "小红书文案",
          tagsJson: ["咖啡机"],
          sourceFormat: "plain-text", sourceText: "one", status: "ready", progressStage: "ready",
          progressPercent: 100,
          createdAt: new Date("2026-07-08T05:00:01.000Z"), updatedAt: new Date("2026-07-08T05:00:01.000Z"),
        },
        {
          id: "p-9", userId: "u2", platform: "wechat", batchId: "b-2",
          sourceFormat: "plain-text", sourceText: "other", status: "ready", progressStage: "ready",
          progressPercent: 100,
          createdAt: new Date("2026-07-08T05:00:00.000Z"), updatedAt: new Date("2026-07-08T05:00:00.000Z"),
        },
      ],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/b-1" });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.batchId).toBe("b-1");
    expect(data.projects.map((item: { platform: string }) => item.platform))
      .toEqual(["wechat", "xiaohongshu", "douyin"]);
    expect(data.projects[1].captionText).toBe("小红书文案");
    expect(data.projects[1].tags).toEqual(["咖啡机"]);

    // 别人的批次一律 404，不泄露存在性
    const foreign = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/b-2" });
    expect(foreign.statusCode).toBe(404);
    // batch 前缀不被 /:id 抢走：同名项目 id 不存在时也走批次路由
    const missing = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/b-404" });
    expect(missing.json().error).toBe("批次不存在");
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
