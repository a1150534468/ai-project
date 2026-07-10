import { describe, expect, it, vi } from "vitest";
import {
  buildArticleWorkflowApp,
  buildArticleWorkflowHtml,
  buildArticleWorkflowImageManifest,
  createArticleWorkflowPrismaMock,
} from "./article-workflow-test-helpers.js";

describe("article-workflow billing", () => {
  it("returns workflow pricing with article text and 1K image entries", async () => {
    const { app } = await buildArticleWorkflowApp({
      priceRows: [
        {
          resourceKey: "article_workflow_text_output",
          displayName: "公众号图文生成",
          pricingType: "PER_UNIT",
          rate: 3,
          perUnits: 1000,
          enabled: true,
        },
        {
          resourceKey: "image_generation_1k",
          displayName: "图片生成 1K",
          pricingType: "PER_UNIT",
          rate: 12,
          perUnits: 1,
          enabled: true,
        },
      ],
    });

    const response = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/pricing" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.text.rate).toBe(3);
    expect(response.json().data.image1k.rate).toBe(12);
    expect(response.json().data.maxImages).toBe(5);
  });

  it("charges text and image resources during a successful generation run", async () => {
    let scheduled = false;
    let scheduledTask: () => Promise<void> = async () => {
      throw new Error("scheduled task missing");
    };
    const { app, prisma, billing } = await buildArticleWorkflowApp({
      scheduleTask: (work) => {
        scheduled = true;
        scheduledTask = work;
      },
    });

    await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "preserve-text",
      },
    });
    expect(scheduled).toBe(true);
    await scheduledTask();

    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "article_workflow_text_output",
    }));
    expect(billing.settleResource).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "article_workflow_text_output",
    }));
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "image_generation_1k",
      units: 1,
    }));
    expect(prisma.__state.projects[0]?.status).toBe("ready");
  });

  it("refunds image charges when image regeneration fails", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [{
        id: "p-1",
        userId: "u1",
        sourceFormat: "plain-text",
        sourceText: "source",
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
    const fetchFn = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { app, billing } = await buildArticleWorkflowApp({ prisma, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow/p-1/images/cover/regenerate",
      payload: {},
    });

    expect(response.statusCode).toBe(502);
    expect(billing.refundResource).toHaveBeenCalledOnce();
    expect(prisma.__state.projects[0]?.error).toBeTruthy();
  });
});
