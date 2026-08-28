import Fastify from "fastify";
import sharp from "sharp";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import type { PrismaClient } from "@prisma/client";
import { imageWorkflowRoutes, loadImageAttemptTimeoutMs, loadImageMaxAttempts } from "./image-routes.js";
import { imageReservationTtlSeconds } from "./image-shared.js";

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
  width?: number | null;
  height?: number | null;
  createdAt: Date;
}

interface ImageTaskRow {
  id: string;
  userId: string;
  requestId: string;
  prompt: string;
  model: string;
  size: string;
  referenceAssetIds?: string[];
  sourceImageAssetId?: string | null;
  generationIntent?: string;
  count: number;
  status: string;
  completedCount: number;
  error: string | null;
  billingMode?: string;
  billingResourceKey?: string | null;
  billingReservedUnits?: number;
  billingSettledUnits?: number | null;
  billingStatus?: string | null;
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
      // status / billing* / updatedAt 这几个条件是 reaper 的查询在用的（不带 userId）。
      // 轮询路径只传 userId，那几个 undefined 时不过滤，所以既有用例行为不变。
      findMany: vi.fn(async (args: {
        where?: {
          userId?: string;
          status?: string | { in?: readonly string[] };
          billingMode?: string;
          billingStatus?: { in?: readonly string[] };
          updatedAt?: { lt?: Date };
        };
        orderBy?: Record<string, string>;
        take?: number;
      }) => {
        const where = args.where;
        let result = tasks.filter((row) => !where?.userId || row.userId === where.userId);
        if (typeof where?.status === "string") {
          result = result.filter((row) => row.status === where.status);
        } else if (where?.status?.in) {
          result = result.filter((row) => where.status && typeof where.status !== "string" && where.status.in?.includes(row.status));
        }
        if (where?.billingMode) result = result.filter((row) => row.billingMode === where.billingMode);
        if (where?.billingStatus?.in) {
          result = result.filter((row) => row.billingStatus && where.billingStatus?.in?.includes(row.billingStatus));
        }
        if (where?.updatedAt?.lt) {
          const lt = where.updatedAt.lt.getTime();
          result = result.filter((row) => row.updatedAt.getTime() < lt);
        }
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
      updateMany: vi.fn(async (args: {
        where: {
          id?: string;
          userId?: string;
          requestId?: string;
          status?: string;
          billingStatus?: string | { in?: readonly string[] };
          updatedAt?: Date | { lt?: Date };
        };
        data: Partial<ImageTaskRow>;
      }) => {
        const matchesBillingStatus = (row: ImageTaskRow) => {
          const filter = args.where.billingStatus;
          if (filter === undefined) return true;
          if (typeof filter === "string") return row.billingStatus === filter;
          return Boolean(filter.in?.includes(row.billingStatus ?? ""));
        };
        const matchesUpdatedAt = (row: ImageTaskRow) => {
          const filter = args.where.updatedAt;
          if (filter === undefined) return true;
          if (filter instanceof Date) return row.updatedAt.getTime() === filter.getTime();
          return filter.lt ? row.updatedAt.getTime() < filter.lt.getTime() : true;
        };
        const row = tasks.find((item) =>
          (!args.where.id || item.id === args.where.id) &&
          (!args.where.userId || item.userId === args.where.userId) &&
          (!args.where.requestId || item.requestId === args.where.requestId) &&
          (!args.where.status || item.status === args.where.status) &&
          matchesBillingStatus(item) &&
          matchesUpdatedAt(item)
        );
        if (!row) return { count: 0 };
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
  };
}

type BillingMock = {
  reserveResource: ReturnType<typeof vi.fn>;
  settleResource: ReturnType<typeof vi.fn>;
  refundResource: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  listResourcePrices?: ReturnType<typeof vi.fn>;
};

function createBillingMock(overrides: Partial<BillingMock> = {}): BillingMock {
  return {
    reserveResource: vi.fn(async () => ({ reserved: 10 })),
    settleResource: vi.fn(async () => ({ settled: 10 })),
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
  readonly redis?: { set: (...args: unknown[]) => Promise<string | null> };
  /** 传空串模拟未登录。默认 "u1"，保持既有用例不变。 */
  readonly userId?: string;
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = options.userId ?? "u1";
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
    redis: options.redis as never,
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

  it("starts a persistent image task, reserves points, and settles on completion", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
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
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: "image:req-12345678",
      userId: "u1",
      resourceKey: "image_generation_1k",
      units: 2,
      // 注入的 maxAttempts 是 3（createApp 里写死），窗口必须按注入值算而不是环境默认值。
      reservationTtlSeconds: imageReservationTtlSeconds({ count: 2, maxAttempts: 3 }),
    });
    await scheduled[0];
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-12345678",
      resourceKey: "image_generation_1k",
      units: 2,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
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
      // 中继 60s 读超时下必须流式保活，否则长耗时出图会被掐断
      stream: true,
      partial_images: 1,
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
    expect(billing.reserveResource).toHaveBeenCalledOnce();
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

  it("requires an owned source image for edit and variation tasks", async () => {
    const foreignSource: ImageRow = {
      id: "source-foreign",
      userId: "u2",
      requestId: "req-foreign-source",
      requestIndex: 0,
      prompt: "foreign",
      model: "gpt-image-2",
      size: "1024x1024",
      originalUrl: "data:image/png;base64,cG5n",
      thumbnailUrl: "data:image/png;base64,cG5n",
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T07:00:00.000Z"),
    };
    const prisma = createPrismaMock([foreignSource]);
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const missing = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-edit-missing", prompt: "修改", size: "1024x1024", generationIntent: "edit", count: 1 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain("来源图片");

    const foreign = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: {
        requestId: "req-edit-foreign",
        prompt: "修改",
        size: "1024x1024",
        generationIntent: "variation",
        sourceImageAssetId: "source-foreign",
        count: 1,
      },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toContain("无权使用");
    expect(billing.reserveResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("puts the source image first, deduplicates references, and persists version metadata", async () => {
    const makeReference = (id: string): ImageRow => ({
      id,
      userId: "u1",
      requestId: `req-${id}`,
      requestIndex: 0,
      prompt: id,
      model: "gpt-image-2",
      size: "1024x1024",
      originalUrl: `data:image/png;base64,${Buffer.from(id).toString("base64")}`,
      thumbnailUrl: `data:image/png;base64,${Buffer.from(id).toString("base64")}`,
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T07:00:00.000Z"),
    });
    const prisma = createPrismaMock([makeReference("source-1"), makeReference("ref-2"), makeReference("ref-3")]);
    const scheduled: Promise<void>[] = [];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const app = await createApp({ prisma, billing: createBillingMock(), fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: {
        requestId: "req-edit-source",
        prompt: "生成新版本",
        size: "1024x1024",
        sourceImageAssetId: "source-1",
        generationIntent: "edit",
        referenceAssetIds: ["ref-2", "source-1", "ref-3"],
        count: 1,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.task).toMatchObject({
      sourceImageAssetId: "source-1",
      generationIntent: "edit",
      referenceAssetIds: ["source-1", "ref-2", "ref-3"],
    });
    expect(prisma.imageGenerationTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceImageAssetId: "source-1",
        generationIntent: "edit",
        referenceAssetIds: ["source-1", "ref-2", "ref-3"],
      }),
    });
    await scheduled[0];
    const body = JSON.parse(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body.input.messages[0].content.slice(0, 3)).toHaveLength(3);
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
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_2k" }));
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
    expect(billing.reserveResource).not.toHaveBeenCalled();
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
    expect(billing.reserveResource).not.toHaveBeenCalled();
    await scheduled[0];
    // 旧任务（charge 模式）完成时不结算也不退款
    expect(billing.settleResource).not.toHaveBeenCalled();
    expect(billing.refundResource).not.toHaveBeenCalled();
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
    expect(billing.reserveResource).not.toHaveBeenCalled();
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
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-too-many", prompt: "小龙虾", size: "1024x1024", count: 9 },
    });

    expect(response.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();
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
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 402 when the point reservation reports insufficient balance", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock({
      reserveResource: vi.fn(async () => {
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
    expect(response.json().error).toBe("积分不足，请充值");
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });

  it("settles only the stored images when a reserve task fails partway", async () => {
    const prisma = createPrismaMock([{
      id: "img-partial-0",
      userId: "u1",
      requestId: "req-partial-fail",
      requestIndex: 0,
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      originalUrl: "https://img.test/partial-0.png",
      thumbnailUrl: "https://img.test/partial-0.png",
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T07:00:00.000Z"),
    }]);
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "moderation_blocked", type: "image_generation_error", message: "request blocked by moderation" },
    }), { status: 400 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-partial-fail", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });

    expect(response.statusCode).toBe(202);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ units: 2 }));
    await expect(scheduled[0]).rejects.toThrow("request blocked by moderation");
    // 已入库 1 张：按 1 张结算，而不是整单退款白送图片
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-partial-fail",
      resourceKey: "image_generation_1k",
      units: 1,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({ status: "failed" });
    await app.close();
  });

  it("settles delivered images when cancelling a partially completed reserve task", async () => {
    const tasks: ImageTaskRow[] = [{
      id: "task-cancel-partial",
      userId: "u1",
      requestId: "req-cancel-partial",
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 3,
      status: "running",
      completedCount: 1,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_1k",
      billingReservedUnits: 3,
      billingStatus: "reserved",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }];
    const prisma = createPrismaMock([{
      id: "img-cancel-0",
      userId: "u1",
      requestId: "req-cancel-partial",
      requestIndex: 0,
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      originalUrl: "https://img.test/cancel-0.png",
      thumbnailUrl: "https://img.test/cancel-0.png",
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T08:00:30.000Z"),
    }], tasks);
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-cancel-partial/cancel" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({ status: "cancelled" });
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-cancel-partial",
      resourceKey: "image_generation_1k",
      units: 1,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(tasks[0]).toMatchObject({ billingStatus: "settled", billingSettledUnits: 1 });
    await app.close();
  });

  it("settles at the delivered tier when a 2K request comes back at 1K pixels", async () => {
    const tasks: ImageTaskRow[] = [{
      id: "task-shrunk",
      userId: "u1",
      requestId: "req-shrunk",
      prompt: "陶瓷餐盘",
      model: "gpt-image-2",
      size: "2048x2048",
      count: 1,
      status: "running",
      completedCount: 1,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_2k",
      billingReservedUnits: 1,
      billingStatus: "reserved",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }];
    // 中转只认宽高比：请求 2048x2048 实际回 1024x1024，按请求档收就是多收一倍。
    const prisma = createPrismaMock([{
      id: "img-shrunk-0",
      userId: "u1",
      requestId: "req-shrunk",
      requestIndex: 0,
      prompt: "陶瓷餐盘",
      model: "gpt-image-2",
      size: "2048x2048",
      originalUrl: "https://img.test/shrunk-0.png",
      thumbnailUrl: "https://img.test/shrunk-0.png",
      objectKey: null,
      mime: "image/png",
      width: 1024,
      height: 1024,
      createdAt: new Date("2026-06-30T08:00:30.000Z"),
    }], tasks);
    const billing = createBillingMock({ listResourcePrices: vi.fn(async () => ({ data: [] })) });
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-shrunk/cancel" });

    expect(response.statusCode).toBe(200);
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-shrunk",
      resourceKey: "image_generation_1k",
      units: 1,
    });
    expect(tasks[0]).toMatchObject({ billingStatus: "settled", billingResourceKey: "image_generation_1k" });
    await app.close();
  });

  it("keeps the 2K key when the delivered pixels honour the request", async () => {
    const tasks: ImageTaskRow[] = [{
      id: "task-honoured",
      userId: "u1",
      requestId: "req-honoured",
      prompt: "陶瓷餐盘",
      model: "gpt-image-2",
      size: "2048x2048",
      count: 1,
      status: "running",
      completedCount: 1,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_2k",
      billingReservedUnits: 1,
      billingStatus: "reserved",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }];
    const prisma = createPrismaMock([{
      id: "img-honoured-0",
      userId: "u1",
      requestId: "req-honoured",
      requestIndex: 0,
      prompt: "陶瓷餐盘",
      model: "gpt-image-2",
      size: "2048x2048",
      originalUrl: "https://img.test/honoured-0.png",
      thumbnailUrl: "https://img.test/honoured-0.png",
      objectKey: null,
      mime: "image/png",
      width: 2048,
      height: 2048,
      createdAt: new Date("2026-06-30T08:00:30.000Z"),
    }], tasks);
    const billing = createBillingMock({ listResourcePrices: vi.fn(async () => ({ data: [] })) });
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-honoured/cancel" });

    expect(response.statusCode).toBe(200);
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-honoured",
      resourceKey: "image_generation_2k",
      units: 1,
    });
    await app.close();
  });

  it("falls back to the requested key when delivered pixels are unknown (legacy rows)", async () => {
    const tasks: ImageTaskRow[] = [{
      id: "task-legacy-size",
      userId: "u1",
      requestId: "req-legacy-size",
      prompt: "陶瓷餐盘",
      model: "gpt-image-2",
      size: "2048x2048",
      count: 1,
      status: "running",
      completedCount: 1,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_2k",
      billingReservedUnits: 1,
      billingStatus: "reserved",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }];
    // 迁移前入库的老数据没有 width/height，不能因此白送或误降档。
    const prisma = createPrismaMock([{
      id: "img-legacy-0",
      userId: "u1",
      requestId: "req-legacy-size",
      requestIndex: 0,
      prompt: "陶瓷餐盘",
      model: "gpt-image-2",
      size: "2048x2048",
      originalUrl: "https://img.test/legacy-0.png",
      thumbnailUrl: "https://img.test/legacy-0.png",
      objectKey: null,
      mime: "image/png",
      width: null,
      height: null,
      createdAt: new Date("2026-06-30T08:00:30.000Z"),
    }], tasks);
    const billing = createBillingMock({ listResourcePrices: vi.fn(async () => ({ data: [] })) });
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-legacy-size/cancel" });

    expect(response.statusCode).toBe(200);
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-legacy-size",
      resourceKey: "image_generation_2k",
      units: 1,
    });
    await app.close();
  });

  it("refunds a reserve task cancelled before any image is stored", async () => {
    const tasks: ImageTaskRow[] = [{
      id: "task-cancel-empty",
      userId: "u1",
      requestId: "req-cancel-empty",
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 2,
      status: "running",
      completedCount: 0,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_1k",
      billingReservedUnits: 2,
      billingStatus: "reserved",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }];
    const prisma = createPrismaMock([], tasks);
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-cancel-empty/cancel" });

    expect(response.statusCode).toBe(200);
    expect(billing.refundResource).toHaveBeenCalledWith("image:req-cancel-empty");
    expect(billing.settleResource).not.toHaveBeenCalled();
    expect(tasks[0]).toMatchObject({ billingStatus: "refunded", billingSettledUnits: 0 });
    await app.close();
  });

  it("keeps the legacy full refund for charge-mode tasks that fail with partial output", async () => {
    const prisma = createPrismaMock([{
      id: "img-legacy-0",
      userId: "u1",
      requestId: "req-legacy-fail",
      requestIndex: 0,
      prompt: "商业美食摄影",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      originalUrl: "https://img.test/legacy-0.png",
      thumbnailUrl: "https://img.test/legacy-0.png",
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-29T07:00:00.000Z"),
    }], [{
      id: "task-legacy-fail",
      userId: "u1",
      requestId: "req-legacy-fail",
      prompt: "商业美食摄影",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 2,
      status: "running",
      completedCount: 1,
      error: null,
      billingMode: "charge",
      createdAt: new Date("2026-06-29T07:00:00.000Z"),
      updatedAt: new Date("2026-06-29T07:00:00.000Z"),
    }]);
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "moderation_blocked", type: "image_generation_error", message: "request blocked by moderation" },
    }), { status: 400 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled, staleTaskMs: 1 });

    expect((await app.inject({ method: "GET", url: "/api/workflow/images/state" })).statusCode).toBe(200);
    expect(scheduled).toHaveLength(1);
    await expect(scheduled[0]).rejects.toThrow("request blocked by moderation");
    // 旧扣费模式保持原语义：失败整单退款，不做部分结算
    expect(billing.refundResource).toHaveBeenCalledWith("image:req-legacy-fail");
    expect(billing.settleResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("reserves and settles with the admin-configured model resource key when present", async () => {
    const modelRow = {
      resourceKey: "image_generation_qwen_image_2_0_pro_2026_04_22_1k",
      displayName: "Qwen 生图 1K",
      pricingType: "PER_UNIT",
      rate: 15,
      perUnits: 1,
      enabled: true,
    };
    const prisma = createPrismaMock();
    const billing = createBillingMock({ listResourcePrices: vi.fn(async () => ({ data: [modelRow] })) });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-model-key", prompt: "陶瓷餐盘", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(202);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "image_generation_qwen_image_2_0_pro_2026_04_22_1k",
    }));
    await scheduled[0];
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-model-key",
      resourceKey: "image_generation_qwen_image_2_0_pro_2026_04_22_1k",
      units: 1,
    });
    await app.close();
  });

  it("resolves pricing for a specific model through the pricing endpoint", async () => {
    const billing = createBillingMock({
      listResourcePrices: vi.fn(async () => ({
        data: [{
          resourceKey: "image_generation_gpt_image_2_1k",
          displayName: "GPT Image 生图 1K",
          pricingType: "PER_UNIT",
          rate: 33,
          perUnits: 1,
          enabled: true,
        }],
      })),
    });
    const app = await createApp({ prisma: createPrismaMock(), billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const withModel = await app.inject({ method: "GET", url: "/api/workflow/images/pricing?model=gpt-image-2" });
    expect(withModel.statusCode).toBe(200);
    expect(withModel.json().data["1K"]).toMatchObject({
      resourceKey: "image_generation_gpt_image_2_1k",
      rate: 33,
    });

    const withoutModel = await app.inject({ method: "GET", url: "/api/workflow/images/pricing" });
    expect(withoutModel.statusCode).toBe(200);
    expect(withoutModel.json().data["1K"]).toMatchObject({ resourceKey: "image_generation_1k" });
    await app.close();
  });

  it("settles a reservation exactly once when two settlement paths race", async () => {
    const tasks: ImageTaskRow[] = [{
      id: "task-race",
      userId: "u1",
      requestId: "req-settle-race",
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 2,
      status: "completed",
      completedCount: 1,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_1k",
      billingReservedUnits: 2,
      billingStatus: "reserved",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:01:00.000Z"),
    }];
    const prisma = createPrismaMock([{
      id: "img-race-0",
      userId: "u1",
      requestId: "req-settle-race",
      requestIndex: 0,
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      originalUrl: "https://img.test/race-0.png",
      thumbnailUrl: "https://img.test/race-0.png",
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T08:00:30.000Z"),
    }], tasks);
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/api/workflow/images/state" }),
      app.inject({ method: "GET", url: "/api/workflow/images/state" }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(billing.settleResource).toHaveBeenCalledTimes(1);
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-settle-race",
      resourceKey: "image_generation_1k",
      units: 1,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(tasks[0]).toMatchObject({ billingStatus: "settled", billingSettledUnits: 1 });
    await app.close();
  });

  it("waits for sibling branches to quiesce before settling a failed reserve task", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // 慢分支：在另一分支已失败之后才完成入库
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { code: "moderation_blocked", type: "image_generation_error", message: "request blocked by moderation" },
      }), { status: 400 });
    }) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-quiesce", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });

    expect(response.statusCode).toBe(202);
    await expect(scheduled[0]).rejects.toThrow("request blocked by moderation");
    // 慢分支已入库的那张必须被计入结算，否则等于白送
    expect(prisma.imageAsset.upsert).toHaveBeenCalledTimes(1);
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-quiesce",
      resourceKey: "image_generation_1k",
      units: 1,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("retries a settle_failed reservation during state recovery", async () => {
    const tasks: ImageTaskRow[] = [{
      id: "task-settle-failed",
      userId: "u1",
      requestId: "req-settle-failed",
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 2,
      status: "completed",
      completedCount: 2,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_1k",
      billingReservedUnits: 2,
      billingStatus: "settle_failed",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:05:00.000Z"),
    }];
    const prisma = createPrismaMock([0, 1].map((index) => ({
      id: `img-settle-failed-${index}`,
      userId: "u1",
      requestId: "req-settle-failed",
      requestIndex: index,
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      originalUrl: `https://img.test/sf-${index}.png`,
      thumbnailUrl: `https://img.test/sf-${index}.png`,
      objectKey: null,
      mime: "image/png",
      createdAt: new Date("2026-06-30T08:01:00.000Z"),
    })), tasks);
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({ method: "GET", url: "/api/workflow/images/state" });

    expect(response.statusCode).toBe(200);
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "image:req-settle-failed",
      resourceKey: "image_generation_1k",
      units: 2,
    });
    expect(tasks[0]).toMatchObject({ billingStatus: "settled", billingSettledUnits: 2 });
    await app.close();
  });

  it("recovers a reservation left in settling by a crash, but leaves fresh settling alone", async () => {
    const staleTask: ImageTaskRow = {
      id: "task-stuck-settling",
      userId: "u1",
      requestId: "req-stuck-settling",
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 1,
      status: "failed",
      completedCount: 0,
      error: "生成失败",
      billingMode: "reserve",
      billingResourceKey: "image_generation_1k",
      billingReservedUnits: 1,
      billingStatus: "settling",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:00:30.000Z"),
    };
    const prisma = createPrismaMock([], [staleTask]);
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    expect((await app.inject({ method: "GET", url: "/api/workflow/images/state" })).statusCode).toBe(200);
    expect(billing.refundResource).toHaveBeenCalledWith("image:req-stuck-settling");
    expect(staleTask).toMatchObject({ billingStatus: "refunded", billingSettledUnits: 0 });
    await app.close();

    const freshTask: ImageTaskRow = {
      ...staleTask,
      id: "task-fresh-settling",
      requestId: "req-fresh-settling",
      billingStatus: "settling",
      billingSettledUnits: null,
      updatedAt: new Date(),
    };
    const freshBilling = createBillingMock();
    const freshApp = await createApp({
      prisma: createPrismaMock([], [freshTask]),
      billing: freshBilling,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    expect((await freshApp.inject({ method: "GET", url: "/api/workflow/images/state" })).statusCode).toBe(200);
    // 仍在结算中的预留不能被抢走
    expect(freshBilling.refundResource).not.toHaveBeenCalled();
    expect(freshBilling.settleResource).not.toHaveBeenCalled();
    expect(freshTask.billingStatus).toBe("settling");
    await freshApp.close();
  });

  it("returns the winning task without refunding when a duplicate submit hits the requestId unique key", async () => {
    const tasks: ImageTaskRow[] = [];
    const prisma = createPrismaMock([], tasks);
    const winner: ImageTaskRow = {
      id: "task-winner",
      userId: "u1",
      requestId: "req-duplicate-submit",
      prompt: "陶瓷餐盘",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 2,
      status: "running",
      completedCount: 0,
      error: null,
      billingMode: "reserve",
      billingResourceKey: "image_generation_1k",
      billingReservedUnits: 2,
      billingStatus: "reserved",
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:00:00.000Z"),
    };
    prisma.imageGenerationTask.create.mockImplementationOnce(async () => {
      // 赢家在本次 create 之前已建单：唯一键冲突
      tasks.push(winner);
      throw Object.assign(new Error("Unique constraint failed on the fields: (`requestId`)"), { code: "P2002" });
    });
    const billing = createBillingMock();
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-duplicate-submit", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({ requestId: "req-duplicate-submit", status: "running" });
    // 绝不能退掉赢家仍在生效的预留
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(winner.billingStatus).toBe("reserved");
    expect(scheduled).toHaveLength(0);
    await app.close();
  });

  it("keeps a cancelled task cancelled and settles once when the upstream fetch aborts mid-flight", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const generated = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-abort-midflight", prompt: "陶瓷餐盘", size: "1024x1024", count: 1 },
    });
    expect(generated.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cancelled = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-abort-midflight/cancel" });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.task).toMatchObject({ status: "cancelled" });
    await scheduled[0];

    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    // runner 的 AbortError 不得把已取消改写成 failed，也不得二次结算
    expect(tasksResponse.json().data[0]).toMatchObject({ status: "cancelled", error: "用户已取消" });
    expect(billing.refundResource).toHaveBeenCalledTimes(1);
    expect(billing.settleResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("refunds the reservation when task creation fails for a non-conflict reason", async () => {
    const prisma = createPrismaMock();
    prisma.imageGenerationTask.create.mockImplementationOnce(async () => {
      throw new Error("connection reset");
    });
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-create-broken", prompt: "陶瓷餐盘", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(500);
    expect(billing.refundResource).toHaveBeenCalledWith("image:req-create-broken");
    await app.close();
  });

  /**
   * P1.1 把这 8 个路由的内联 401 守卫换成了逐路由 `{ preHandler: requireUser }`。
   *
   * 本文件不能挂插件级钩子：`GET /:imageId/blob` 是签名 URL 取图，故意不要登录态
   * （前端 <img src> 带不了 Authorization 头）。所以守卫是一条一条挂的 ——
   * 这意味着一条断言只能钉住一条路由，删掉别的 preHandler 照样全绿。故此处逐条断言。
   *
   * 本文件原先唯一那处 401 是「签名被篡改」，走的是 blob 路由的签名校验，
   * 跟登录守卫是两回事。等于 8 个登录守卫此前一条都没测过。
   */
  it("未登录时 8 个受保护路由逐条返回 401，签名取图路由不受影响", async () => {
    const prisma = createPrismaMock();
    // listResourcePrices 在 BillingMock 里是可选的，默认工厂不给。
    // 不显式传，下面那句 not.toHaveBeenCalled() 会因为拿到 undefined 直接报错。
    const billing = createBillingMock({ listResourcePrices: vi.fn(async () => ({ data: [] })) });
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn, userId: "" });
    const cases = [
      { method: "GET" as const, url: "/api/workflow/images" },
      { method: "POST" as const, url: "/api/workflow/images/references", payload: {} },
      { method: "GET" as const, url: "/api/workflow/images/pricing" },
      { method: "GET" as const, url: "/api/workflow/images/tasks" },
      { method: "GET" as const, url: "/api/workflow/images/state" },
      { method: "POST" as const, url: "/api/workflow/images/optimize-prompt", payload: { prompt: "x" } },
      { method: "POST" as const, url: "/api/workflow/images/tasks/req-1/cancel" },
      { method: "POST" as const, url: "/api/workflow/images/generate", payload: { prompt: "x" } },
    ];
    for (const one of cases) {
      const res = await app.inject(one);
      expect(res.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(res.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    // 守卫失效的真实后果不是崩：/pricing、/state 这类只读路由会拿着空 userId 返 200
    // （别人的图会漏出去），/generate 会真去占额度并打供应商。所以要断到上游一次没碰。
    expect(fetchFn).not.toHaveBeenCalled();
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(billing.listResourcePrices).not.toHaveBeenCalled();
    expect(prisma.imageAsset.findMany).not.toHaveBeenCalled();
    expect(prisma.imageGenerationTask.findMany).not.toHaveBeenCalled();
    expect(prisma.imageGenerationTask.create).not.toHaveBeenCalled();

    // 反证：blob 路由故意没挂 preHandler，未登录不该被拦。不带签名参数时它自己校验失败
    // 返 400 —— 能走到自己的 handler 才说明守卫没误伤它。
    const blob = await app.inject({ method: "GET", url: "/api/workflow/images/img-1/blob" });
    expect(blob.statusCode).toBe(400);
    await app.close();
  });
});

describe("image 主动扫接线", () => {
  function makeRedis(result: "OK" | null = "OK") {
    return { set: vi.fn(async () => result) };
  }

  function staleRunningTask(overrides: Partial<ImageTaskRow> = {}): ImageTaskRow {
    return {
      id: "task-reaper",
      userId: "u-other",
      requestId: "req-reaper",
      prompt: "商业美食摄影",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      count: 1,
      status: "running",
      completedCount: 0,
      error: null,
      createdAt: new Date("2026-06-29T07:00:00.000Z"),
      updatedAt: new Date("2026-06-29T07:00:00.000Z"),
      ...overrides,
    };
  }

  function okFetch() {
    return vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })
    ) as typeof fetch;
  }

  it("没人轮询也能把卡住的任务拉起来（任务属于别的用户，请求一次都没发）", async () => {
    vi.useFakeTimers();
    try {
      const task = staleRunningTask();
      const prisma = createPrismaMock([], [task]);
      const billing = createBillingMock();
      const scheduled: Promise<void>[] = [];
      const redis = makeRedis("OK");
      const app = await createApp({ prisma, billing, fetchFn: okFetch(), scheduled, staleTaskMs: 1, redis });

      // 关键：全程不发任何 HTTP 请求，纯靠定时器
      await vi.advanceTimersByTimeAsync(60_000);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(scheduled).toHaveLength(1);

      vi.useRealTimers();
      await scheduled[0];
      expect(task.status).toBe("completed");
      expect(task.completedCount).toBe(1);
      // 续跑不该重新扣费
      expect(billing.reserveResource).not.toHaveBeenCalled();
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("不给 redis 就不起定时器（既有测试与单机部署不受影响）", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock([], [staleRunningTask()]);
      const scheduled: Promise<void>[] = [];
      const app = await createApp({
        prisma,
        billing: createBillingMock(),
        fetchFn: okFetch(),
        scheduled,
        staleTaskMs: 1,
      });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(scheduled).toHaveLength(0);
      expect(prisma.imageGenerationTask.findMany).not.toHaveBeenCalled();
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("抢不到锁就整轮跳过，多实例不会重复拉起同一批", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock([], [staleRunningTask()]);
      const scheduled: Promise<void>[] = [];
      const app = await createApp({
        prisma,
        billing: createBillingMock(),
        fetchFn: okFetch(),
        scheduled,
        staleTaskMs: 1,
        redis: makeRedis(null),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduled).toHaveLength(0);
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("onClose 清掉定时器，插件反复注册不攒 timer", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock([], []);
      const redis = makeRedis("OK");
      const app = await createApp({
        prisma,
        billing: createBillingMock(),
        fetchFn: okFetch(),
        staleTaskMs: 1,
        redis,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(redis.set).toHaveBeenCalledTimes(1);

      await app.close();
      await vi.advanceTimersByTimeAsync(300_000);
      // 关掉之后不再有新一轮
      expect(redis.set).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // 这条证的是「对账那趟接到了真结算」。
  // 「并发不双花」不在这里证：瞬时竞争由既有用例
  // 「settles a reservation exactly once when two settlement paths race」守着
  // （settleImageTaskBilling 里 billingStatus -> settling 的原子抢占），
  // 跨轮不重复由 reconcilePendingImageBilling 自己的 billingStatus 过滤守着。
  // 下面多跑几轮只是顺带的冒烟，不是那两条保证的替身。
  it("没人轮询也能把终态漏掉的账补上", async () => {
    const task = staleRunningTask({
      id: "task-leak",
      userId: "u1",
      requestId: "req-leak",
      status: "completed",
      completedCount: 1,
      billingMode: "reserve",
      billingResourceKey: "image.qwen",
      billingReservedUnits: 1,
      billingStatus: "reserved",
    });
    const prisma = createPrismaMock(
      [{
        id: "img-leak",
        userId: "u1",
        requestId: "req-leak",
        requestIndex: 0,
        prompt: "商业美食摄影",
        model: "qwen-image-2.0-pro-2026-04-22",
        size: "1024x1024",
        originalUrl: "https://img.test/leak.png",
        thumbnailUrl: "https://img.test/leak.png",
        objectKey: "images/leak.png",
        mime: "image/png",
        createdAt: new Date("2026-06-29T07:00:00.000Z"),
      }],
      [task],
    );
    const billing = createBillingMock();
    const redis = makeRedis("OK");

    // 假定时器必须在建 app 之前开：setInterval 是注册插件时创建的，
    // 事后切假的不会把已存在的真定时器接管过来（这里踩过一次）。
    vi.useFakeTimers();
    try {
      const app = await createApp({ prisma, billing, fetchFn: okFetch(), staleTaskMs: 1, redis });

      // 第一轮：这行是 completed + billingStatus=reserved，谁都没在等它，
      // 之前只有用户自己轮询才会被补上——现在定时器就该补掉。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(billing.settleResource).toHaveBeenCalledTimes(1);
      expect(task.billingStatus).toBe("settled");

      // 顺带：再跑三轮不该又结算一次（真正的守卫在上面注释里，这里只是冒烟）
      await vi.advanceTimersByTimeAsync(180_000);
      expect(redis.set).toHaveBeenCalledTimes(4);
      expect(billing.settleResource).toHaveBeenCalledTimes(1);
      expect(billing.refundResource).not.toHaveBeenCalled();
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
