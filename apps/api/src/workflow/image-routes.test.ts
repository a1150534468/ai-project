import Fastify from "fastify";
import sharp from "sharp";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import type { PrismaClient } from "@prisma/client";
import { imageWorkflowRoutes, loadImageAttemptTimeoutMs, loadImageMaxAttempts } from "./image-routes.js";

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
  readonly id?: { readonly in: readonly string[] };
  readonly NOT?: { readonly requestId?: { readonly startsWith: string } };
};

function createPrismaMock(rows: ImageRow[] = [], tasks: ImageTaskRow[] = []) {
  return {
    imageAsset: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        rows.find((row) => row.id === args.where.id) ?? null
      ),
      findMany: vi.fn(async (args: { where?: ImageAssetFindManyWhere; orderBy?: Record<string, string>; take?: number; skip?: number }) => {
        let result = rows.filter((row) => !args.where?.userId || row.userId === args.where.userId);
        if (args.where?.requestId) result = result.filter((row) => row.requestId === args.where?.requestId);
        if (args.where?.id?.in) result = result.filter((row) => args.where?.id?.in.includes(row.id));
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
      create: vi.fn(async (args: { data: Omit<ImageRow, "id" | "createdAt"> }) => {
        const row = { ...args.data, id: `img-${rows.length + 1}`, createdAt: new Date("2026-06-30T08:00:00.000Z") };
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
  readonly loadStoredImage?: (objectKey: string) => Promise<Buffer>;
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
    loadStoredImage: options.loadStoredImage,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  process.env.LLM_BASE_URL = "https://llm.test";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_DEFAULT_MODEL = "GLM-5.2";
  process.env.BAILIAN_WORKSPACE_ID = "workspace";
  process.env.BAILIAN_REGION = "cn-beijing";
  process.env.BAILIAN_API_KEY = "bailian-key";
  process.env.IMAGE_GENERATION_MODEL = "qwen-image-2.0-pro-2026-04-22";
  process.env.SESSION_SECRET = "x".repeat(32);
  delete process.env.IMAGE_BASE_URL;
  delete process.env.IMAGE_GENERATION_ENDPOINT;
  delete process.env.IMAGE_API_KEY;
  delete process.env.GPT_IMAGE_API_KEY;
  delete process.env.GPT_IMAGE_GENERATION_ENDPOINT;
  delete process.env.GPT_IMAGE_EDIT_API_KEY;
  delete process.env.GPT_IMAGE_EDIT_ENDPOINT;
  delete process.env.IMAGE_PROMPT_OPTIMIZER_MODEL;
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_BUCKET;
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
});

describe("image workflow routes", () => {
  it("uploads a reference image and returns an asset for the picker", async () => {
    const prisma = createPrismaMock();
    const app = await createApp({ prisma, billing: createBillingMock(), fetchFn: vi.fn() as unknown as typeof fetch });
    const b64 = (await sharp({ create: { width: 8, height: 8, channels: 4, background: "#336699" } }).png().toBuffer()).toString("base64");

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/references",
      payload: { image: { b64, mime: "image/png" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset).toMatchObject({
      requestId: expect.stringMatching(/^ecom-reference:/),
      originalUrl: `data:image/png;base64,${b64}`,
      mime: "image/png",
    });
    expect(prisma.imageAsset.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects unsupported or undecodable reference uploads before persistence", async () => {
    const prisma = createPrismaMock();
    const app = await createApp({ prisma, billing: createBillingMock(), fetchFn: vi.fn() as unknown as typeof fetch });

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/workflow/images/references",
      payload: { image: { b64: Buffer.from("<svg/>").toString("base64"), mime: "image/svg+xml" } },
    });
    expect(unsupported.statusCode).toBe(400);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/workflow/images/references",
      payload: { image: { b64: Buffer.from("not-a-png").toString("base64"), mime: "image/png" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(prisma.imageAsset.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("serves existing private object images through a signed same-origin url", async () => {
    const objectKey = "workflow/images/u1/req-private/0-result.png";
    const storedBytes = Buffer.from("private-image-bytes");
    const prisma = createPrismaMock([{
      id: "img-private",
      userId: "u1",
      requestId: "req-private",
      requestIndex: 0,
      prompt: "产品宣传图",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      originalUrl: `http://localhost:9000/private/${objectKey}`,
      thumbnailUrl: `http://localhost:9000/private/${objectKey}`,
      objectKey,
      mime: "image/png",
      createdAt: new Date("2026-07-15T06:43:06.790Z"),
    }]);
    const loadStoredImage = vi.fn(async () => storedBytes);
    const app = await createApp({
      prisma,
      billing: createBillingMock(),
      fetchFn: vi.fn() as unknown as typeof fetch,
      loadStoredImage,
    });

    const listResponse = await app.inject({ method: "GET", url: "/api/workflow/images" });
    expect(listResponse.statusCode).toBe(200);
    const image = listResponse.json().data[0] as { originalUrl: string; thumbnailUrl: string; objectKey?: string };
    expect(image.originalUrl).toMatch(/^\/api\/workflow\/images\/img-private\/blob\?/);
    expect(image.thumbnailUrl).toBe(image.originalUrl);
    expect(image.objectKey).toBeUndefined();

    const blobResponse = await app.inject({ method: "GET", url: image.originalUrl });
    expect(blobResponse.statusCode).toBe(200);
    expect(blobResponse.headers["content-type"]).toContain("image/png");
    expect(blobResponse.rawPayload.equals(storedBytes)).toBe(true);
    expect(loadStoredImage).toHaveBeenCalledWith(objectKey);

    const tamperedUrl = new URL(image.originalUrl, "http://localhost");
    tamperedUrl.searchParams.set("sig", "invalid");
    const tamperedResponse = await app.inject({
      method: "GET",
      url: `${tamperedUrl.pathname}${tamperedUrl.search}`,
    });
    expect(tamperedResponse.statusCode).toBe(401);
    await app.close();
  });

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
      input?: { messages?: { content?: { text?: string }[] }[] };
    };
    expect(requestBody.model).toBe("qwen-image-2.0-pro-2026-04-22");
    expect(requestBody.input?.messages?.[0]?.content?.[0]?.text).toBe("陶瓷餐盘");
    await app.close();
  });

  it("selects GPT Image 2 and sends the OpenAI-compatible generation body", async () => {
    process.env.GPT_IMAGE_API_KEY = "gpt-image-key";
    process.env.GPT_IMAGE_GENERATION_ENDPOINT = "https://pixel.test/v1/images/generations";
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("gpt-png").toString("base64") }],
    }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: {
        requestId: "req-gpt-image-2",
        model: "gpt-image-2",
        prompt: "极简产品摄影",
        size: "2048x1152",
        count: 1,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.task.model).toBe("gpt-image-2");
    await scheduled[0];
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("https://pixel.test/v1/images/generations");
    expect(JSON.parse(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toEqual({
      model: "gpt-image-2",
      prompt: "极简产品摄影",
      n: 1,
      size: "2048x1152",
      quality: "auto",
      output_format: "png",
    });
    await app.close();
  });

  it("runs GPT Image 2 reference inputs through the shared multipart edits endpoint", async () => {
    process.env.GPT_IMAGE_API_KEY = "gpt-image-key";
    process.env.GPT_IMAGE_GENERATION_ENDPOINT = "https://pixel.test/v1/images/generations";
    process.env.GPT_IMAGE_EDIT_API_KEY = "gpt-edit-key";
    process.env.GPT_IMAGE_EDIT_ENDPOINT = "https://pixel.test/v1/images/edits";
    const referenceB64 = Buffer.from("reference-png").toString("base64");
    const prisma = createPrismaMock([{
      id: "ref-gpt",
      userId: "u1",
      requestId: "ecom-reference:ref-gpt",
      requestIndex: 0,
      prompt: "image_reference_upload",
      model: "image_reference_upload",
      size: "reference",
      originalUrl: `data:image/png;base64,${referenceB64}`,
      thumbnailUrl: `data:image/png;base64,${referenceB64}`,
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T07:00:00.000Z"),
    }]);
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: "gpt-image-2-codex",
      quality: "auto",
      data: [{ b64_json: Buffer.from("edited-png").toString("base64") }],
    }), { status: 200 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: {
        requestId: "req-gpt-reference",
        model: "gpt-image-2",
        prompt: "编辑参考图",
        size: "1024x1024",
        referenceAssetIds: ["ref-gpt"],
        count: 1,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.task.referenceAssetIds).toEqual(["ref-gpt"]);
    await scheduled[0];
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://pixel.test/v1/images/edits");
    expect(init.headers).toEqual({ authorization: "Bearer gpt-edit-key" });
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("编辑参考图");
    expect(form.get("size")).toBe("1024x1024");
    expect(form.getAll("image[]")).toHaveLength(1);
    expect(billing.chargeResource).toHaveBeenCalledOnce();
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({ status: "completed", completedCount: 1 });
    await app.close();
  });

  it("uses uploaded references through the Qwen image editing request", async () => {
    const referenceB64 = Buffer.from("reference-png").toString("base64");
    const prisma = createPrismaMock([{
      id: "ref-1",
      userId: "u1",
      requestId: "ecom-reference:ref-1",
      requestIndex: 0,
      prompt: "image_reference_upload",
      model: "image_reference_upload",
      size: "reference",
      originalUrl: `data:image/png;base64,${referenceB64}`,
      thumbnailUrl: `data:image/png;base64,${referenceB64}`,
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T07:00:00.000Z"),
    }]);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing: createBillingMock(), fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-with-reference", prompt: "保留杯子造型，改成户外场景", size: "1024x1024", referenceAssetIds: ["ref-1"], count: 1 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.task.referenceAssetIds).toEqual(["ref-1"]);
    await scheduled[0];
    const body = JSON.parse(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body.input.messages[0].content).toEqual([
      { image: `data:image/png;base64,${referenceB64}` },
      { text: "保留杯子造型，改成户外场景" },
    ]);
    await app.close();
  });

  it("passes Qwen's width-height size to the native upstream", async () => {
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
      parameters?: { size?: string };
    };
    expect(requestBody.parameters?.size).toBe("2048*1152");
    expect(response.json().data.task.size).toBe("2048x1152");
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_2k" }));
    await app.close();
  });

  it("defaults image generation attempts to a long timeout for slow upstream jobs", () => {
    expect(loadImageAttemptTimeoutMs({})).toBe(600_000);
    expect(loadImageAttemptTimeoutMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(loadImageAttemptTimeoutMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "-1" })).toBe(600_000);
    expect(loadImageMaxAttempts({})).toBe(3);
    expect(loadImageMaxAttempts({ IMAGE_MAX_ATTEMPTS: "5" })).toBe(5);
    expect(loadImageMaxAttempts({ IMAGE_MAX_ATTEMPTS: "0" })).toBe(3);
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
      model: "qwen-image-2.0-pro-2026-04-22",
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
      model: "qwen-image-2.0-pro-2026-04-22",
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

  it("resumes a stale GPT Image task with its persisted provider instead of the default model", async () => {
    process.env.GPT_IMAGE_API_KEY = "gpt-image-key";
    process.env.GPT_IMAGE_GENERATION_ENDPOINT = "https://pixel.test/v1/images/generations";
    const prisma = createPrismaMock([], [{
      id: "task-stale-gpt",
      userId: "u1",
      requestId: "req-stale-gpt",
      prompt: "极简产品摄影",
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
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("gpt-png").toString("base64") }],
    }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled, staleTaskMs: 1 });

    expect((await app.inject({ method: "GET", url: "/api/workflow/images/state" })).statusCode).toBe(200);
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("https://pixel.test/v1/images/generations");
    const body = JSON.parse(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: "gpt-image-2", prompt: "极简产品摄影" });
    expect(body).not.toHaveProperty("input");
    expect(billing.chargeResource).not.toHaveBeenCalled();
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

  it("does not retry moderation failures and refunds the image task", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "moderation_blocked",
        type: "image_generation_error",
        message: "request blocked by moderation",
      },
    }), { status: 400 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-moderation", prompt: "blocked prompt", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(202);
    await expect(scheduled[0]).rejects.toThrow("request blocked by moderation");
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(billing.refundResource).toHaveBeenCalledWith("image:req-moderation");
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({ status: "failed", completedCount: 0 });
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

  it("rejects 4K output because Qwen Image 2.0 Pro supports at most 2K", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-4k-output", prompt: "小龙虾", size: "3840x2160", count: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("最高支持 2K");
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
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
