import { describe, expect, it, vi } from "vitest";
import { runReservedArticleTextTask } from "./article-workflow-billing.js";
import { reapStaleArticleWorkflowProjects } from "./article-workflow-reaper.js";
import {
  buildArticleWorkflowApp,
  buildArticleWorkflowHtml,
  buildArticleWorkflowPlan,
  buildArticleWorkflowImageManifest,
  createArticleWorkflowPrismaMock,
} from "./article-workflow-test-helpers.js";

type BillingCallArgs = { operationId: string; userId: string; resourceKey: string; units: number };

function createBillingStub() {
  return {
    reserveResource: vi.fn(async (_args: BillingCallArgs) => ({ reserved: 1 })),
    settleResource: vi.fn(async (_args: Omit<BillingCallArgs, "userId">) => ({ settled: 1 })),
    chargeResource: vi.fn(async (_args: BillingCallArgs) => ({ charged: 1 })),
    refundResource: vi.fn(async (_operationId: string) => ({ success: true })),
  };
}

describe("runReservedArticleTextTask", () => {
  it("reserve 成功后把 operationId 交给 onReserved", async () => {
    const billing = createBillingStub();
    const onReserved = vi.fn(async () => undefined);

    await runReservedArticleTextTask({
      billing,
      userId: "u1",
      projectId: "p-1",
      units: 10,
      onReserved,
      work: async () => "done",
    });

    const reserved = billing.reserveResource.mock.calls[0]![0];
    expect(reserved.operationId).toMatch(/^article-text:p-1:/);
    expect(onReserved).toHaveBeenCalledWith(reserved.operationId);
    expect(billing.settleResource).toHaveBeenCalledOnce();
  });

  it("onReserved 落库失败时退款并抛出", async () => {
    const billing = createBillingStub();
    const work = vi.fn(async () => "done");

    await expect(runReservedArticleTextTask({
      billing,
      userId: "u1",
      projectId: "p-1",
      units: 10,
      onReserved: async () => {
        throw new Error("db down");
      },
      work,
    })).rejects.toThrow("db down");

    expect(work).not.toHaveBeenCalled();
    expect(billing.refundResource).toHaveBeenCalledOnce();
    expect(billing.settleResource).not.toHaveBeenCalled();
  });
});

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
    expect(response.json().data.platforms).toEqual([
      { platform: "wechat", label: "微信公众号", outputKind: "html-fragment", maxImages: 5 },
      { platform: "xiaohongshu", label: "小红书", outputKind: "caption", maxImages: 5 },
      { platform: "douyin", label: "抖音", outputKind: "caption", maxImages: 5 },
    ]);
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

  it("把文本 reserve 的 operationId 落库，成功收尾后清空", async () => {
    let scheduledTask: () => Promise<void> = async () => {
      throw new Error("scheduled task missing");
    };
    const { app, prisma, billing } = await buildArticleWorkflowApp({
      scheduleTask: (work) => {
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
    await scheduledTask();

    const reserved = billing.reserveResource.mock.calls[0]![0];
    const persisted = prisma.articleWorkflowProject.update.mock.calls
      .map((call) => (call[0] as { data: { billingOperationId?: string | null } }).data.billingOperationId)
      .filter((value): value is string => typeof value === "string");
    expect(persisted).toContain(reserved.operationId);
    expect(prisma.__state.projects[0]?.billingOperationId).toBeNull();
  });

  it("整单失败时回滚已扣的图片费", async () => {
    let scheduledTask: () => Promise<void> = async () => {
      throw new Error("scheduled task missing");
    };
    // 只喂第一轮 plan 响应，排版阶段的第二次 LLM 调用会抛错 → 图片已扣款但整单失败
    const { app, prisma, billing } = await buildArticleWorkflowApp({
      llmResponses: [{
        content: [{ type: "text", text: JSON.stringify(buildArticleWorkflowPlan()) }],
        usage: { input_tokens: 120, output_tokens: 480 },
      }],
      scheduleTask: (work) => {
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
    await scheduledTask();

    const chargedImageOperationIds = billing.chargeResource.mock.calls.map((call) => call[0].operationId);
    expect(chargedImageOperationIds).toHaveLength(2);
    const refunded = billing.refundResource.mock.calls.map((call) => call[0]);
    for (const operationId of chargedImageOperationIds) {
      expect(refunded).toContain(operationId);
    }
    expect(prisma.__state.projects[0]?.status).toBe("failed");
  });

  it("reaper 抢先收割后，runner 迟到的 ready 终态不覆盖也不结算", async () => {
    let scheduledTask: () => Promise<void> = async () => {
      throw new Error("scheduled task missing");
    };
    const prisma = createArticleWorkflowPrismaMock();
    const reaperBilling = { refundResource: vi.fn(async (_operationId: string) => ({ success: true })) };
    let reaped = false;
    // 在图片生成途中让真 reaper 介入，模拟「runner 卡住超阈值被收割后又活过来」
    const fetchFn = vi.fn(async () => {
      if (!reaped) {
        reaped = true;
        await reapStaleArticleWorkflowProjects({
          prisma: prisma as never,
          billing: reaperBilling,
          staleMs: 0,
        });
      }
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("png").toString("base64"), mime_type: "image/png" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const { app, billing } = await buildArticleWorkflowApp({
      prisma,
      fetchFn,
      scheduleTask: (work) => {
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
    await scheduledTask();

    const textOperationId = billing.reserveResource.mock.calls[0]![0].operationId;
    expect(reaperBilling.refundResource).toHaveBeenCalledWith(textOperationId);
    // 关键：终态未被覆盖，且 reserve 走退款而不是结算（否则就是双结算）
    expect(billing.settleResource).not.toHaveBeenCalled();
    expect(billing.refundResource).toHaveBeenCalledWith(textOperationId);
    expect(prisma.__state.projects[0]?.status).toBe("failed");
    expect(prisma.__state.projects[0]?.error).toContain("已自动终止");
    // 成品不会交付，reaper 收割前已扣的图片费也要退
    const imageOperationIds = billing.reserveResource.mock.calls
      .map((call) => call[0].operationId)
      .filter((operationId) => operationId !== textOperationId);
    for (const operationId of imageOperationIds) {
      expect(billing.refundResource).toHaveBeenCalledWith(operationId);
    }
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
