import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import type { PrismaClient } from "@prisma/client";
import { videoWorkflowRoutes } from "./video-routes.js";

interface VideoRow {
  id: string;
  userId: string;
  requestId: string;
  requestIndex: number;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  originalUrl: string;
  objectKey: string | null;
  mime: string;
  format: string;
  createdAt: Date;
}

interface VideoTaskRow {
  id: string;
  userId: string;
  requestId: string;
  providerTaskId: string | null;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  generateAudio: boolean;
  hasInputVideo: boolean;
  resourceKey: string;
  chargedPoints: number;
  status: string;
  progress: number;
  error: string | null;
  resultPayload: unknown;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(
  videos: VideoRow[] = [],
  tasks: VideoTaskRow[] = [],
  materials: { url: string; durationSec: number }[] = [],
) {
  return {
    videoMaterial: {
      findMany: vi.fn(async (args: { where?: { url?: { in?: string[] } }; select?: unknown }) => {
        const wanted = args.where?.url?.in ?? [];
        return materials.filter((row) => wanted.includes(row.url)).map((row) => ({ url: row.url, durationSec: row.durationSec }));
      }),
      upsert: vi.fn(async (args: { where: { url: string }; create: { url: string; durationSec: number } }) => {
        const found = materials.find((row) => row.url === args.where.url);
        if (found) return found;
        const row = { url: args.create.url, durationSec: args.create.durationSec };
        materials.push(row);
        return row;
      }),
    },
    videoAsset: {
      findMany: vi.fn(async (args: { where?: { userId?: string; requestId?: string }; orderBy?: Record<string, string>; take?: number }) => {
        let result = videos.filter((row) => !args.where?.userId || row.userId === args.where.userId);
        if (args.where?.requestId) result = result.filter((row) => row.requestId === args.where?.requestId);
        result = [...result].sort((a, b) => {
          if (args.orderBy?.requestIndex) return a.requestIndex - b.requestIndex;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
        if (args.take) result = result.slice(0, args.take);
        return result;
      }),
      upsert: vi.fn(async (args: { create: Omit<VideoRow, "id" | "createdAt"> }) => {
        const row = { ...args.create, id: `vid-${videos.length + 1}`, createdAt: new Date("2026-07-04T08:00:00.000Z") };
        videos.push(row);
        return row;
      }),
    },
    videoGenerationTask: {
      // 兜底扫按 { status, updatedAt: { lt } } 查、且不带 userId，所以这里必须实现这两个条件 ——
      // 只认 userId 的旧 mock 会把所有行都返回，兜底测试就变成假通过。
      findMany: vi.fn(async (args: {
        where?: { userId?: string; status?: string; updatedAt?: { lt?: Date } };
        orderBy?: Record<string, string>;
        take?: number;
      }) => {
        let result = tasks.filter((row) =>
          (!args.where?.userId || row.userId === args.where.userId) &&
          (!args.where?.status || row.status === args.where.status) &&
          (!args.where?.updatedAt?.lt || row.updatedAt.getTime() < args.where.updatedAt.lt.getTime())
        );
        result = [...result].sort((a, b) =>
          args.orderBy?.createdAt === "asc"
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : b.createdAt.getTime() - a.createdAt.getTime()
        );
        if (args.take) result = result.slice(0, args.take);
        return result;
      }),
      findFirst: vi.fn(async (args: { where?: { userId?: string; requestId?: string } }) =>
        tasks.find((row) =>
          (!args.where?.userId || row.userId === args.where.userId) &&
          (!args.where?.requestId || row.requestId === args.where.requestId)
        ) ?? null
      ),
      findUnique: vi.fn(async (args: { where: { id?: string; requestId?: string } }) =>
        tasks.find((row) =>
          (args.where.id && row.id === args.where.id) ||
          (args.where.requestId && row.requestId === args.where.requestId)
        ) ?? null
      ),
      create: vi.fn(async (args: { data: Omit<VideoTaskRow, "id" | "createdAt" | "updatedAt"> }) => {
        const row = {
          ...args.data,
          id: `task-${tasks.length + 1}`,
          createdAt: new Date("2026-07-04T08:00:00.000Z"),
          updatedAt: new Date("2026-07-04T08:00:00.000Z"),
        };
        tasks.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id?: string; requestId?: string }; data: Partial<VideoTaskRow> }) => {
        const row = tasks.find((item) =>
          (args.where.id && item.id === args.where.id) ||
          (args.where.requestId && item.requestId === args.where.requestId)
        );
        if (!row) throw new Error("task not found");
        Object.assign(row, args.data, { updatedAt: new Date("2026-07-04T08:01:00.000Z") });
        return row;
      }),
    },
  };
}

function createBillingMock(overrides: Partial<{
  chargeResource: ReturnType<typeof vi.fn>;
  refundResource: ReturnType<typeof vi.fn>;
  listResourcePrices: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    chargeResource: vi.fn(async () => ({ charged: 120 })),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({ data: [] })),
    reserve: vi.fn(async () => ({ reserved: 10 })),
    settle: vi.fn(async () => ({ settled: 20 })),
    ...overrides,
  };
}

// 注入的 M3 客户端 mock：固定返回一段文本（JSON 或脚本）。
function createLlmMock(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 8 } })),
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

async function createApp(options: {
  readonly prisma: ReturnType<typeof createPrismaMock>;
  readonly billing: ReturnType<typeof createBillingMock>;
  readonly fetchFn: typeof fetch;
  readonly scheduled?: Promise<void>[];
  readonly llmClient?: import("@anthropic-ai/sdk").default;
  readonly visionCfg?: import("./vision-client.js").VisionConfig;
  readonly callVisionFn?: typeof import("./vision-client.js").callVision;
  readonly submitRetries?: number;
  readonly redis?: import("ioredis").Redis;
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { userId: string }).userId = "u1";
  });
  await app.register(videoWorkflowRoutes, {
    prisma: options.prisma as unknown as PrismaClient,
    billing: options.billing,
    fetchFn: options.fetchFn,
    redis: options.redis,
    pollInitialDelayMs: 0,
    pollIntervalMs: 1,
    maxPollAttempts: 2,
    submitRetries: options.submitRetries ?? 0,
    submitRetryDelayMs: 0,
    llmClient: options.llmClient,
    visionCfg: options.visionCfg,
    callVisionFn: options.callVisionFn,
    scheduleTask: (work: () => Promise<void>) => {
      options.scheduled?.push(work());
    },
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  process.env.TOAPIS_API_KEY = "test-key";
  process.env.TOAPIS_BASE_URL = "https://toapis.test/v1";
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_BUCKET;
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
});

describe("video workflow routes", () => {
  it("starts a persistent video task, charges by seconds, and stores completed video", async () => {
    const prisma = createPrismaMock([], [], [{ url: "https://example.test/ref.mp4", durationSec: 5 }]);
    const billing = createBillingMock();
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          id: "tsk_vid_1",
          object: "generation.task",
          model: "seedance-2-mini",
          status: "in_progress",
          progress: 10,
          created_at: 1781577600,
        }), { status: 200 });
      }
      if (url.endsWith("/v1/videos/generations/tsk_vid_1")) {
        return new Response(JSON.stringify({
          id: "tsk_vid_1",
          object: "generation.task",
          model: "seedance-2-mini",
          status: "completed",
          progress: 100,
          completed_at: 1781577700,
          result: { type: "video", data: [{ url: "https://cdn.example.test/out.mp4", format: "mp4" }] },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/videos/generate",
      payload: {
        requestId: "vid-req-0001",
        prompt: "参考视频1的运镜生成产品短片",
        model: "seedance-2-mini",
        durationSec: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        generateAudio: true,
        videoWithRoles: [{ url: "https://example.test/ref.mp4", role: "reference_video" }],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(scheduled).toHaveLength(1);
    // 有输入视频：复合计费，units 为输出秒数、inputUnits 为输入视频权威时长（ref.mp4 = 5s）。
    expect(billing.chargeResource).toHaveBeenCalledWith({
      operationId: "video:vid-req-0001",
      userId: "u1",
      resourceKey: "video_seedance_2_mini_720p_with_video",
      units: 8,
      inputUnits: 5,
      accountType: "video",
    });
    const requestBody = JSON.parse((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(requestBody).not.toHaveProperty("generate_audio");
    expect(requestBody.video_with_roles).toEqual([{ url: "https://example.test/ref.mp4", role: "reference_video" }]);

    await scheduled[0];
    const stateResponse = await app.inject({ method: "GET", url: "/api/workflow/videos/state" });
    expect(stateResponse.json().data.tasks[0]).toMatchObject({
      requestId: "vid-req-0001",
      status: "completed",
      progress: 100,
    });
    expect(stateResponse.json().data.videos[0]).toMatchObject({
      requestId: "vid-req-0001",
      originalUrl: "https://cdn.example.test/out.mp4",
      format: "mp4",
    });
    await app.close();
  });

  it("提交遇瞬态 abort 时自动重试并最终成功", async () => {
    const prisma = createPrismaMock([], [], []);
    const billing = createBillingMock();
    let postCalls = 0;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCalls += 1;
        if (postCalls === 1) throw new Error("This operation was aborted");
        return new Response(JSON.stringify({ id: "tsk_retry_1", status: "in_progress", progress: 5 }), { status: 200 });
      }
      if (url.endsWith("/v1/videos/generations/tsk_retry_1")) {
        return new Response(JSON.stringify({
          id: "tsk_retry_1", status: "completed", progress: 100, completed_at: 1781577700,
          result: { type: "video", data: [{ url: "https://cdn.example.test/retry.mp4", format: "mp4" }] },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled, submitRetries: 1 });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/videos/generate",
      payload: {
        requestId: "vid-retry-0001",
        prompt: "文生视频提交重试",
        model: "seedance-2",
        durationSec: 5,
        aspectRatio: "9:16",
        resolution: "720p",
        generateAudio: false,
      },
    });

    expect(response.statusCode).toBe(202);
    await scheduled[0];
    expect(postCalls).toBe(2); // 第一次 abort，第二次成功
    const state = await app.inject({ method: "GET", url: "/api/workflow/videos/state" });
    expect(state.json().data.tasks[0]).toMatchObject({ requestId: "vid-retry-0001", status: "completed" });
    await app.close();
  });

  it("提交遇 4xx 客户端错误不重试直接失败", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    let postCalls = 0;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { postCalls += 1; return new Response("bad request", { status: 400 }); }
      throw new Error("unexpected");
    }) as typeof fetch;
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, fetchFn, scheduled, submitRetries: 2 });

    await app.inject({
      method: "POST",
      url: "/api/workflow/videos/generate",
      payload: { requestId: "vid-4xx-0001", prompt: "x", model: "seedance-2", durationSec: 5, aspectRatio: "9:16", resolution: "720p", generateAudio: false },
    });
    await scheduled[0].catch(() => undefined);
    expect(postCalls).toBe(1); // 4xx 不重试
    // 失败已退款
    expect(billing.refundResource).toHaveBeenCalledWith("video:vid-4xx-0001");
    await app.close();
  });

  it("auto duration (0) reserves at max 15s upfront", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "tsk_auto", status: "in_progress", progress: 0 }), { status: 200 })) as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/videos/generate",
      payload: {
        requestId: "vid-auto-0001",
        prompt: "自动时长文生视频",
        model: "seedance-2",
        durationSec: 0,
        aspectRatio: "9:16",
        resolution: "720p",
        generateAudio: false,
      },
    });

    expect(response.statusCode).toBe(202);
    // 自动时长按最大 15s 预扣，无输入视频不带 inputUnits
    expect(billing.chargeResource).toHaveBeenCalledWith({
      operationId: "video:vid-auto-0001",
      userId: "u1",
      resourceKey: "video_seedance_2_720p_text",
      units: 15,
      accountType: "video",
    });
    await app.close();
  });

  it("returns 402 without creating a task when video points are insufficient", async () => {
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
      url: "/api/workflow/videos/generate",
      payload: {
        requestId: "vid-req-0002",
        prompt: "文生视频",
        model: "seedance-2",
        durationSec: 5,
        aspectRatio: "9:16",
        resolution: "720p",
        generateAudio: false,
      },
    });

    expect(response.statusCode).toBe(402);
    expect(prisma.videoGenerationTask.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects with 400 and does not charge when input video duration is unknown", async () => {
    // 输入视频 URL 未在素材库登记时长 → 无法计费，必须拒绝且不扣费。
    const prisma = createPrismaMock([], [], []);
    const billing = createBillingMock();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const app = await createApp({ prisma, billing, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/videos/generate",
      payload: {
        requestId: "vid-req-0003",
        prompt: "参考视频生成",
        model: "seedance-2-mini",
        durationSec: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        generateAudio: true,
        videoWithRoles: [{ url: "https://example.test/unknown.mp4", role: "reference_video" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(prisma.videoGenerationTask.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("帮我写 analyze-materials 按图片计费并返回商品洞察", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const insight = { materials: [{ index: 1, description: "欧式洋房" }], insight: { productName: "洗发水", category: "个护", features: [], sellingPoints: [], audience: [], scenes: [] } };
    const app = await createApp({
      prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch,
      visionCfg: { baseUrl: "https://gw.test", apiKey: "k", model: "gemini-2.5-flash" },
      callVisionFn: vi.fn().mockResolvedValue({ text: JSON.stringify(insight), usage: { inputTokens: 1795, outputTokens: 50 } }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflow/videos/analyze-materials",
      payload: { requestId: "analyze-0001", materials: [{ url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.insight.productName).toBe("洗发水");
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "video_analyze_image", units: 1, accountType: "points" }));
    await app.close();
  });

  it("帮我写 analyze-pricing 返回图片/视频秒拆解价", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock({
      listResourcePrices: vi.fn(async () => ({ data: [
        { resourceKey: "video_analyze_image", displayName: "图片拆解", pricingType: "PER_UNIT", rate: 2, perUnits: 1, enabled: true },
        { resourceKey: "video_analyze_video_sec", displayName: "视频拆解", pricingType: "PER_UNIT", rate: 1, perUnits: 1, enabled: false },
      ] })),
    });
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch });

    const res = await app.inject({ method: "GET", url: "/api/workflow/videos/analyze-pricing" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.image).toMatchObject({ rate: 2, enabled: true });
    expect(res.json().data.videoSec).toMatchObject({ rate: 1, enabled: false });
    await app.close();
  });

  it("帮我写 generate-script 预留+结算(token×2) 并返回脚本", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing, fetchFn: vi.fn() as unknown as typeof fetch, llmClient: createLlmMock("0-3s 开场…") });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflow/videos/generate-script",
      payload: {
        insight: { productName: "洗发水", category: "", features: [], sellingPoints: [], audience: [], scenes: [] },
        business: "电商带货", language: "中文", contentType: "智能匹配", shootType: "智能匹配", note: "", durationSec: 15,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.script).toContain("开场");
    expect(billing.reserve).toHaveBeenCalledWith(expect.objectContaining({ type: "video-script", model: "MiniMax-M3" }));
    // usage 10/8 ×2 = 20/16
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 20, outputTokens: 16 }));
    await app.close();
  });
});

// 兜底扫在插件里的接线。上面的 reaper 单测覆盖分支判定，这里只验「装上没装错」：
// 有 redis 才起、抢锁、扫出来的行确实走到真实的续跑/退款代码，而不是 mock 的 handler。
describe("video 兜底扫接线", () => {
  const STALE_AT = new Date("2026-07-04T07:00:00.000Z");

  function makeStaleTask(overrides: Partial<VideoTaskRow> = {}): VideoTaskRow {
    return {
      id: "task-stale",
      userId: "u1",
      requestId: "vid-stale-0001",
      providerTaskId: "tsk_vid_stale",
      prompt: "一只猫",
      model: "seedance-2-mini",
      aspectRatio: "16:9",
      resolution: "720p",
      durationSec: 8,
      generateAudio: true,
      hasInputVideo: false,
      resourceKey: "video_seedance_2_mini_720p",
      chargedPoints: 120,
      status: "running",
      progress: 20,
      error: null,
      resultPayload: null,
      completedAt: null,
      createdAt: new Date("2026-07-04T06:00:00.000Z"),
      updatedAt: STALE_AT,
      ...overrides,
    };
  }

  function makeRedis(setResult: "OK" | null = "OK") {
    return { set: vi.fn(async () => setResult) } as unknown as import("ioredis").Redis;
  }

  /** 定时器必须在 createApp 之前装好，否则 startVideoReaper 的 setInterval 落在真定时器上，advance 推不动它。 */
  async function tick(app: import("fastify").FastifyInstance) {
    // 续跑那条链在假定时器下全是微任务（initialDelayMs=0，首轮就 completed，无 S3 所以不下载），
    // advanceTimersByTimeAsync 会在跑定时器之间排空微任务；再多推一点收尾。
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(100);
    void app;
  }

  it("不传 redis 就不起定时器（单机/测试环境保持安静）", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock([], [makeStaleTask()]);
      const app = await createApp({ prisma, billing: createBillingMock(), fetchFn: vi.fn() as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(prisma.videoGenerationTask.findMany).not.toHaveBeenCalled();
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("抢不到锁就整轮跳过，多实例不会重复处置同一批", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock([], [makeStaleTask()]);
      const app = await createApp({
        prisma,
        billing: createBillingMock(),
        fetchFn: vi.fn() as unknown as typeof fetch,
        redis: makeRedis(null),
      });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(prisma.videoGenerationTask.findMany).not.toHaveBeenCalled();
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("上游仍认这个任务 → 续跑到完成，不退款、不重复提交", async () => {
    vi.useFakeTimers();
    try {
      const tasks = [makeStaleTask()];
      const prisma = createPrismaMock([], tasks);
      const billing = createBillingMock();
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") throw new Error(`兜底扫不该重新提交：${url}`);
        return new Response(JSON.stringify({
          id: "tsk_vid_stale",
          object: "generation.task",
          model: "seedance-2-mini",
          status: "completed",
          progress: 100,
          completed_at: 1781577700,
          result: { type: "video", data: [{ url: "https://cdn.example.test/out.mp4", format: "mp4" }] },
        }), { status: 200 });
      }) as unknown as typeof fetch;
      const redis = makeRedis();
      const app = await createApp({ prisma, billing, fetchFn, redis });

      await tick(app);

      expect(redis.set).toHaveBeenCalledWith("ai-assistant:video:reaper:lock", "1", "EX", 55, "NX");
      expect(tasks[0]!.status).toBe("completed");
      // 关键：一次 POST 都没有 —— 复用的是「提交之后那半段」，不是整条 runVideoTask。
      const posts = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1]?.method === "POST");
      expect(posts).toHaveLength(0);
      expect(billing.refundResource).not.toHaveBeenCalled();
      // 视频也真的入库了，不是只把状态改了。
      expect(prisma.videoAsset.upsert).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("上游查不到（404）→ 置 failed 并按 video:{requestId} 退款", async () => {
    vi.useFakeTimers();
    try {
      const tasks = [makeStaleTask()];
      const prisma = createPrismaMock([], tasks);
      const billing = createBillingMock();
      const fetchFn = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
      const app = await createApp({ prisma, billing, fetchFn, redis: makeRedis() });

      await tick(app);

      expect(tasks[0]!.status).toBe("failed");
      expect(billing.refundResource).toHaveBeenCalledWith("video:vid-stale-0001");
      expect(tasks[0]!.error).toContain("上游已无此任务");
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("上游暂时答不了（500）→ 不退款、状态不动，等下一轮", async () => {
    vi.useFakeTimers();
    try {
      const tasks = [makeStaleTask()];
      const prisma = createPrismaMock([], tasks);
      const billing = createBillingMock();
      const fetchFn = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
      const app = await createApp({ prisma, billing, fetchFn, redis: makeRedis() });

      await tick(app);

      // 探测确实发出去了（不是因为没扫到才没退款）。
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(billing.refundResource).not.toHaveBeenCalled();
      expect(tasks[0]!.status).toBe("running");
      expect(tasks[0]!.updatedAt.getTime()).toBe(STALE_AT.getTime());
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有 providerTaskId → 直接失败退款，一次上游请求都不发", async () => {
    vi.useFakeTimers();
    try {
      const tasks = [makeStaleTask({ providerTaskId: null })];
      const prisma = createPrismaMock([], tasks);
      const billing = createBillingMock();
      const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
      const app = await createApp({ prisma, billing, fetchFn, redis: makeRedis() });

      await tick(app);

      expect(tasks[0]!.status).toBe("failed");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(billing.refundResource).toHaveBeenCalledWith("video:vid-stale-0001");
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("心跳没超期的行不碰", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T07:00:30.000Z"));
    try {
      // updatedAt = 07:00:00，现在 07:00:30，推 60s 后也只有 90s，远没到 10 分钟阈值。
      const tasks = [makeStaleTask()];
      const prisma = createPrismaMock([], tasks);
      const billing = createBillingMock();
      const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
      const app = await createApp({ prisma, billing, fetchFn, redis: makeRedis() });

      await tick(app);

      expect(prisma.videoGenerationTask.findMany).toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(tasks[0]!.status).toBe("running");
      expect(billing.refundResource).not.toHaveBeenCalled();
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("onClose 清掉定时器，插件反复注册不攒 timer", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock([], [makeStaleTask()]);
      const redis = makeRedis();
      const fetchFn = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
      const app = await createApp({ prisma, billing: createBillingMock(), fetchFn, redis });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(redis.set).toHaveBeenCalledTimes(1);

      await app.close();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(redis.set).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
