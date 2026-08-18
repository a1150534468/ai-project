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

  it("stores theme and themeColor on create, defaults caption rows to auto", async () => {
    const scheduled: (() => Promise<void>)[] = [];
    const { app, prisma } = await buildArticleWorkflowApp({
      llmResponses: [
        createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowPlan())),
        createArticleWorkflowLlmResponse(buildArticleWorkflowHtml()),
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
        platforms: ["wechat", "xiaohongshu"],
        theme: "magazine",
        themeColor: "#123456",
      },
    });

    expect(response.statusCode).toBe(201);
    // wechat 行存用户主题与主色，caption 行统一存 auto/null
    expect(prisma.__state.projects.map((row) => row.theme)).toEqual(["magazine", "auto"]);
    expect(prisma.__state.projects[0]?.themeColor).toBe("#123456");
    expect(prisma.__state.projects[1]?.themeColor).toBeNull();

    for (const work of scheduled) await work();
    expect(prisma.__state.projects[0]?.bodyHtml).toContain("data-ai-assistant-image-slot");
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

  it("keeps the other platforms running when one row's reserve fails on balance", async () => {
    const scheduled: (() => Promise<void>)[] = [];
    const { app, prisma, billing } = await buildArticleWorkflowApp({
      llmResponses: [
        createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowCaptionPlan())),
        createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowCaptionPlan())),
      ],
      scheduleTask: (work) => {
        scheduled.push(work);
      },
    });
    // 扣费发生在异步 runner 里，不在 create 请求里：余额不足只能让那一行 failed
    billing.reserveResource.mockRejectedValueOnce(new Error("余额不足"));

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        platforms: ["wechat", "xiaohongshu", "douyin"],
      },
    });

    // create 一定是 201：三行都已落库，不存在只建一半的批次
    expect(response.statusCode).toBe(201);
    expect(response.json().data.projects).toHaveLength(3);
    expect(prisma.__state.projects.map((row) => row.status)).toEqual(["generating", "generating", "generating"]);

    for (const work of scheduled) await work();

    expect(prisma.__state.projects.map((row) => row.status)).toEqual(["failed", "ready", "ready"]);
    expect(prisma.__state.projects[0]?.error).toContain("余额不足");
    // 没 reserve 成功就没有可退的单，也不该留悬空 operationId
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(prisma.__state.projects[0]?.billingOperationId ?? null).toBeNull();
    expect(prisma.__state.projects[1]?.captionText).toContain("第一次用就回不去了");
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
          id: "p-3", userId: "u1", platform: "douyin", batchId: "b-1", captionText: "抖音文案", theme: "bogus",
          sourceFormat: "plain-text", sourceText: "one", status: "ready", progressStage: "ready",
          progressPercent: 100,
          createdAt: new Date("2026-07-08T05:00:02.000Z"), updatedAt: new Date("2026-07-08T05:00:02.000Z"),
        },
        {
          id: "p-1", userId: "u1", platform: "wechat", batchId: "b-1",
          theme: "magazine", themeColor: "#123456",
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
    // theme 透传 + themeColor 透传 + 脏 theme 归一化回落 auto
    expect(data.projects[0].theme).toBe("magazine");
    expect(data.projects[0].themeColor).toBe("#123456");
    expect(data.projects[2].theme).toBe("auto");

    // 别人的批次一律 404，不泄露存在性
    const foreign = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/b-2" });
    expect(foreign.statusCode).toBe(404);
    // batch 前缀不被 /:id 抢走：同名项目 id 不存在时也走批次路由
    const missing = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/b-404" });
    expect(missing.json().error).toBe("批次不存在");
  });

  it("deletes the current user's entire batch without touching another user's rows", async () => {
    const createdAt = new Date("2026-07-08T05:00:00.000Z");
    const prisma = createArticleWorkflowPrismaMock({
      projects: [
        {
          id: "p-1", userId: "u1", batchId: "b-1", platform: "wechat",
          sourceFormat: "plain-text", sourceText: "one", status: "ready",
          createdAt, updatedAt: createdAt,
        },
        {
          id: "p-2", userId: "u1", batchId: "b-1", platform: "xiaohongshu",
          sourceFormat: "plain-text", sourceText: "one", status: "failed",
          createdAt, updatedAt: createdAt,
        },
        {
          id: "p-foreign", userId: "u2", batchId: "b-1", platform: "douyin",
          sourceFormat: "plain-text", sourceText: "other", status: "ready",
          createdAt, updatedAt: createdAt,
        },
      ],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({ method: "DELETE", url: "/api/workflow/article-workflow/p-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ deleted: 2, batchId: "b-1" });
    expect(prisma.__state.projects.map((row) => row.id)).toEqual(["p-foreign"]);
  });

  it("deletes a standalone project and returns 404 for an unowned project", async () => {
    const createdAt = new Date("2026-07-08T05:00:00.000Z");
    const prisma = createArticleWorkflowPrismaMock({
      projects: [
        {
          id: "p-1", userId: "u1", batchId: null,
          sourceFormat: "plain-text", sourceText: "one", status: "ready",
          createdAt, updatedAt: createdAt,
        },
        {
          id: "p-2", userId: "u2", batchId: null,
          sourceFormat: "plain-text", sourceText: "other", status: "ready",
          createdAt, updatedAt: createdAt,
        },
      ],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    const deleted = await app.inject({ method: "DELETE", url: "/api/workflow/article-workflow/p-1" });
    const unowned = await app.inject({ method: "DELETE", url: "/api/workflow/article-workflow/p-2" });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toEqual({ deleted: 1, batchId: null });
    expect(unowned.statusCode).toBe(404);
    expect(prisma.__state.projects.map((row) => row.id)).toEqual(["p-2"]);
  });

  it("refuses to delete a batch while any platform is still busy", async () => {
    const createdAt = new Date("2026-07-08T05:00:00.000Z");
    const prisma = createArticleWorkflowPrismaMock({
      projects: [
        {
          id: "p-1", userId: "u1", batchId: "b-1", platform: "wechat",
          sourceFormat: "plain-text", sourceText: "one", status: "ready",
          createdAt, updatedAt: createdAt,
        },
        {
          id: "p-2", userId: "u1", batchId: "b-1", platform: "xiaohongshu",
          sourceFormat: "plain-text", sourceText: "one", status: "revising",
          createdAt, updatedAt: createdAt,
        },
      ],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({ method: "DELETE", url: "/api/workflow/article-workflow/p-1" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("正在处理中");
    expect(prisma.articleWorkflowProject.deleteMany).not.toHaveBeenCalled();
    expect(prisma.__state.projects).toHaveLength(2);
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

  it("拒绝把正文整体清空的保存，库里内容不变", async () => {
    // 回归：编辑器把它不认识的 section 规范化成一串空段落，自动保存写回库里，成品被冲掉。
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
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/workflow/article-workflow/p-1",
      payload: {
        title: "旧标题",
        summary: "旧摘要",
        bodyHtml: "<p><br/></p><p><br/></p><p><br/></p>",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("正文文字会被整体清空");
    expect(prisma.articleWorkflowProject.update).not.toHaveBeenCalled();
  });

  it("拒绝把图片槽位全部拍平的保存", async () => {
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
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/workflow/article-workflow/p-1",
      payload: {
        title: "旧标题",
        summary: "旧摘要",
        // 文字都在，但 section 和 data-* 被拍平，槽位锚点没了
        bodyHtml: "<p>开头第一段。第二段继续说明。</p>",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("图片位置会全部丢失");
    expect(prisma.articleWorkflowProject.update).not.toHaveBeenCalled();
  });

  it("saves a caption project without touching the html guard", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1", userId: "u1", platform: "xiaohongshu", batchId: "b-1",
        captionText: "旧文案", tagsJson: ["旧标签"],
        imageManifestJson: buildArticleWorkflowImageManifest(),
        sourceFormat: "plain-text", sourceText: "原文内容", status: "ready", progressStage: "ready",
        progressPercent: 100,
        createdAt: new Date("2026-07-08T05:00:00.000Z"), updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app, billing } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/workflow/article-workflow/p-1",
      payload: {
        title: "新标题",
        captionText: "新文案第一行\n第二行",
        tags: ["咖啡机", "居家"],
        // caption 项目不吃 bodyHtml，传了也被忽略
        bodyHtml: "<div>随便写的非法片段",
      },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.captionText).toBe("新文案第一行\n第二行");
    expect(data.tags).toEqual(["咖啡机", "居家"]);
    expect(data.bodyHtml).toBe("");
    expect(data.summary).toBe("新文案第一行");
    expect(billing.reserveResource).not.toHaveBeenCalled();
  });

  it("downgrades preserve-text rewrite to polish-text on caption platforms", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1", userId: "u1", platform: "xiaohongshu", batchId: "b-1", captionText: "旧文案",
        imageManifestJson: buildArticleWorkflowImageManifest(),
        sourceFormat: "plain-text", sourceText: "原文内容", status: "ready", progressStage: "ready",
        progressPercent: 100,
        createdAt: new Date("2026-07-08T05:00:00.000Z"), updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({
      prisma,
      llmResponses: [createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowCaptionPlan()))],
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/rewrite",
      payload: { instruction: "更口语一点", generationMode: "preserve-text", regenerateImages: false },
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.__state.projects[0]?.generationMode).toBe("polish-text");
    await scheduledTask!();
    // 改稿只花一次 LLM 调用：没有排版轮，也就不需要第二个响应
    expect(prisma.__state.projects[0]?.status).toBe("ready");
    expect(prisma.__state.projects[0]?.captionText).toContain("第一次用就回不去了");
    expect(prisma.__state.projects[0]?.bodyHtml).toBe("");
  });

  it("regenerates a caption project image at the platform size", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1", userId: "u1", platform: "xiaohongshu", batchId: "b-1", captionText: "文案",
        imageManifestJson: buildArticleWorkflowImageManifest(),
        sourceFormat: "plain-text", sourceText: "原文内容", status: "ready", progressStage: "ready",
        progressPercent: 100,
        createdAt: new Date("2026-07-08T05:00:00.000Z"), updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/images/cover/regenerate",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.__state.imageAssets[0]?.size).toBe("768x1024");
    expect(prisma.__state.projects[0]?.bodyHtml).toBe("");
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

  it("rewrite reuses the stored theme for the layout call", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        sourceFormat: "plain-text",
        sourceText: "原文内容",
        generationMode: "preserve-text",
        theme: "magazine",
        themeColor: null,
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
    const { app, llm } = await buildArticleWorkflowApp({
      prisma,
      llmResponses: [
        createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowPlan())),
        createArticleWorkflowLlmResponse(buildArticleWorkflowHtml()),
      ],
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/rewrite",
      payload: { instruction: "换个风格", generationMode: "polish-text", regenerateImages: false },
    });

    expect(response.statusCode).toBe(200);
    await scheduledTask!();
    // 第二次 LLM 调用是 layout，system prompt 应带上杂志主题的默认主色
    const createMock = llm.messages.create as unknown as {
      mock: { calls: [{ system?: string }][] };
    };
    const layoutSystem = createMock.mock.calls[1]?.[0]?.system;
    expect(layoutSystem).toContain("#c0392b");
    expect(layoutSystem).toContain("Visual style theme");
  });

  it("refuses to save a failed project so autosave can't erase the failure reason", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        platform: "wechat",
        sourceFormat: "plain-text",
        sourceText: "原文内容",
        generationMode: "preserve-text",
        title: "",
        summary: "",
        bodyHtml: "",
        imageManifestJson: [],
        status: "failed",
        progressStage: "failed",
        progressPercent: 0,
        progressMessage: "生成失败",
        error: "403 Access to model denied",
        createdAt: new Date("2026-07-08T05:00:00.000Z"),
        updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });

    // 前端富文本编辑器打开失败行时会自动保存一次空正文，这一路必须被挡住
    const response = await app.inject({
      method: "PATCH",
      url: "/api/workflow/article-workflow/p-1",
      payload: { title: "未命名图文", bodyHtml: "<p><br/></p>" },
    });

    expect(response.statusCode).toBe(409);
    expect(prisma.__state.projects[0]?.status).toBe("failed");
    expect(prisma.__state.projects[0]?.error).toContain("403");
    expect(prisma.__state.projects[0]?.bodyHtml).toBe("");
  });

  it("retries a failed project from its stored source text", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        platform: "xiaohongshu",
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "polish-text",
        title: "",
        summary: "",
        bodyHtml: "",
        captionText: "",
        tagsJson: [],
        imageManifestJson: [],
        status: "failed",
        progressStage: "failed",
        progressPercent: 0,
        progressMessage: "生成失败",
        error: "403 Access to model denied",
        createdAt: new Date("2026-07-08T05:00:00.000Z"),
        updatedAt: new Date("2026-07-08T05:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({
      prisma,
      llmResponses: [createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowCaptionPlan()))],
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/retry",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    // 重试一按下就得清掉上一次的失败痕迹，否则界面仍旧显示旧原因
    expect(prisma.__state.projects[0]?.status).toBe("generating");
    expect(prisma.__state.projects[0]?.error).toBeNull();

    await scheduledTask!();
    expect(prisma.__state.projects[0]?.status).toBe("ready");
    expect(prisma.__state.projects[0]?.captionText).toContain("第一次用就回不去了");
  });

  it("rejects retry for a project that never failed", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        platform: "wechat",
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
      url: "/api/workflow/article-workflow/p-1/retry",
      payload: {},
    });

    // 成品行要改稿走 rewrite，不该借重试白跑一次扣费
    expect(response.statusCode).toBe(409);
    expect(prisma.__state.projects[0]?.bodyHtml).toContain("data-ai-assistant-image-slot");
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
