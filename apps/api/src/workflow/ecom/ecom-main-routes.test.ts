import Fastify from "fastify";
import sharp from "sharp";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ecomMainImageRoutes } from "./ecom-main-routes.js";
import { ecomImageReservationTtlSeconds } from "./ecom-route-helpers.js";

type JobRow = {
  id: string;
  userId: string;
  platform: string;
  language: string;
  ratio: string;
  resolution: string;
  model?: string | null;
  style: string;
  customStyle: string;
  product: { name: string; category: string; sellingPoints: string[]; extra: string };
  referenceAssetIds: string[];
  count: number;
  images: Array<Record<string, unknown>>;
  stage: string;
  error: string | null;
  billingOperationIds: string[];
  createdAt: Date;
  updatedAt: Date;
};
type PriceRow = { resourceKey: string; displayName: string; pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO"; rate: number; perUnits: number; enabled: boolean };

const pngB64 = Buffer.from("png").toString("base64");
const dataUrl = `data:image/png;base64,${pngB64}`;
const baseRequest = {
  platformId: "tmall",
  ratio: "1:1",
  resolution: "1K",
  style: "amazon_clean",
  count: 2,
  product: { name: "咖啡机", category: "厨房", sellingPoints: ["紧凑"], extra: "" },
};

function createFakeRedis() {
  const locks = new Map<string, string>();
  return {
    async set(key: string, value: string, _m: "PX", _ttl: number, _o: "NX") {
      if (locks.has(key)) return null;
      locks.set(key, value);
      return "OK" as const;
    },
    async eval(_s: string, _n: number, key: string) {
      locks.delete(key);
      return 1;
    },
  };
}

function createPrismaMock(seed: JobRow[] = []) {
  const state = { jobs: [...seed], assets: [] as Array<{ id: string }> };
  let seq = 0;
  const tx = {
    imageAsset: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          id: `asset-${++seq}`,
          createdAt: new Date("2026-07-07T00:00:00Z"),
        };
        state.assets.push(row as { id: string });
        return row;
      }),
    },
    ecomMainImageJob: {
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; userId?: string; updatedAt: Date }; data: Record<string, unknown> }) => {
          const job = state.jobs.find((j) => j.id === where.id && j.updatedAt.getTime() === where.updatedAt.getTime());
          if (!job) return { count: 0 };
          Object.assign(job, data, { updatedAt: new Date(job.updatedAt.getTime() + 1) });
          return { count: 1 };
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId?: string } }) =>
        state.jobs.find((j) => (!where.id || j.id === where.id) && (!where.userId || j.userId === where.userId)) ?? null,
      ),
    },
  };
  const applyData = (job: JobRow, data: Record<string, unknown>) => {
    const { billingOperationIds, ...rest } = data as { billingOperationIds?: string[] | { push: string } };
    Object.assign(job, rest, { updatedAt: new Date(job.updatedAt.getTime() + 1) });
    if (Array.isArray(billingOperationIds)) job.billingOperationIds = [...billingOperationIds];
    else if (billingOperationIds) job.billingOperationIds = [...job.billingOperationIds, billingOperationIds.push];
  };
  const prisma = {
    imageAsset: { findMany: vi.fn(async () => []) },
    ecomMainImageJob: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const job = {
          ...data,
          id: `job-${++seq}`,
          createdAt: new Date("2026-07-07T00:00:00Z"),
          updatedAt: new Date("2026-07-07T00:00:00Z"),
        } as JobRow;
        state.jobs.push(job);
        return job;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId: string; orderBy?: unknown } }) =>
        state.jobs.find((j) => (!where.id || j.id === where.id) && j.userId === where.userId) ?? state.jobs.slice(-1)[0] ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        state.jobs.filter((j) => j.userId === where.userId).slice().reverse(),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = state.jobs.find((j) => j.id === where.id);
        if (job) applyData(job, data);
        return job;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; userId?: string; updatedAt?: Date }; data: Record<string, unknown> }) => {
        const matched = state.jobs.filter((j) =>
          (!where.id || j.id === where.id)
          && (!where.userId || j.userId === where.userId)
          && (!where.updatedAt || j.updatedAt.getTime() === where.updatedAt.getTime()));
        for (const job of matched) applyData(job, data);
        return { count: matched.length };
      }),
    },
    $transaction: async <T>(cb: (t: typeof tx) => Promise<T>) => cb(tx),
    __state: state,
  };
  return prisma;
}

function createBilling(overrides: Partial<{
  charge: () => Promise<{ charged: number }>;
  rows: readonly PriceRow[];
  settle: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
}> = {}) {
  return {
    // 主图走"请求档预留 → 交付档结算"，charge 只留给旧客户端兼容路径。
    chargeResource: vi.fn(overrides.charge ?? (async () => ({ charged: 10 }))),
    reserveResource: vi.fn(overrides.charge
      ? async () => { await overrides.charge!(); return { reserved: 10 }; }
      : async () => ({ reserved: 10 })),
    settleResource: vi.fn(overrides.settle ?? (async () => ({ settled: 10 }))),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({ data: [...(overrides.rows ?? [])] })),
  };
}

function priceRow(resourceKey: string, rate: number): PriceRow {
  return { resourceKey, displayName: resourceKey, pricingType: "PER_UNIT", rate, perUnits: 1, enabled: true };
}

async function createApp(opts: {
  prisma?: ReturnType<typeof createPrismaMock>;
  billing?: ReturnType<typeof createBilling>;
  userId?: string;
  callImageGeneration?: (args: {
    config: unknown;
    prompt: string;
    size: string;
    fetchFn: typeof fetch;
  }) => Promise<{ readonly kind: "b64"; readonly b64: string; readonly mime: string }>;
  loadImageGenerationConfig?: ReturnType<typeof vi.fn>;
  loadImageGenerationConfigForModel?: ReturnType<typeof vi.fn>;
  maxAttempts?: number;
} = {}) {
  const prisma = opts.prisma ?? createPrismaMock();
  const billing = opts.billing ?? createBilling();
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as { userId?: string }).userId = opts.userId ?? "u1";
  });
  const defaultCallImageGeneration = async (): Promise<{ readonly kind: "b64"; readonly b64: string; readonly mime: string }> => ({
    kind: "b64",
    b64: pngB64,
    mime: "image/png",
  });
  const defaultCallImageEdit = async (): Promise<{ readonly kind: "b64"; readonly b64: string; readonly mime: string }> => ({
    kind: "b64",
    b64: pngB64,
    mime: "image/png",
  });
  // 和真实 storeWorkflowImage 一致：量出实际交付像素，量不出来留 null。
  const defaultStoreWorkflowImage = async (storeArgs: {
    image: { kind: string; b64?: string };
  }): Promise<{ originalUrl: string; thumbnailUrl: string; objectKey: null; mime: string; width: number | null; height: number | null }> => {
    let width: number | null = null;
    let height: number | null = null;
    if (storeArgs.image.kind === "b64" && storeArgs.image.b64) {
      try {
        const meta = await sharp(Buffer.from(storeArgs.image.b64, "base64")).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch { /* 非法图片：留 null，按请求档结算 */ }
    }
    return { originalUrl: dataUrl, thumbnailUrl: dataUrl, objectKey: null, mime: "image/png", width, height };
  };
  await app.register(async (instance) =>
    ecomMainImageRoutes(instance, {
      prisma: prisma as never,
      billing: billing as never,
      redis: createFakeRedis() as never,
      callImageGeneration: opts.callImageGeneration ?? (defaultCallImageGeneration as never),
      callImageEdit: defaultCallImageEdit as never,
      retryUntilSuccess: async <T>(fn: () => Promise<T>) => fn(),
      storeWorkflowImage: defaultStoreWorkflowImage as never,
      loadImageGenerationConfig: (opts.loadImageGenerationConfig ?? (() => ({} as never))) as never,
      loadImageGenerationConfigForModel: opts.loadImageGenerationConfigForModel as never,
      retryDelayMs: 1,
      maxAttempts: opts.maxAttempts,
    }),
  );
  return { app, prisma, billing };
}

afterEach(() => vi.clearAllMocks());

describe("ecom main image routes", () => {
  it("成功出 N 张：扣费 N 次，stage=ready，images 全 ready", async () => {
    const { app, billing } = await createApp();
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    expect(res.statusCode).toBe(200);
    const job = res.json().data.job;
    expect(job.stage).toBe("ready");
    expect(job.images).toHaveLength(2);
    expect(job.images.every((i: { status: string }) => i.status === "ready")).toBe(true);
    expect(billing.reserveResource).toHaveBeenCalledTimes(2);
    // 预留必须带上有效期：单张图的最坏耗时远超 billing 那个 10 分钟兜底，漏了就在出图途中
    // 被按 actual=0 关账，之后 settle 静默返回 0（图照发、钱没收到）。
    expect(billing.reserveResource).toHaveBeenCalledWith(
      expect.objectContaining({ reservationTtlSeconds: ecomImageReservationTtlSeconds({ maxAttempts: 2, retryDelayMs: 1 }) }),
    );
  });

  it("某张出图失败：该张 status=failed，job=partial，仅对成功张扣费", async () => {
    let calls = 0;
    const failingApp = Fastify();
    failingApp.addHook("onRequest", async (req) => {
      (req as { userId?: string }).userId = "u1";
    });
    const prisma = createPrismaMock();
    const billing = createBilling();
    const failingCallImageGeneration = async (): Promise<{ readonly kind: "b64"; readonly b64: string; readonly mime: string }> => {
      calls += 1;
      if (calls === 2) throw new Error("upstream down");
      return { kind: "b64", b64: pngB64, mime: "image/png" };
    };
    const defaultCallImageEdit = async (): Promise<{ readonly kind: "b64"; readonly b64: string; readonly mime: string }> => ({
      kind: "b64",
      b64: pngB64,
      mime: "image/png",
    });
    const defaultStoreWorkflowImage = async (): Promise<{ originalUrl: string; thumbnailUrl: string; objectKey: null; mime: string }> => ({
      originalUrl: dataUrl,
      thumbnailUrl: dataUrl,
      objectKey: null,
      mime: "image/png",
    });
    await failingApp.register(async (instance) =>
      ecomMainImageRoutes(instance, {
        prisma: prisma as never,
        billing: billing as never,
        redis: createFakeRedis() as never,
        callImageGeneration: failingCallImageGeneration as never,
        callImageEdit: defaultCallImageEdit as never,
        retryUntilSuccess: async <T>(fn: () => Promise<T>) => fn(),
        storeWorkflowImage: defaultStoreWorkflowImage as never,
        loadImageGenerationConfig: () => ({} as never),
        retryDelayMs: 1,
        maxAttempts: 1,
      }),
    );
    const res = await failingApp.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    expect(res.statusCode).toBe(200);
    const job = res.json().data.job;
    expect(job.stage).toBe("partial");
    expect(job.images.filter((i: { status: string }) => i.status === "ready")).toHaveLength(1);
    expect(job.images.filter((i: { status: string }) => i.status === "failed")).toHaveLength(1);
    expect(billing.reserveResource).toHaveBeenCalledTimes(2);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k" }));
    expect(billing.refundResource).toHaveBeenCalledTimes(1);
  });

  it("余额不足 402", async () => {
    const billing = createBilling({ charge: async () => { throw new InsufficientBalanceError(); } });
    const { app, prisma } = await createApp({ billing });
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toContain("积分");
    expect(prisma.__state.jobs[0]?.stage).toBe("failed");
    expect(prisma.__state.jobs[0]?.images.every((image) => image.status === "failed")).toBe(true);
  });

  it("并发锁冲突 409", async () => {
    const prisma = createPrismaMock();
    const billing = createBilling();
    const busyRedis = { async set() { return null; }, async eval() { return 1; } };
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as { userId?: string }).userId = "u1";
    });
    const defaultCallImageGeneration = async (): Promise<{ readonly kind: "b64"; readonly b64: string; readonly mime: string }> => ({
      kind: "b64",
      b64: pngB64,
      mime: "image/png",
    });
    const defaultCallImageEdit = async (): Promise<{ readonly kind: "b64"; readonly b64: string; readonly mime: string }> => ({
      kind: "b64",
      b64: pngB64,
      mime: "image/png",
    });
    const defaultStoreWorkflowImage = async (): Promise<{ originalUrl: string; thumbnailUrl: string; objectKey: null; mime: string }> => ({
      originalUrl: dataUrl,
      thumbnailUrl: dataUrl,
      objectKey: null,
      mime: "image/png",
    });
    await app.register(async (instance) =>
      ecomMainImageRoutes(instance, {
        prisma: prisma as never,
        billing: billing as never,
        redis: busyRedis as never,
        callImageGeneration: defaultCallImageGeneration as never,
        callImageEdit: defaultCallImageEdit as never,
        retryUntilSuccess: async <T>(fn: () => Promise<T>) => fn(),
        storeWorkflowImage: defaultStoreWorkflowImage as never,
        loadImageGenerationConfig: () => ({} as never),
        retryDelayMs: 1,
      }),
    );
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    expect(res.statusCode).toBe(409);
  });

  it("入参非法 400（count 超上限）", async () => {
    const { app } = await createApp();
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, count: 99 } });
    expect(res.statusCode).toBe(400);
    const tooManyReferences = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, referenceAssetIds: ["1", "2", "3", "4"] } });
    expect(tooManyReferences.statusCode).toBe(400);
  });

  it("重绘不存在的 job 返回 404", async () => {
    const { app } = await createApp();
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main/nope/images/0/redraw" });
    expect(res.statusCode).toBe(404);
  });

  it("history 返回该用户最近任务列表", async () => {
    const { app } = await createApp();
    await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    const res = await app.inject({ method: "GET", url: "/api/workflow/ecom/main/history" });
    expect(res.statusCode).toBe(200);
    const jobs = res.json().data.jobs;
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0].id).toBeTruthy();
  });

  it("model 落库并在整组与重绘中锁定同一模型；缺省仍走环境默认", async () => {
    const loadImageGenerationConfig = vi.fn(() => ({ endpoint: "e", apiKey: "k", model: "env-default" }));
    const loadImageGenerationConfigForModel = vi.fn((model: string) => ({ endpoint: "e", apiKey: "k", model }));
    const { app, prisma } = await createApp({ loadImageGenerationConfig, loadImageGenerationConfigForModel });
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, model: "doubao-seedream-4-5-251128" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.job.model).toBe("doubao-seedream-4-5-251128");
    expect(prisma.__state.jobs[0]?.model).toBe("doubao-seedream-4-5-251128");
    const redraw = await app.inject({ method: "POST", url: "/api/workflow/ecom/main/job-1/images/0/redraw" });
    expect(redraw.statusCode).toBe(200);
    // 2 张 + 1 次重绘全部使用落库模型
    expect(loadImageGenerationConfigForModel.mock.calls.map(([model]) => model)).toEqual(["doubao-seedream-4-5-251128", "doubao-seedream-4-5-251128", "doubao-seedream-4-5-251128"]);
    expect(loadImageGenerationConfig).not.toHaveBeenCalled();

    const noModel = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    expect(noModel.statusCode).toBe(200);
    expect(noModel.json().data.job.model).toBeNull();
    expect(loadImageGenerationConfig).toHaveBeenCalled();
  });

  it("qwen 4K 与 gpt 不支持的尺寸组合返回带指引的 400", async () => {
    const { app, billing } = await createApp();
    const qwen4k = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, model: "qwen-image-2.0-pro-2026-04-22", resolution: "4K" } });
    expect(qwen4k.statusCode).toBe(400);
    expect(qwen4k.json().error).toBe("Qwen 模型最高支持 2K，请切换清晰度或模型");
    // 16:9 2K=1920x1080 高度非 16 的倍数，gpt 拒绝并提示该比例可选清晰度
    const gpt2k = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, model: "gpt-image-2", ratio: "16:9", resolution: "2K" } });
    expect(gpt2k.statusCode).toBe(400);
    expect(gpt2k.json().error).toContain("GPT Image 2 不支持尺寸 1920x1080");
    expect(gpt2k.json().error).toContain("该比例可选清晰度：1K");
    expect(billing.reserveResource).not.toHaveBeenCalled();
    // gpt 1:1 4K=2496x2496 满足约束，放行
    const gpt4k = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, model: "gpt-image-2", resolution: "4K" } });
    expect(gpt4k.statusCode).toBe(200);
  });

  it("operationId 确定性：先落库再扣费，重绘按前缀递增", async () => {
    const { app, billing, prisma } = await createApp();
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    expect(res.statusCode).toBe(200);
    expect((billing.reserveResource.mock.calls as unknown as [{ operationId: string }][]).map(([args]) => args.operationId)).toEqual(["ecom-main:job-1:0:a0", "ecom-main:job-1:1:a0"]);
    expect(prisma.__state.jobs[0]?.billingOperationIds).toEqual(["ecom-main:job-1:0:a0", "ecom-main:job-1:1:a0"]);
    const redraw = await app.inject({ method: "POST", url: "/api/workflow/ecom/main/job-1/images/1/redraw" });
    expect(redraw.statusCode).toBe(200);
    expect(billing.reserveResource).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "ecom-main:job-1:1:a1" }));
    expect(prisma.__state.jobs[0]?.billingOperationIds).toEqual(["ecom-main:job-1:0:a0", "ecom-main:job-1:1:a0", "ecom-main:job-1:1:a1"]);
  });

  it("管理台配置的电商主图专属计费 key 生效，pricing ?model= 与扣费一致", async () => {
    const billing = createBilling({ rows: [priceRow("ecom_main_image_generation_1k", 25), priceRow("image_generation_qwen_image_2_0_pro_2026_04_22_2k", 66)] });
    const { app } = await createApp({ billing });
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: baseRequest });
    expect(res.statusCode).toBe(200);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "ecom_main_image_generation_1k" }));

    const pricing = await app.inject({ method: "GET", url: "/api/workflow/ecom/main/pricing?model=qwen-image-2.0-pro-2026-04-22" });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json().data["1K"]).toMatchObject({ resourceKey: "ecom_main_image_generation_1k", rate: 25 });
    expect(pricing.json().data["2K"]).toMatchObject({ resourceKey: "image_generation_qwen_image_2_0_pro_2026_04_22_2k", rate: 66 });
    expect(pricing.json().data["4K"].resourceKey).toBe("image_generation_4k");
  });

  it("请求 2K 但上游只交付 1K 像素时按 1K 结算", async () => {
    const prisma = createPrismaMock();
    const billing = createBilling();
    // 中转只认宽高比：请求 1536x1536，实际回 1024x1024。
    const shrunk = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#406080" } }).png().toBuffer();
    const { app } = await createApp({
      prisma,
      billing,
      callImageGeneration: async () => ({ kind: "b64" as const, b64: shrunk.toString("base64"), mime: "image/png" }),
    });

    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, count: 1, resolution: "2K" } });

    expect(res.statusCode).toBe(200);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_2k", units: 1 }));
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "ecom-main:job-1:0:a0",
      resourceKey: "image_generation_1k",
      units: 1,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
  });

  it("上游足额交付 2K 时仍按 2K 结算", async () => {
    const prisma = createPrismaMock();
    const billing = createBilling();
    const full = await sharp({ create: { width: 1536, height: 1536, channels: 3, background: "#406080" } }).png().toBuffer();
    const { app } = await createApp({
      prisma,
      billing,
      callImageGeneration: async () => ({ kind: "b64" as const, b64: full.toString("base64"), mime: "image/png" }),
    });

    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, count: 1, resolution: "2K" } });

    expect(res.statusCode).toBe(200);
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "ecom-main:job-1:0:a0",
      resourceKey: "image_generation_2k",
      units: 1,
    });
  });

  it("结算接口报错时保留已交付的图，不退款白送", async () => {
    const prisma = createPrismaMock();
    const billing = createBilling({ settle: async () => { throw new Error("billing settle down"); } });
    const { app } = await createApp({ prisma, billing });

    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, count: 1 } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.job.images[0]).toMatchObject({ status: "ready" });
    expect(billing.refundResource).not.toHaveBeenCalled();
  });

  it("operationId 的 CAS 落库被并发写抢先时重新派生，不会重复扣同一个 id", async () => {
    const prisma = createPrismaMock();
    const billing = createBilling();
    const original = prisma.ecomMainImageJob.updateMany.getMockImplementation() as (args: unknown) => Promise<{ count: number }>;
    let appends = 0;
    prisma.ecomMainImageJob.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (!("billingOperationIds" in args.data)) return original(args);
      appends += 1;
      // 第一次 CAS 前模拟并发请求已把 a0 抢走
      if (appends === 1) {
        const job = prisma.__state.jobs[0]!;
        job.billingOperationIds = [...job.billingOperationIds, "ecom-main:job-1:0:a0"];
        job.updatedAt = new Date(job.updatedAt.getTime() + 500);
        return { count: 0 };
      }
      return original(args);
    });
    const { app } = await createApp({ prisma, billing });

    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, count: 1 } });

    expect(res.statusCode).toBe(200);
    expect(appends).toBe(2);
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ operationId: "ecom-main:job-1:0:a1" }));
    const persisted = prisma.__state.jobs[0]!.billingOperationIds;
    expect(persisted).toEqual(["ecom-main:job-1:0:a0", "ecom-main:job-1:0:a1"]);
    expect(new Set(persisted).size).toBe(persisted.length);
  });

  it("CAS 落库持续失败时返回 409 且不扣费", async () => {
    const prisma = createPrismaMock();
    const billing = createBilling();
    const original = prisma.ecomMainImageJob.updateMany.getMockImplementation() as (args: unknown) => Promise<{ count: number }>;
    let appends = 0;
    prisma.ecomMainImageJob.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (!("billingOperationIds" in args.data)) return original(args);
      appends += 1;
      return { count: 0 };
    });
    const { app } = await createApp({ prisma, billing });

    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, count: 1 } });

    expect(res.statusCode).toBe(409);
    expect(appends).toBe(5);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(prisma.__state.jobs[0]?.billingOperationIds).toEqual([]);
    expect(prisma.__state.jobs[0]?.stage).toBe("failed");
  });

  it("listResourcePrices 失败时告警并回落通用 key", async () => {
    const billing = createBilling();
    billing.listResourcePrices.mockRejectedValueOnce(new Error("billing pricing down"));
    const { app } = await createApp({ billing });
    const warn = vi.spyOn(app.log, "warn");

    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/main", payload: { ...baseRequest, count: 1 } });

    expect(res.statusCode).toBe(200);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k" }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: "billing pricing down" }), expect.stringContaining("listResourcePrices failed"));
  });
});
