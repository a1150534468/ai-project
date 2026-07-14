import Fastify from "fastify";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import type { PrismaClient } from "@prisma/client";
import { imageWorkflowRoutes, loadImageAttemptTimeoutMs } from "./image-routes.js";

interface ImageRow {
  id: string;
  userId: string;
  requestId: string;
  requestIndex: number;
  prompt: string;
  model: string;
  size: string;
  originalUrl: string;
  thumbnailUrl: string;
  objectKey: string | null;
  mime: string;
  createdAt: Date;
}

interface ImageTaskRow {
  id: string;
  userId: string;
  requestId: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
  status: string;
  completedCount: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type ImageAssetFindManyWhere = {
  readonly userId?: string;
  readonly requestId?: string;
  readonly NOT?: { readonly requestId?: { readonly startsWith: string } };
};

function createPrismaMock(rows: ImageRow[] = [], tasks: ImageTaskRow[] = []) {
  return {
    imageAsset: {
      findMany: vi.fn(async (args: { where?: ImageAssetFindManyWhere; orderBy?: Record<string, string>; take?: number; skip?: number }) => {
        let result = rows.filter((row) => !args.where?.userId || row.userId === args.where.userId);
        if (args.where?.requestId) result = result.filter((row) => row.requestId === args.where?.requestId);
        if (args.where?.NOT?.requestId?.startsWith) {
          const prefix = args.where.NOT.requestId.startsWith;
          result = result.filter((row) => !row.requestId.startsWith(prefix));
        }
        result = [...result].sort((a, b) => {
          if (args.orderBy?.requestIndex) return a.requestIndex - b.requestIndex;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
        if (args.skip) result = result.slice(args.skip);
        if (args.take) result = result.slice(0, args.take);
        return result;
      }),
      upsert: vi.fn(async (args: { create: Omit<ImageRow, "id" | "createdAt"> }) => {
        const row = { ...args.create, id: `img-${rows.length + 1}`, createdAt: new Date("2026-06-30T08:00:00.000Z") };
        rows.push(row);
        return row;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    imageGenerationTask: {
      findMany: vi.fn(async (args: { where?: { userId?: string }; orderBy?: Record<string, string>; take?: number }) => {
        let result = tasks.filter((row) => !args.where?.userId || row.userId === args.where.userId);
        result = [...result].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (args.take) result = result.slice(0, args.take);
        return result;
      }),
      findFirst: vi.fn(async (args: { where?: { userId?: string; requestId?: string } }) =>
        tasks.find((row) =>
          (!args.where?.userId || row.userId === args.where.userId) &&
          (!args.where?.requestId || row.requestId === args.where.requestId)
        ) ?? null
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        tasks.find((row) => row.id === args.where.id) ?? null
      ),
      create: vi.fn(async (args: { data: Omit<ImageTaskRow, "id" | "createdAt" | "updatedAt"> }) => {
        const row = {
          ...args.data,
          id: `task-${tasks.length + 1}`,
          createdAt: new Date("2026-06-30T08:00:00.000Z"),
          updatedAt: new Date("2026-06-30T08:00:00.000Z"),
        };
        tasks.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id?: string; requestId?: string }; data: Partial<ImageTaskRow> }) => {
        const row = tasks.find((item) =>
          (args.where.id && item.id === args.where.id) ||
          (args.where.requestId && item.requestId === args.where.requestId)
        );
        if (!row) throw new Error("task not found");
        Object.assign(row, args.data, { updatedAt: new Date("2026-06-30T08:01:00.000Z") });
        return row;
      }),
      updateMany: vi.fn(async (args: { where: { id?: string; userId?: string; requestId?: string; status?: string; updatedAt?: Date }; data: Partial<ImageTaskRow> }) => {
        const row = tasks.find((item) =>
          (!args.where.id || item.id === args.where.id) &&
          (!args.where.userId || item.userId === args.where.userId) &&
          (!args.where.requestId || item.requestId === args.where.requestId) &&
          (!args.where.status || item.status === args.where.status) &&
          (!args.where.updatedAt || item.updatedAt.getTime() === args.where.updatedAt.getTime())
        );
        if (!row) return { count: 0 };
        Object.assign(row, args.data, { updatedAt: new Date("2026-06-30T08:02:00.000Z") });
        return { count: 1 };
      }),
    },
  };
}

type BillingMock = {
  chargeResource: ReturnType<typeof vi.fn>;
  refundResource: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
};

function createBillingMock(overrides: Partial<BillingMock> = {}): BillingMock {
  return {
    chargeResource: vi.fn(async () => ({ charged: 10 })),
    refundResource: vi.fn(async () => ({ success: true })),
    reserve: vi.fn(async () => ({ reserved: 1 })),
    settle: vi.fn(async () => ({ settled: 1 })),
    ...overrides,
  };
}

async function createApp(options: {
  readonly prisma: ReturnType<typeof createPrismaMock>;
  readonly billing: BillingMock;
  readonly fetchFn: typeof fetch;
  readonly scheduled?: Promise<void>[];
  readonly promptOptimizer?: (prompt: string) => Promise<string>;
  readonly retryDelayMs?: number;
  readonly staleTaskMs?: number;
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { userId: string }).userId = "u1";
  });
  await app.register(imageWorkflowRoutes, {
    prisma: options.prisma as unknown as PrismaClient,
    billing: options.billing,
    fetchFn: options.fetchFn,
    promptOptimizer: options.promptOptimizer,
    scheduleTask: (work: () => Promise<void>) => {
      options.scheduled?.push(work());
    },
    retryDelayMs: options.retryDelayMs ?? 1,
    maxAttempts: 3,
    staleTaskMs: options.staleTaskMs,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  process.env.LLM_BASE_URL = "https://llm.test";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_DEFAULT_MODEL = "GLM-5.2";
  process.env.IMAGE_GENERATION_MODEL = "gpt-image-2";
  delete process.env.IMAGE_PROMPT_OPTIMIZER_MODEL;
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_BUCKET;
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
});

describe("image workflow routes", () => {
  it("starts a persistent image task and completes it in the background", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock({ chargeResource: vi.fn(async () => ({ charged: 20 })) });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-12345678", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.task.status).toBe("running");
    expect(scheduled).toHaveLength(1);
    expect(billing.chargeResource).toHaveBeenCalledWith({
      operationId: "image:req-12345678",
      userId: "u1",
      resourceKey: "image_generation_1k",
      units: 2,
    });
    await scheduled[0];
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({
      requestId: "req-12345678",
      status: "completed",
      completedCount: 2,
    });
    const imagesResponse = await app.inject({ method: "GET", url: "/api/workflow/images" });
    expect(imagesResponse.json().data).toHaveLength(2);
    const requestBody = JSON.parse((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string) as {
      model: string;
      response_format?: string;
    };
    expect(requestBody.model).toBe("gpt-image-2");
    expect(requestBody.response_format).toBe("b64_json");
    await app.close();
  });

  it("passes ratio and resolution to upstream for supported preset output sizes", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-large-size", prompt: "陶瓷餐盘", size: "2048x1152", count: 1 },
    });

    expect(response.statusCode).toBe(202);
    await scheduled[0];
    const requestBody = JSON.parse((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string) as {
      size?: string;
      resolution?: string;
    };
    expect(requestBody.size).toBe("16:9");
    expect(requestBody.resolution).toBe("2k");
    expect(response.json().data.task.size).toBe("2048x1152");
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_2k" }));
    await app.close();
  });

  it("defaults image generation attempts to a long timeout for slow upstream jobs", () => {
    expect(loadImageAttemptTimeoutMs({})).toBe(600_000);
    expect(loadImageAttemptTimeoutMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(loadImageAttemptTimeoutMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "-1" })).toBe(600_000);
  });

  it("returns a completed task for legacy existing image assets without charging again", async () => {
    const prisma = createPrismaMock([
      {
        id: "img-1",
        userId: "u1",
        requestId: "req-existing-1",
        requestIndex: 0,
        prompt: "陶瓷餐盘",
        model: "gpt-image-2",
        size: "1024x1024",
        originalUrl: "https://img.test/1.png",
        thumbnailUrl: "https://img.test/1.png",
        objectKey: null,
        mime: "image/png",
        createdAt: new Date("2026-06-30T08:00:00.000Z"),
      },
    ]);
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-existing-1", prompt: "陶瓷餐盘", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({
      requestId: "req-existing-1",
      status: "completed",
      completedCount: 1,
    });
    expect(response.json().data.recent).toHaveLength(1);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps e-commerce long image assets out of normal image history", async () => {
    const prisma = createPrismaMock([
      {
        id: "img-normal",
        userId: "u1",
        requestId: "req-normal-history",
        requestIndex: 0,
        prompt: "普通生图历史",
        model: "gpt-image-2",
        size: "1024x1024",
        originalUrl: "https://img.test/normal.png",
        thumbnailUrl: "https://img.test/normal-thumb.png",
        objectKey: null,
        mime: "image/png",
        createdAt: new Date("2026-06-30T08:00:00.000Z"),
      },
      {
        id: "img-ecom",
        userId: "u1",
        requestId: "ecom-stitch:workflow-1:asset-1",
        requestIndex: 0,
        prompt: "ecom_stitch",
        model: "gpt-image-2",
        size: "1024x3072",
        originalUrl: "https://img.test/ecom.png",
        thumbnailUrl: "https://img.test/ecom-thumb.png",
        objectKey: null,
        mime: "image/png",
        createdAt: new Date("2026-06-30T08:10:00.000Z"),
      },
    ]);
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({ method: "GET", url: "/api/workflow/images/state" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.images).toEqual([
      expect.objectContaining({
        requestId: "req-normal-history",
        prompt: "普通生图历史",
      }),
    ]);
    expect(prisma.imageAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        NOT: { requestId: { startsWith: "ecom-" } },
      }),
    }));
    await app.close();
  });

  it("restores running image tasks for page remounts", async () => {
    const prisma = createPrismaMock([], [{
      id: "task-running",
      userId: "u1",
      requestId: "req-running",
      prompt: "小龙虾",
      model: "gpt-image-2",
      size: "1024x1024",
      count: 4,
      status: "running",
      completedCount: 1,
      error: null,
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }]);
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([expect.objectContaining({
      requestId: "req-running",
      status: "running",
      completedCount: 1,
    })]);
    await app.close();
  });

  it("resumes stale running image tasks from state loading without charging again", async () => {
    const prisma = createPrismaMock([], [{
      id: "task-stale",
      userId: "u1",
      requestId: "req-stale",
      prompt: "商业美食摄影",
      model: "gpt-image-2",
      size: "1024x1024",
      count: 1,
      status: "running",
      completedCount: 0,
      error: null,
      createdAt: new Date("2026-06-29T07:00:00.000Z"),
      updatedAt: new Date("2026-06-29T07:00:00.000Z"),
    }]);
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled, staleTaskMs: 1 });

    const response = await app.inject({ method: "GET", url: "/api/workflow/images/state" });

    expect(response.statusCode).toBe(200);
    expect(scheduled).toHaveLength(1);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    await scheduled[0];
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({
      requestId: "req-stale",
      status: "completed",
      completedCount: 1,
    });
    await app.close();
  });

  it("cancels a running image task and refunds an untouched charge", async () => {
    const prisma = createPrismaMock([], [{
      id: "task-cancel",
      userId: "u1",
      requestId: "req-cancel-1",
      prompt: "陶瓷餐盘",
      model: "gpt-image-2",
      size: "1024x1024",
      count: 2,
      status: "running",
      completedCount: 0,
      error: "上次失败：image relay 503，3 秒后自动重试",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }]);
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-cancel-1/cancel" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({
      requestId: "req-cancel-1",
      status: "cancelled",
      error: "用户已取消",
    });
    expect(billing.refundResource).toHaveBeenCalledWith("image:req-cancel-1");
    await app.close();
  });

  it("stops retrying when a running image task is cancelled", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: "https://img.test/a.png" }] }), { status: 200 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled, retryDelayMs: 40 });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-cancel-retry", prompt: "小龙虾", size: "1024x1024", count: 1 },
    });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cancelResponse = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-cancel-retry/cancel" });

    expect(cancelResponse.statusCode).toBe(200);
    await scheduled[0];
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({
      requestId: "req-cancel-retry",
      status: "cancelled",
      completedCount: 0,
    });
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(prisma.imageAsset.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("optimizes prompts through the workflow optimizer endpoint", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({
      prisma,
      billing,
      fetchFn,
      promptOptimizer: async (prompt) => `${prompt}，高质量商业摄影，干净构图。`,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/optimize-prompt",
      payload: { prompt: "陶瓷餐盘" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.prompt).toContain("高质量商业摄影");
    expect(billing.reserve).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      type: "image_prompt",
      model: "mimo-v2.5-pro-ultraspeed",
      maxOutputTokens: 900,
    }));
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      model: "mimo-v2.5-pro-ultraspeed",
      outputTokens: expect.any(Number),
    }));
    await app.close();
  });

  it("allows the image prompt optimizer model to be overridden by environment", async () => {
    process.env.IMAGE_PROMPT_OPTIMIZER_MODEL = "custom-image-prompt-model";
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({
      prisma,
      billing,
      fetchFn,
      promptOptimizer: async (prompt) => `${prompt}，干净构图。`,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/optimize-prompt",
      payload: { prompt: "陶瓷餐盘" },
    });

    expect(response.statusCode).toBe(200);
    expect(billing.reserve).toHaveBeenCalledWith(expect.objectContaining({
      model: "custom-image-prompt-model",
    }));
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({
      model: "custom-image-prompt-model",
    }));
    await app.close();
  });

  it("retries relay failures in the background worker", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: "https://img.test/a.png" }] }), { status: 200 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-retry-1", prompt: "小龙虾", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(202);
    await scheduled[0];
    expect(prisma.imageGenerationTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "running",
        error: expect.stringContaining("image relay 503"),
      }),
    }));
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    await app.close();
  });

  it("rejects more than 8 concurrent images", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock({ chargeResource: vi.fn(async () => ({ charged: 90 })) });
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-too-many", prompt: "小龙虾", size: "1024x1024", count: 9 },
    });

    expect(response.statusCode).toBe(400);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 402 when resource charge reports insufficient balance", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock({
      chargeResource: vi.fn(async () => {
        throw new InsufficientBalanceError();
      }),
    });
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-balance", prompt: "小龙虾", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(402);
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });
});
