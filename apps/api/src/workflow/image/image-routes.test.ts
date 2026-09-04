import Fastify from "fastify";
import sharp from "sharp";
import { describe, expect, it, beforeEach, vi } from "vitest";
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
      // status / updatedAt 这两个条件是 reaper 的查询在用的（不带 userId）。
      // 轮询路径只传 userId，那两个 undefined 时不过滤，所以既有用例行为不变。
      findMany: vi.fn(async (args: {
        where?: {
          userId?: string;
          status?: string;
          updatedAt?: { lt?: Date };
        };
        orderBy?: Record<string, string>;
        take?: number;
      }) => {
        const where = args.where;
        let result = tasks.filter((row) => !where?.userId || row.userId === where.userId);
        if (typeof where?.status === "string") {
          result = result.filter((row) => row.status === where.status);
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
          updatedAt?: Date;
        };
        data: Partial<ImageTaskRow>;
      }) => {
        const matchesUpdatedAt = (row: ImageTaskRow) => {
          const filter = args.where.updatedAt;
          if (filter === undefined) return true;
          return row.updatedAt.getTime() === filter.getTime();
        };
        const row = tasks.find((item) =>
          (!args.where.id || item.id === args.where.id) &&
          (!args.where.userId || item.userId === args.where.userId) &&
          (!args.where.requestId || item.requestId === args.where.requestId) &&
          (!args.where.status || item.status === args.where.status) &&
          matchesUpdatedAt(item)
        );
        if (!row) return { count: 0 };
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
  };
}

async function createApp(options: {
  readonly prisma: ReturnType<typeof createPrismaMock>;
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
    const app = await createApp({ prisma, fetchFn: vi.fn() as unknown as typeof fetch });
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
    const app = await createApp({ prisma, fetchFn: vi.fn() as unknown as typeof fetch });

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
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-12345678", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.task.status).toBe("running");
    expect(scheduled).toHaveLength(1);
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

  /**
   * P3.4 的护栏：`IMAGE_KEEP_LIMIT` 只截列表，不删库。
   *
   * 旧实现在每次生图成功后调 `pruneImages`，把该用户第 50 条之后的 `ImageAsset`
   * 连 S3 对象一起硬删。窗口是**所有非 `ecom-` 前缀共用**的，所以掉出去的往往不是
   * 刚才那张生图，而是最老的文章配图 / 桌宠底图 —— 素材库上线后这就是「素材凭空消失」。
   * 这里种满 50 条再跑一次生图：列表还是 50 条，库里必须是 52 条。
   */
  it("caps the image list at IMAGE_KEEP_LIMIT without deleting anything past it", async () => {
    const rows: ImageRow[] = Array.from({ length: 50 }, (_, index) => ({
      id: `seed-${index}`,
      userId: "u1",
      requestId: index === 0 ? "article:doc-1:inline-4:oldest" : index % 2 === 0 ? `pet-${index}` : `img-${index}`,
      requestIndex: 0,
      prompt: "历史素材",
      model: "qwen-image-2.0-pro-2026-04-22",
      size: "1024x1024",
      originalUrl: `http://localhost:9000/private/seed-${index}.png`,
      thumbnailUrl: `http://localhost:9000/private/seed-${index}.png`,
      // 每条都有 objectKey：旧实现连带删的就是这些对象。
      objectKey: `workflow/images/u1/seed-${index}.png`,
      mime: "image/png",
      // 升序，所以 seed-0（那张文章配图）最老，正是旧实现第一个删的。
      createdAt: new Date(Date.UTC(2026, 4, 1, 0, index)),
    }));
    const prisma = createPrismaMock(rows);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-keep-limit", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });
    expect(response.statusCode).toBe(202);
    await scheduled[0];

    expect(prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(52);
    expect(rows.some((row) => row.id === "seed-0")).toBe(true);

    // 列表仍然只给最近 50 条：最老的两条掉出窗口 —— 掉出窗口不等于从库里消失。
    const listed = (await app.inject({ method: "GET", url: "/api/workflow/images" })).json().data as { readonly id: string }[];
    expect(listed).toHaveLength(50);
    expect(listed.map((image) => image.id)).not.toContain("seed-0");
    await app.close();
  });

  it("selects GPT Image 2 and sends the OpenAI-compatible generation body", async () => {
    process.env.GPT_IMAGE_API_KEY = "gpt-image-key";
    process.env.GPT_IMAGE_GENERATION_ENDPOINT = "https://pixel.test/v1/images/generations";
    const prisma = createPrismaMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("gpt-png").toString("base64") }],
    }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

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
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: "gpt-image-2-codex",
      quality: "auto",
      data: [{ b64_json: Buffer.from("edited-png").toString("base64") }],
    }), { status: 200 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

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
    const app = await createApp({ prisma, fetchFn, scheduled });

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
    const app = await createApp({ prisma, fetchFn: vi.fn() as unknown as typeof fetch });

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
    const app = await createApp({ prisma, fetchFn, scheduled });

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
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

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

  it("returns a completed task for legacy existing image assets", async () => {
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
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, fetchFn });

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
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, fetchFn });

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
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, fetchFn });

    const response = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([expect.objectContaining({
      requestId: "req-running",
      status: "running",
      completedCount: 1,
    })]);
    await app.close();
  });

  it("resumes stale running image tasks from state loading", async () => {
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
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled, staleTaskMs: 1 });

    const response = await app.inject({ method: "GET", url: "/api/workflow/images/state" });

    expect(response.statusCode).toBe(200);
    expect(scheduled).toHaveLength(1);
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
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("gpt-png").toString("base64") }],
    }), { status: 200 })) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled, staleTaskMs: 1 });

    expect((await app.inject({ method: "GET", url: "/api/workflow/images/state" })).statusCode).toBe(200);
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("https://pixel.test/v1/images/generations");
    const body = JSON.parse(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: "gpt-image-2", prompt: "极简产品摄影" });
    expect(body).not.toHaveProperty("input");
    await app.close();
  });

  it("cancels a running image task", async () => {
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
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, fetchFn });

    const response = await app.inject({ method: "POST", url: "/api/workflow/images/tasks/req-cancel-1/cancel" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({
      requestId: "req-cancel-1",
      status: "cancelled",
      error: "用户已取消",
    });
    await app.close();
  });

  it("stops retrying when a running image task is cancelled", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: "https://img.test/a.png" }] }), { status: 200 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled, retryDelayMs: 40 });

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
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({
      prisma,
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
    await app.close();
  });

  it("retries relay failures in the background worker", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: "https://img.test/a.png" }] }), { status: 200 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

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

  it("does not retry moderation failures", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "moderation_blocked",
        type: "image_generation_error",
        message: "request blocked by moderation",
      },
    }), { status: 400 })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-moderation", prompt: "blocked prompt", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(202);
    await expect(scheduled[0]).rejects.toThrow("request blocked by moderation");
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({ status: "failed", completedCount: 0 });
    await app.close();
  });

  it("rejects more than 8 concurrent images", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-too-many", prompt: "小龙虾", size: "1024x1024", count: 9 },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects 4K output because Qwen Image 2.0 Pro supports at most 2K", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-4k-output", prompt: "小龙虾", size: "3840x2160", count: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("最高支持 2K");
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });

  it("waits for sibling branches to quiesce before writing the failed terminal state", async () => {
    const prisma = createPrismaMock();
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
    const app = await createApp({ prisma, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-quiesce", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });

    expect(response.statusCode).toBe(202);
    await expect(scheduled[0]).rejects.toThrow("request blocked by moderation");
    // 慢分支已入库的那张必须真落库，不能因为兄弟分支先失败就丢掉
    expect(prisma.imageAsset.upsert).toHaveBeenCalledTimes(1);
    // 终态写在两个分支都静止之后：failed 落下来时 completedCount 必须已经算上慢分支那张
    const tasksResponse = await app.inject({ method: "GET", url: "/api/workflow/images/tasks" });
    expect(tasksResponse.json().data[0]).toMatchObject({ status: "failed", completedCount: 1 });
    await app.close();
  });

  it("returns the winning task when a duplicate submit hits the requestId unique key", async () => {
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
      createdAt: new Date("2026-06-30T08:00:00.000Z"),
      updatedAt: new Date("2026-06-30T08:00:00.000Z"),
    };
    prisma.imageGenerationTask.create.mockImplementationOnce(async () => {
      // 赢家在本次 create 之前已建单：唯一键冲突
      tasks.push(winner);
      throw Object.assign(new Error("Unique constraint failed on the fields: (`requestId`)"), { code: "P2002" });
    });
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn: vi.fn() as unknown as typeof fetch, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-duplicate-submit", prompt: "陶瓷餐盘", size: "1024x1024", count: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({ requestId: "req-duplicate-submit", status: "running" });
    // 输家绝不能再排一次任务：赢家那行已经有人在跑
    expect(scheduled).toHaveLength(0);
    await app.close();
  });

  it("keeps a cancelled task cancelled when the upstream fetch aborts mid-flight", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    })) as unknown as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, fetchFn, scheduled });

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
    // runner 的 AbortError 不得把已取消改写成 failed
    expect(tasksResponse.json().data[0]).toMatchObject({ status: "cancelled", error: "用户已取消" });
    await app.close();
  });

  it("returns 500 when task creation fails for a non-conflict reason", async () => {
    const prisma = createPrismaMock();
    prisma.imageGenerationTask.create.mockImplementationOnce(async () => {
      throw new Error("connection reset");
    });
    const app = await createApp({ prisma, fetchFn: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/images/generate",
      payload: { requestId: "req-create-broken", prompt: "陶瓷餐盘", size: "1024x1024", count: 1 },
    });

    expect(response.statusCode).toBe(500);
    await app.close();
  });

  /**
   * P1.1 把这 7 个路由的内联 401 守卫换成了逐路由 `{ preHandler: requireUser }`。
   *
   * 本文件不能挂插件级钩子：`GET /:imageId/blob` 是签名 URL 取图，故意不要登录态
   * （前端 <img src> 带不了 Authorization 头）。所以守卫是一条一条挂的 ——
   * 这意味着一条断言只能钉住一条路由，删掉别的 preHandler 照样全绿。故此处逐条断言。
   *
   * 本文件原先唯一那处 401 是「签名被篡改」，走的是 blob 路由的签名校验，
   * 跟登录守卫是两回事。等于 7 个登录守卫此前一条都没测过。
   */
  it("未登录时 7 个受保护路由逐条返回 401，签名取图路由不受影响", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const app = await createApp({ prisma, fetchFn, userId: "" });
    const cases = [
      { method: "GET" as const, url: "/api/workflow/images" },
      { method: "POST" as const, url: "/api/workflow/images/references", payload: {} },
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
    // 守卫失效的真实后果不是崩：/state 这类只读路由会拿着空 userId 返 200
    // （别人的图会漏出去），/generate 会真去打供应商。所以要断到上游一次没碰。
    expect(fetchFn).not.toHaveBeenCalled();
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
      const scheduled: Promise<void>[] = [];
      const redis = makeRedis("OK");
      const app = await createApp({ prisma, fetchFn: okFetch(), scheduled, staleTaskMs: 1, redis });

      // 关键：全程不发任何 HTTP 请求，纯靠定时器
      await vi.advanceTimersByTimeAsync(60_000);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(scheduled).toHaveLength(1);

      vi.useRealTimers();
      await scheduled[0];
      expect(task.status).toBe("completed");
      expect(task.completedCount).toBe(1);
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
});
