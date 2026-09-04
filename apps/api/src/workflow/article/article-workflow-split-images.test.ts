import { describe, expect, it, vi } from "vitest";
import {
  buildArticleWorkflowApp,
  buildArticleWorkflowHtml,
  buildArticleWorkflowPlan,
  createArticleWorkflowLlmResponse,
  createArticleWorkflowPrismaMock,
} from "./article-workflow-test-helpers.js";

const topicConfig = {
  mode: "topic" as const,
  generateImages: false,
  topic: "在家做冰咖啡",
  keyPoints: "少量器具也能完成",
  audience: "新手",
  avoid: "不写健康功效",
  style: { mode: "preset" as const, preset: "tutorial" as const },
};

function missingManifest() {
  return [
    {
      slot: "cover" as const,
      role: "cover" as const,
      assetId: "asset-existing",
      imageUrl: "https://example.test/existing.png",
      thumbnailUrl: "https://example.test/existing-thumb.png",
      alt: "已有封面",
      caption: "",
      prompt: "existing prompt",
    },
    {
      slot: "inline-1" as const,
      role: "inline" as const,
      assetId: null,
      imageUrl: "",
      thumbnailUrl: "",
      alt: "待生成细节图",
      caption: "",
      prompt: "missing prompt",
    },
  ];
}

describe("article workflow split image generation", () => {
  it("creates topic copy with image prompts and empty slots without calling the image service", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const { app, prisma, llm } = await buildArticleWorkflowApp({
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
      url: "/api/workflow/article-workflow",
      payload: {
        creationMode: "topic",
        creationConfig: topicConfig,
        sourceFormat: "plain-text",
        sourceText: "",
        generationMode: "polish-text",
        platforms: ["wechat"],
        generateImages: false,
      },
    });

    expect(response.statusCode).toBe(201);
    await scheduledTask!();

    const project = prisma.__state.projects[0]!;
    expect(project.creationMode).toBe("topic");
    expect(project.creationConfigJson).toEqual(topicConfig);
    expect(project.sourceText).toContain("创作主题：在家做冰咖啡");
    expect(project.status).toBe("ready");
    expect(project.imageManifestJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ prompt: "cover prompt", imageUrl: "", assetId: null }),
    ]));
    expect(project.bodyHtml).toContain('data-ai-assistant-image-slot="cover"');
    expect(project.bodyHtml).not.toContain('<img src=""');
    expect(prisma.imageAsset.create).not.toHaveBeenCalled();

    const calls = llm.messages.create.mock.calls as unknown as Array<[
      { messages?: Array<{ content?: string }> },
    ]>;
    const firstPrompt = calls[0]?.[0].messages?.[0]?.content ?? "";
    expect(firstPrompt).toContain("当前任务是从创作简报原创内容");
    expect(firstPrompt).toContain("创作主题：在家做冰咖啡");
  });

  it("fills only missing slots and returns an idempotent no-op when images are complete", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const originalBody = buildArticleWorkflowHtml();
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        creationMode: "topic",
        creationConfigJson: topicConfig,
        sourceFormat: "plain-text",
        sourceText: "创作主题：在家做冰咖啡",
        generationMode: "polish-text",
        platform: "wechat",
        title: "冰咖啡教程",
        summary: "新手也能完成",
        bodyHtml: originalBody,
        imageManifestJson: missingManifest(),
        status: "ready",
        progressStage: "ready",
        progressPercent: 100,
        createdAt: new Date("2026-07-30T08:00:00.000Z"),
        updatedAt: new Date("2026-07-30T08:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({
      prisma,
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const queued = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/images/generate",
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().data.queued).toBe(true);
    await scheduledTask!();

    const project = prisma.__state.projects[0]!;
    const manifest = project.imageManifestJson as ReturnType<typeof missingManifest>;
    expect(project.status).toBe("ready");
    expect(project.error).toBeNull();
    expect(manifest[0]?.imageUrl).toBe("https://example.test/existing.png");
    expect(manifest[1]?.imageUrl).not.toBe("");
    expect(project.bodyHtml).toContain("https://example.test/existing.png");
    // 只补缺的那一张：已有封面不重出
    expect(prisma.imageAsset.create).toHaveBeenCalledTimes(1);

    const repeated = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/images/generate",
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data.queued).toBe(false);
    expect(prisma.imageAsset.create).toHaveBeenCalledTimes(1);
  });

  it("keeps confirmed copy ready when image generation fails", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        creationMode: "topic",
        creationConfigJson: topicConfig,
        sourceFormat: "plain-text",
        sourceText: "创作主题：在家做冰咖啡",
        generationMode: "polish-text",
        platform: "xiaohongshu",
        title: "冰咖啡教程",
        captionText: "先确认并保留的文案。",
        tagsJson: ["冰咖啡"],
        imageManifestJson: [{ ...missingManifest()[1], slot: "cover", role: "cover" }],
        status: "ready",
        progressStage: "ready",
        progressPercent: 100,
        createdAt: new Date("2026-07-30T08:00:00.000Z"),
        updatedAt: new Date("2026-07-30T08:00:00.000Z"),
      }],
    });
    const { app } = await buildArticleWorkflowApp({
      prisma,
      fetchFn: vi.fn(async () => new Response("upstream unavailable", { status: 503 })) as unknown as typeof fetch,
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/images/generate",
    });
    expect(response.statusCode).toBe(202);
    await scheduledTask!();

    const project = prisma.__state.projects[0]!;
    expect(project.status).toBe("ready");
    expect(project.progressStage).toBe("ready");
    expect(project.captionText).toBe("先确认并保留的文案。");
    expect(project.error).toContain("503");
  });

  it("fails the row and never starts images when imitation output is too similar", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const copied = "这是一段用于验证模仿文案原创保护是否正常工作的参考内容".repeat(4);
    const plan = {
      ...buildArticleWorkflowPlan(),
      bodyMarkdown: copied,
    };
    const { app, prisma } = await buildArticleWorkflowApp({
      llmResponses: [createArticleWorkflowLlmResponse(JSON.stringify(plan))],
      scheduleTask: (work) => {
        scheduledTask = work;
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        creationMode: "topic",
        creationConfig: {
          ...topicConfig,
          generateImages: true,
          style: { mode: "imitate", referenceText: copied },
        },
        sourceFormat: "plain-text",
        sourceText: "",
        generationMode: "polish-text",
        platforms: ["wechat"],
        generateImages: true,
      },
    });
    expect(response.statusCode).toBe(201);
    await scheduledTask!();

    expect(prisma.__state.projects[0]?.status).toBe("failed");
    expect(prisma.__state.projects[0]?.error).toContain("与参考文案过于相似");
    expect(prisma.imageAsset.create).not.toHaveBeenCalled();
  });
});
