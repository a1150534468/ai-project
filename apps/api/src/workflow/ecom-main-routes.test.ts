import Fastify from "fastify";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ecomMainImageRoutes } from "./ecom-main-routes.js";

type JobRow = {
  id: string;
  userId: string;
  platform: string;
  language: string;
  ratio: string;
  resolution: string;
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
        if (job) Object.assign(job, data, { updatedAt: new Date(job.updatedAt.getTime() + 1) });
        return job;
      }),
    },
    $transaction: async <T>(cb: (t: typeof tx) => Promise<T>) => cb(tx),
    __state: state,
  };
  return prisma;
}

function createBilling(overrides: Partial<{ charge: () => Promise<{ charged: number }> }> = {}) {
  return {
    chargeResource: vi.fn(overrides.charge ?? (async () => ({ charged: 10 }))),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({ data: [] })),
  };
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
      redis: createFakeRedis() as never,
      callImageGeneration: opts.callImageGeneration ?? (defaultCallImageGeneration as never),
      callImageEdit: defaultCallImageEdit as never,
      retryUntilSuccess: async <T>(fn: () => Promise<T>) => fn(),
      storeWorkflowImage: defaultStoreWorkflowImage as never,
      loadImageGenerationConfig: () => ({} as never),
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
    expect(billing.chargeResource).toHaveBeenCalledTimes(2);
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
    expect(billing.chargeResource).toHaveBeenCalledTimes(2);
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k" }));
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
});
