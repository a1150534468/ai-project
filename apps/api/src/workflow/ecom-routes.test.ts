import Fastify from "fastify";
import sharp from "sharp";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRedisWorkflowMutationLocker, type WorkflowMutationLocker } from "./ecom-route-mutation.js";
import { ecomWorkflowRoutes } from "./ecom-routes.js";

type AssetRow = { id: string; userId: string; requestId: string; requestIndex: number; prompt: string; model: string; size: string; originalUrl: string; thumbnailUrl: string; objectKey: string | null; mime: string; width?: number | null; height?: number | null; createdAt: Date };
type SegmentRow = { index: number; assetId: string; originalUrl: string; thumbnailUrl: string; prompt: string; createdAt: string };
type WorkflowRow = { id: string; userId: string; platform: string; language: string; template: string; resolution: string; model?: string | null; segmentCount: number; product: { name: string; category: string; sellingPoints: string[]; extra: string }; referenceAssetIds: string[]; masterAssetId: string | null; segments: SegmentRow[]; stitchedAssetId: string | null; stage: string; error: string | null; billingOperationIds: string[]; createdAt: Date; updatedAt: Date };
type BillingMock = { chargeResource: ReturnType<typeof vi.fn>; reserveResource: ReturnType<typeof vi.fn>; settleResource: ReturnType<typeof vi.fn>; refundResource: ReturnType<typeof vi.fn>; listResourcePrices?: ReturnType<typeof vi.fn> };
type Services = { callImageGeneration: ReturnType<typeof vi.fn>; callImageEdit: ReturnType<typeof vi.fn>; storeWorkflowImage: ReturnType<typeof vi.fn>; loadImageGenerationConfig: ReturnType<typeof vi.fn>; loadImageGenerationConfigForModel: ReturnType<typeof vi.fn> };
type PriceRow = { resourceKey: string; displayName: string; pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO"; rate: number; perUnits: number; enabled: boolean };
type PrismaMock = { imageAsset: { create: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }; ecomWorkflow: { create: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> }; $transaction: <T>(callback: (tx: PrismaMock) => Promise<T>) => Promise<T>; __state: { assets: AssetRow[]; workflows: WorkflowRow[] } };
type FakeRedis = {
  readonly set: (key: string, value: string, mode: "PX", ttlMs: number, option: "NX") => Promise<"OK" | null>;
  readonly eval: (script: string, numKeys: number, key: string, ...args: string[]) => Promise<unknown>;
  readonly forceSet: (key: string, value: string, ttlMs: number) => void;
  readonly peek: (key: string) => string | null;
};
type FakeRedisEvalHook = (args: { key: string; args: string[]; forceSet: FakeRedis["forceSet"] }) => void;

const billings: BillingMock[] = [];
const pngB64 = Buffer.from("png").toString("base64");
const dataUrl = `data:image/png;base64,${pngB64}`;
const masterRequest = { platformId: "taobao", templateId: "general", product: { name: "陶瓷餐盘", category: "餐厨", sellingPoints: ["耐高温"], extra: "" } };
const QWEN_MODEL = "qwen-image-2.0-pro-2026-04-22";
type MasterRequestPayload = typeof masterRequest & { referenceAssetIds?: string[]; resolution?: "1K" | "2K" | "4K"; model?: string; segmentCount?: number };
const buildAsset = (id: string, userId = "u1"): AssetRow => ({ id, userId, requestId: id, requestIndex: 0, prompt: id, model: "gpt-image-2", size: "1024x1024", originalUrl: dataUrl, thumbnailUrl: dataUrl, objectKey: null, mime: "image/png", createdAt: new Date("2026-07-01T00:00:00.000Z") });
const injectMaster = (app: Awaited<ReturnType<typeof createApp>>, payload: MasterRequestPayload = masterRequest) => app.inject({ method: "POST", url: "/api/workflow/ecom/master", payload });
const injectRead = (app: Awaited<ReturnType<typeof createApp>>, path: "/api/workflow/ecom/current" | "/api/workflow/ecom/history") => app.inject({ method: "GET", url: path });
const redisLockKey = (key: string) => `ai-assistant:lock:ecom-workflow:${key}`;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createFakeRedis(options?: { beforeEval?: FakeRedisEvalHook }): FakeRedis {
  const locks = new Map<string, { value: string; expiresAt: number }>();
  const prune = (key: string) => {
    const entry = locks.get(key);
    if (entry && entry.expiresAt <= Date.now()) locks.delete(key);
  };
  const forceSet = (key: string, value: string, ttlMs: number) => locks.set(key, { value, expiresAt: Date.now() + ttlMs });
  return {
    async set(key: string, value: string, mode: "PX", ttlMs: number, option: "NX") {
      if (mode !== "PX" || option !== "NX" || ttlMs <= 0) throw new Error("unexpected redis lock args");
      prune(key);
      if (locks.has(key)) return null;
      forceSet(key, value, ttlMs);
      return "OK";
    },
    async eval(_script: string, numKeys: number, key: string, ...args: string[]) {
      if (numKeys !== 1) throw new Error("unexpected redis eval key count");
      options?.beforeEval?.({ key, args, forceSet });
      prune(key);
      const entry = locks.get(key);
      if (!entry || entry.value !== args[0]) return 0;
      if (args[1]) {
        const ttlMs = Number(args[1]);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("unexpected redis renew ttl");
        forceSet(key, entry.value, ttlMs);
        return 1;
      }
      locks.delete(key);
      return 1;
    },
    forceSet,
    peek(key: string) {
      prune(key);
      return locks.get(key)?.value ?? null;
    },
  };
}

function createPrismaMock(seed?: { assets?: AssetRow[]; workflows?: WorkflowRow[] }) {
  const assets = [...(seed?.assets ?? [])];
  const workflows = [...(seed?.workflows ?? [])];
  const prisma = {} as PrismaMock;
  // 真库 updatedAt 单调递增，mock 也必须递增，否则 CAS 恒真、并发回归测不出来。
  let clock = Date.UTC(2026, 6, 1, 0, 1);
  const touch = () => new Date((clock += 1_000));
  const applyData = (row: WorkflowRow, data: Omit<Partial<WorkflowRow>, "billingOperationIds"> & { billingOperationIds?: string[] | { push: string } }) => {
    const { billingOperationIds, ...rest } = data;
    Object.assign(row, rest, { updatedAt: touch() });
    if (Array.isArray(billingOperationIds)) row.billingOperationIds = [...billingOperationIds];
    else if (billingOperationIds) row.billingOperationIds = [...row.billingOperationIds, billingOperationIds.push];
  };
  prisma.imageAsset = {
    create: vi.fn(async ({ data }: { data: Omit<AssetRow, "id" | "createdAt"> }) => {
      const row = { ...data, id: `asset-${assets.length + 1}`, createdAt: new Date("2026-07-01T00:00:00.000Z") };
      assets.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
      assets.find((row) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)) ?? null),
    findMany: vi.fn(async ({ where }: { where?: { userId?: string; id?: { in?: string[] } } }) =>
      assets.filter((row) => (!where?.userId || row.userId === where.userId) && (!where?.id?.in || where.id.in.includes(row.id)))),
  };
  prisma.ecomWorkflow = {
    create: vi.fn(async ({ data }: { data: Omit<WorkflowRow, "id" | "createdAt" | "updatedAt"> }) => {
      const row = { ...data, segmentCount: data.segmentCount ?? 3, id: `wf-${workflows.length + 1}`, createdAt: new Date("2026-07-01T00:00:00.000Z"), updatedAt: new Date("2026-07-01T00:00:00.000Z") };
      workflows.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
      workflows.find((row) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)) ?? null),
    findMany: vi.fn(async ({ where, orderBy, take }: { where?: { userId?: string }; orderBy?: { updatedAt?: "asc" | "desc"; createdAt?: "asc" | "desc" }; take?: number } = {}) =>
      workflows.filter((row) => !where?.userId || row.userId === where.userId).sort((left, right) => {
        const direction = orderBy?.updatedAt ?? orderBy?.createdAt ?? "desc";
        const delta = orderBy?.updatedAt ? left.updatedAt.getTime() - right.updatedAt.getTime() : left.createdAt.getTime() - right.createdAt.getTime();
        return direction === "asc" ? delta : -delta;
      }).slice(0, take ?? workflows.length)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<WorkflowRow> }) => {
      const row = workflows.find((item) => item.id === where.id);
      if (!row) throw new Error("workflow not found");
      applyData(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id?: string; userId?: string; updatedAt?: Date }; data: Partial<WorkflowRow> & { billingOperationIds?: string[] | { push: string } } }) => {
      const matched = workflows.filter((row) =>
        (!where.id || row.id === where.id)
        && (!where.userId || row.userId === where.userId)
        && (!where.updatedAt || row.updatedAt.getTime() === where.updatedAt.getTime()));
      for (const row of matched) applyData(row, data);
      return { count: matched.length };
    }),
  };
  prisma.$transaction = async <T>(callback: (tx: PrismaMock) => Promise<T>) => {
    const assetSnapshot = assets.slice();
    const workflowSnapshot = workflows.map((workflow) => ({ ...workflow, referenceAssetIds: [...workflow.referenceAssetIds], segments: [...workflow.segments], billingOperationIds: [...workflow.billingOperationIds] }));
    try {
      return await callback(prisma);
    } catch (error) {
      assets.splice(0, assets.length, ...assetSnapshot);
      workflows.splice(0, workflows.length, ...workflowSnapshot);
      throw error;
    }
  };
  prisma.__state = { assets, workflows };
  return prisma;
}

/** 只拦截 operationId 的 CAS push（带 billingOperationIds 的 updateMany），其余 updateMany 照常。 */
function interceptAppend(prisma: PrismaMock, handler: (attempt: number, original: () => Promise<{ count: number }>) => Promise<{ count: number }>) {
  const original = prisma.ecomWorkflow.updateMany.getMockImplementation() as (args: unknown) => Promise<{ count: number }>;
  let attempts = 0;
  prisma.ecomWorkflow.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    if (!("billingOperationIds" in args.data)) return original(args);
    attempts += 1;
    return handler(attempts, () => original(args));
  });
  return { attempts: () => attempts };
}

/** 只拦截「提交产物」那次 updateMany（不带 billingOperationIds），让 operationId 的 CAS 落库照常成功。 */
function interceptCommitOnce(prisma: PrismaMock, handler: () => Promise<{ count: number }>) {
  const original = prisma.ecomWorkflow.updateMany.getMockImplementation() as (args: unknown) => Promise<{ count: number }>;
  let fired = false;
  prisma.ecomWorkflow.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    if (!fired && !("billingOperationIds" in args.data)) {
      fired = true;
      return handler();
    }
    return original(args);
  });
}

function createBillingMock(priceRows?: readonly PriceRow[]): BillingMock {
  // 生产用的计费客户端有 reserve/settle，走"请求档预留 → 交付档结算"；chargeResource 只留给旧客户端兼容路径。
  const billing: BillingMock = {
    chargeResource: vi.fn(async () => ({ charged: 1 })),
    reserveResource: vi.fn(async () => ({ reserved: 1 })),
    settleResource: vi.fn(async () => ({ settled: 1 })),
    refundResource: vi.fn(async () => ({ success: true })),
  };
  if (priceRows) billing.listResourcePrices = vi.fn(async () => ({ data: [...priceRows] }));
  billings.push(billing);
  return billing;
}

function priceRow(resourceKey: string, rate: number): PriceRow {
  return { resourceKey, displayName: resourceKey, pricingType: "PER_UNIT", rate, perUnits: 1, enabled: true };
}

// 和真实 storeWorkflowImage 一致：量出实际交付像素，量不出来留 null（按请求档结算）。
async function measuringStoreWorkflowImage(storeArgs: { image: { kind: string; b64?: string } }) {
  let width: number | null = null, height: number | null = null;
  if (storeArgs.image.kind === "b64" && storeArgs.image.b64) {
    try {
      const meta = await sharp(Buffer.from(storeArgs.image.b64, "base64")).metadata();
      width = meta.width ?? null; height = meta.height ?? null;
    } catch { /* 非法图片：留 null */ }
  }
  return { originalUrl: dataUrl, thumbnailUrl: dataUrl, objectKey: "ecom/test.png", mime: "image/png", width, height };
}

function createServices(overrides?: Partial<Services>): Services { return { callImageGeneration: vi.fn(async () => ({ kind: "b64", b64: pngB64, mime: "image/png" })), callImageEdit: vi.fn(async () => ({ kind: "b64", b64: pngB64, mime: "image/png" })), storeWorkflowImage: vi.fn(measuringStoreWorkflowImage), loadImageGenerationConfig: vi.fn(() => ({ endpoint: "https://image.test/v1/images/generations", apiKey: "key", model: "gpt-image-2" })), loadImageGenerationConfigForModel: vi.fn((model: string) => ({ endpoint: "https://image.test/v1/images/generations", apiKey: "key", model })), ...overrides }; }

function seedWorkflow(overrides?: Partial<WorkflowRow>): WorkflowRow {
  return {
    id: "wf-seeded",
    userId: "u1",
    platform: "taobao",
    language: "zh-CN",
    template: "general",
    resolution: "1K",
    segmentCount: 3,
    product: { name: "陶瓷餐盘", category: "餐厨", sellingPoints: ["耐高温"], extra: "" },
    referenceAssetIds: [],
    masterAssetId: "asset-master",
    segments: [],
    stitchedAssetId: null,
    stage: "master_ready",
    error: null,
    billingOperationIds: [],
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function createApp(options?: { prisma?: ReturnType<typeof createPrismaMock>; billing?: BillingMock; services?: Partial<Services>; userId?: string; maxAttempts?: number; workflowMutationLocker?: WorkflowMutationLocker }) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => { (req as unknown as { userId: string }).userId = options?.userId ?? "u1"; });
  await app.register(ecomWorkflowRoutes, {
    prisma: (options?.prisma ?? createPrismaMock()) as unknown as PrismaClient,
    billing: options?.billing ?? createBillingMock(),
    workflowMutationLocker: options?.workflowMutationLocker ?? createRedisWorkflowMutationLocker(createFakeRedis()),
    retryDelayMs: 0,
    maxAttempts: options?.maxAttempts ?? 2,
    ...createServices(options?.services),
  });
  await app.ready();
  return app;
}

describe("ecom workflow routes", () => {
  beforeEach(() => { vi.clearAllMocks(); billings.length = 0; });
  afterEach(() => { for (const billing of billings) expect(billing.reserveResource.mock.calls.some(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation")).toBe(false); });

  it("covers options and reference upload", async () => {
    const prisma = createPrismaMock(); const app = await createApp({ prisma });
    const options = await app.inject({ method: "GET", url: "/api/workflow/ecom/options" });
    expect(options.statusCode).toBe(200); expect(options.json().data.platforms.length).toBeGreaterThan(0); expect(options.json().data.templates.length).toBeGreaterThan(0);
    const reference = await app.inject({ method: "POST", url: "/api/workflow/ecom/references", payload: { image: { b64: pngB64, mime: "image/png" } } });
    expect(reference.statusCode).toBe(200);
    expect(prisma.__state.assets.at(-1)?.userId).toBe("u1");
    expect(reference.json().data.asset.originalUrl).toContain("data:image/png;base64,");
    const tooManyReferences = await app.inject({ method: "POST", url: "/api/workflow/ecom/master", payload: { ...masterRequest, referenceAssetIds: ["1", "2", "3", "4"] } });
    expect(tooManyReferences.statusCode).toBe(400);
    await app.close();
  });

  it("reads current/history with auth, null/empty state, latest ordering, take 20, and user isolation", async () => {
    const unauthorizedApp = await createApp({ userId: "" });
    for (const path of ["/api/workflow/ecom/current", "/api/workflow/ecom/history"] as const) expect((await injectRead(unauthorizedApp, path)).statusCode).toBe(401);
    await unauthorizedApp.close();
    const emptyApp = await createApp({ prisma: createPrismaMock() }), emptyCurrent = await injectRead(emptyApp, "/api/workflow/ecom/current"), emptyHistory = await injectRead(emptyApp, "/api/workflow/ecom/history");
    expect(emptyCurrent.json()).toEqual({ success: true, data: { workflow: null } }); expect(emptyHistory.json()).toEqual({ success: true, data: { workflows: [] } });
    await emptyApp.close();
    const workflows = [...Array.from({ length: 22 }, (_, index) => seedWorkflow({
      id: `wf-${index}`,
      stage: "draft",
      masterAssetId: null,
      stitchedAssetId: index === 0 ? "asset-stitched-current" : null,
      updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 22 - index)),
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, 22 - index)),
    })), seedWorkflow({ id: "wf-master-preview", stitchedAssetId: "asset-stitched-history", updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 23)), createdAt: new Date(Date.UTC(2026, 6, 1, 0, 23)) }), seedWorkflow({ id: "wf-foreign", userId: "u2", stitchedAssetId: "asset-foreign", updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 30)), createdAt: new Date(Date.UTC(2026, 6, 1, 0, 30)) })];
    const app = await createApp({ prisma: createPrismaMock({ assets: [buildAsset("asset-master"), buildAsset("asset-stitched-current"), buildAsset("asset-stitched-history"), buildAsset("asset-foreign", "u2")], workflows }) }), current = await injectRead(app, "/api/workflow/ecom/current"), history = await injectRead(app, "/api/workflow/ecom/history");
    expect(current.statusCode).toBe(200); expect(current.json().data.workflow.id).toBe("wf-0");
    expect(current.json().data.workflow.masterAsset).toBeNull();
    expect(current.json().data.workflow.stitchedAsset?.originalUrl).toBe(dataUrl);
    expect(history.statusCode).toBe(200); expect(history.json().data.workflows.map((workflow: { id: string }) => workflow.id)).toEqual(["wf-master-preview", ...Array.from({ length: 19 }, (_, index) => `wf-${index}`)]);
    expect(history.json().data.workflows.find((workflow: { id: string }) => workflow.id === "wf-master-preview")?.masterAsset?.originalUrl).toBe(dataUrl);
    expect(history.json().data.workflows.find((workflow: { id: string }) => workflow.id === "wf-master-preview")?.stitchedAsset?.originalUrl).toBe(dataUrl);
    await app.close();
  });

  it("charges master success once, skips billing on exhausted failure, and stays single-charge after transient retry", async () => {
    const successBilling = createBillingMock(), successApp = await createApp({ billing: successBilling }), success = await injectMaster(successApp);
    const chargedMasterOperationId = successBilling.reserveResource.mock.calls[0]?.[0]?.operationId as string;
    expect(success.statusCode).toBe(200); expect(successBilling.reserveResource).toHaveBeenCalledTimes(1);
    expect(successBilling.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k" }));
    expect(success.json().data.workflow.billingOperationIds).toEqual([chargedMasterOperationId]);
    expect(success.json().data.workflow.masterAsset?.originalUrl).toBe(dataUrl);
    await successApp.close();

    const failedBilling = createBillingMock(), failedApp = await createApp({ billing: failedBilling, services: { callImageGeneration: vi.fn(async () => { throw new Error("upstream failed"); }) } }), failed = await injectMaster(failedApp);
    expect(failed.statusCode).toBe(502); expect(failedBilling.reserveResource).toHaveBeenCalledTimes(1); expect(failedBilling.refundResource).toHaveBeenCalledTimes(1);
    await failedApp.close();

    let attempts = 0;
    const retryBilling = createBillingMock(), retryApp = await createApp({ billing: retryBilling, services: { callImageGeneration: vi.fn(async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); return { kind: "b64", b64: pngB64, mime: "image/png" }; }) } }), retry = await injectMaster(retryApp);
    expect(retry.statusCode).toBe(200); expect(attempts).toBe(2); expect(retryBilling.reserveResource).toHaveBeenCalledTimes(1);
    expect(retryBilling.reserveResource).toHaveBeenLastCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k" }));
    await retryApp.close();
    const referenceAsset = buildAsset("asset-ref-1"), refBilling = createBillingMock(), refServices = createServices();
    const refApp = await createApp({ prisma: createPrismaMock({ assets: [referenceAsset] }), billing: refBilling, services: refServices }), refResponse = await injectMaster(refApp, { ...masterRequest, referenceAssetIds: [referenceAsset.id] });
    expect(refResponse.statusCode).toBe(200); expect(refServices.callImageGeneration).not.toHaveBeenCalled();
    expect(refServices.callImageEdit).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: [expect.objectContaining({ b64: pngB64, mime: "image/png" })] }));
    expect(refBilling.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k" }));
    await refApp.close();
  });

  it("uses selected resolution for ecom image size and resource pricing", async () => {
    const masterBilling = createBillingMock();
    const masterServices = createServices();
    const masterApp = await createApp({ billing: masterBilling, services: masterServices });

    const master = await injectMaster(masterApp, { ...masterRequest, resolution: "4K" });

    expect(master.statusCode).toBe(200);
    expect(master.json().data.workflow.resolution).toBe("4K");
    expect(masterServices.callImageGeneration).toHaveBeenCalledWith(expect.objectContaining({ size: "2480x3312" }));
    expect(masterBilling.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_4k" }));
    await masterApp.close();

    const segmentBilling = createBillingMock();
    const segmentServices = createServices();
    const segmentApp = await createApp({
      prisma: createPrismaMock({ assets: [buildAsset("asset-master")], workflows: [seedWorkflow({ resolution: "4K" })] }),
      billing: segmentBilling,
      services: segmentServices,
    });
    const segment = await segmentApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/confirm" });

    expect(segment.statusCode).toBe(200);
    expect(segmentServices.callImageEdit).toHaveBeenCalledWith(expect.objectContaining({ size: "2480x3312" }));
    expect(segmentBilling.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation_4k")).toHaveLength(3);
    await segmentApp.close();
  });

  it("settles the master at the delivered tier when upstream ignores the requested pixels", async () => {
    // 中转只认宽高比：请求 4K(2480x3312)，实际只回 1K(768x1024)。
    const shrunk = await sharp({ create: { width: 768, height: 1024, channels: 3, background: "#406080" } }).png().toBuffer();
    const billing = createBillingMock();
    const services = createServices({
      callImageGeneration: vi.fn(async () => ({ kind: "b64", b64: shrunk.toString("base64"), mime: "image/png" })),
    });
    const app = await createApp({ billing, services });

    const response = await injectMaster(app, { ...masterRequest, resolution: "4K" });

    expect(response.statusCode).toBe(200);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_4k", units: 1 }));
    expect(billing.settleResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k", units: 1 }));
    expect(billing.refundResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("settles the master at the requested tier when upstream honours the pixels", async () => {
    const full = await sharp({ create: { width: 2480, height: 3312, channels: 3, background: "#406080" } }).png().toBuffer();
    const billing = createBillingMock();
    const services = createServices({
      callImageGeneration: vi.fn(async () => ({ kind: "b64", b64: full.toString("base64"), mime: "image/png" })),
    });
    const app = await createApp({ billing, services });

    const response = await injectMaster(app, { ...masterRequest, resolution: "4K" });

    expect(response.statusCode).toBe(200);
    expect(billing.settleResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_4k", units: 1 }));
    await app.close();
  });

  it("keeps a delivered master when settling fails instead of refunding it away", async () => {
    const billing = createBillingMock();
    billing.settleResource.mockRejectedValueOnce(new Error("billing settle down"));
    const app = await createApp({ billing });

    const response = await injectMaster(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.workflow.stage).toBe("master_ready");
    expect(billing.refundResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("falls back to chargeResource for billing clients without reserve/settle", async () => {
    const billing = createBillingMock();
    const legacy = { ...billing, reserveResource: undefined, settleResource: undefined } as unknown as ReturnType<typeof createBillingMock>;
    const app = await createApp({ billing: legacy });

    const response = await injectMaster(app);

    expect(response.statusCode).toBe(200);
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k", units: 1 }));
    await app.close();
  });

  it("preserves billing boundaries across persistence, store, charge, and refund failures", async () => {
    for (const setup of [
      (prisma: PrismaMock) => prisma.imageAsset.create.mockRejectedValueOnce(new Error("asset create failed")),
      (prisma: PrismaMock) => interceptCommitOnce(prisma, async () => { throw new Error("workflow update failed"); }),
    ] as const) {
      const prisma = createPrismaMock(), billing = createBillingMock();
      setup(prisma);
      const app = await createApp({ prisma, billing }), response = await injectMaster(app);
      const chargedOperationId = billing.reserveResource.mock.calls[0]?.[0]?.operationId as string;
      expect(response.statusCode).toBe(502); expect(billing.refundResource).toHaveBeenCalledWith(chargedOperationId);
      // operationId 先落库再扣费：失败后 id 仍保留，重试时序号递增
      expect(prisma.__state.workflows[0]?.masterAssetId).toBeNull(); expect(prisma.__state.workflows[0]?.billingOperationIds).toEqual([chargedOperationId]);
      await app.close();
    }
    const storeFailBilling = createBillingMock(), storeFailPrisma = createPrismaMock();
    const storeFailApp = await createApp({ prisma: storeFailPrisma, billing: storeFailBilling, services: { storeWorkflowImage: vi.fn(async () => { throw new Error("store failed"); }) } });
    const storeFail = await injectMaster(storeFailApp);
    expect(storeFail.statusCode).toBe(502); expect(storeFailBilling.reserveResource).toHaveBeenCalledTimes(1); expect(storeFailBilling.refundResource).toHaveBeenCalledTimes(1);
    await storeFailApp.close();
    const chargeFailBilling = createBillingMock(), chargeFailPrisma = createPrismaMock();
    chargeFailBilling.reserveResource.mockRejectedValueOnce(new Error("billing down"));
    const chargeFailApp = await createApp({ prisma: chargeFailPrisma, billing: chargeFailBilling }), chargeFail = await injectMaster(chargeFailApp);
    expect(chargeFail.statusCode).toBe(502); expect(chargeFailBilling.refundResource).not.toHaveBeenCalled();
    expect(chargeFailPrisma.__state.assets).toHaveLength(0); expect(chargeFailPrisma.__state.workflows[0]?.masterAssetId).toBeNull(); expect(chargeFailPrisma.__state.workflows[0]?.billingOperationIds).toEqual(["ecom-master:wf-1:a0"]);
    await chargeFailApp.close();
    const refundFailPrisma = createPrismaMock(), refundFailBilling = createBillingMock();
    interceptCommitOnce(refundFailPrisma, async () => { throw new Error("workflow update failed"); });
    refundFailBilling.refundResource.mockRejectedValueOnce(new Error("refund failed"));
    const refundFailApp = await createApp({ prisma: refundFailPrisma, billing: refundFailBilling }), refundFail = await injectMaster(refundFailApp), operationId = refundFailBilling.reserveResource.mock.calls[0]?.[0]?.operationId as string;
    expect(refundFail.statusCode).toBe(502); expect(refundFail.json().error).toContain("退款");
    expect(refundFailPrisma.__state.workflows[0]?.masterAssetId).toBeNull(); expect(refundFailPrisma.__state.workflows[0]?.error).toContain(operationId);
    await refundFailApp.close();
  });

  it("runs segment confirm sequentially, retries segment two without double-charging, and stops segment three after exhausted failure", async () => {
    const assets = [buildAsset("asset-master")], masterPayload = seedWorkflow();
    const successBilling = createBillingMock(); const successServices = createServices();
    const successApp = await createApp({ prisma: createPrismaMock({ assets, workflows: [masterPayload] }), billing: successBilling, services: successServices });
    const success = await successApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/confirm" });
    expect(success.statusCode).toBe(200);
    expect(successBilling.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation_1k")).toHaveLength(3);
    expect(successServices.callImageEdit.mock.calls.map(([args]) => (args as { referenceImages: { b64: string }[] }).referenceImages.length)).toEqual([1, 2, 2]);
    const segmentPrompts = successServices.callImageEdit.mock.calls.map(([args]) => (args as { prompt: string }).prompt);
    expect(new Set(segmentPrompts).size).toBe(3);
    expect(segmentPrompts[0]).toContain("分段名称：第 1 段（共 3 段）「首屏」");
    expect(segmentPrompts[1]).toContain("分段名称：第 2 段（共 3 段）「中段」");
    expect(segmentPrompts[2]).toContain("分段名称：第 3 段（共 3 段）「尾段」");
    expect(segmentPrompts[1]).toContain("不要重复第 1 段的大标题");
    expect(segmentPrompts[1]).toContain("多中段区别：本段为中段之一");
    expect(segmentPrompts[2]).toContain("不要重复前两段的主视觉大图");
    await successApp.close();

    let callCount = 0;
    const retryBilling = createBillingMock(), retryApp = await createApp({ prisma: createPrismaMock({ assets, workflows: [seedWorkflow()] }), billing: retryBilling, services: { callImageEdit: vi.fn(async () => { callCount += 1; if (callCount === 2) throw new Error("temporary"); return { kind: "b64", b64: pngB64, mime: "image/png" }; }) } });
    const retry = await retryApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/confirm" });
    expect(retry.statusCode).toBe(200);
    expect(retryBilling.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation_1k")).toHaveLength(3);
    await retryApp.close();

    const failedBilling = createBillingMock(), failedEdit = vi.fn().mockResolvedValueOnce({ kind: "b64", b64: pngB64, mime: "image/png" }).mockRejectedValue(new Error("segment two failed"));
    const failedApp = await createApp({ prisma: createPrismaMock({ assets, workflows: [seedWorkflow()] }), billing: failedBilling, services: { callImageEdit: failedEdit } });
    const failed = await failedApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/confirm" });
    expect(failed.statusCode).toBe(502);
    expect(failedBilling.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation_1k")).toHaveLength(2);
    expect(failedBilling.refundResource).toHaveBeenCalledTimes(1);
    expect(failedEdit.mock.calls).toHaveLength(3);
    await failedApp.close();
    const insufficientBilling = createBillingMock(); insufficientBilling.reserveResource.mockRejectedValueOnce(new InsufficientBalanceError());
    const insufficientApp = await createApp({ prisma: createPrismaMock({ assets: [buildAsset("asset-master")], workflows: [seedWorkflow()] }), billing: insufficientBilling }), insufficient = await insufficientApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/confirm" });
    expect(insufficient.statusCode).toBe(402); expect(insufficient.json().error).toContain("积分不足");
    await insufficientApp.close();
  });

  it("charges segment redraw once with deterministic operation id, stitch stays free, and returns 404 for cross-user workflow lookup", async () => {
    const assets = [buildAsset("asset-master"), buildAsset("asset-seg-0"), buildAsset("asset-seg-1"), buildAsset("asset-seg-2")];
    const workflow = seedWorkflow({ stage: "segments_ready", segments: [{ index: 0, assetId: "asset-seg-0", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg0", createdAt: "2026-07-01T00:00:00.000Z" }, { index: 1, assetId: "asset-seg-1", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg1", createdAt: "2026-07-01T00:00:00.000Z" }, { index: 2, assetId: "asset-seg-2", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg2", createdAt: "2026-07-01T00:00:00.000Z" }] });
    const billing = createBillingMock(), services = createServices(), app = await createApp({ prisma: createPrismaMock({ assets, workflows: [workflow] }), billing, services });
    const redraw = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/1/redraw" });
    expect(redraw.statusCode).toBe(200);
    expect(billing.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation_1k")).toHaveLength(1);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ operationId: "ecom-segment:wf-seeded:1:a0" }));
    expect(redraw.json().data.workflow.billingOperationIds).toContain("ecom-segment:wf-seeded:1:a0");
    const redrawAgain = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/1/redraw" });
    expect(redrawAgain.statusCode).toBe(200);
    expect(billing.reserveResource).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "ecom-segment:wf-seeded:1:a1" }));
    const stitch = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/stitch", payload: { image: { b64: pngB64, mime: "image/png" } } });
    expect(stitch.statusCode).toBe(200);
    // 拼接免费：不再产生 ecom_stitch 扣费，也不占用 billingOperationIds
    expect(billing.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "ecom_stitch")).toHaveLength(0);
    expect(services.callImageGeneration).not.toHaveBeenCalled();
    expect(stitch.json().data.workflow.billingOperationIds).toEqual(["ecom-segment:wf-seeded:1:a0", "ecom-segment:wf-seeded:1:a1"]);
    expect(stitch.json().data.workflow.stitchedAsset?.originalUrl).toBe(dataUrl);
    const invalidMime = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/stitch", payload: { image: { b64: pngB64, mime: "text/html" } } });
    expect(invalidMime.statusCode).toBe(400);
    expect(services.storeWorkflowImage).toHaveBeenCalledTimes(3);
    expect(billing.reserveResource).toHaveBeenCalledTimes(2);
    await app.close();

    const notFoundApp = await createApp({ prisma: createPrismaMock({ assets, workflows: [workflow] }), userId: "u2" }), notFound = await notFoundApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/1/redraw" });
    expect(notFound.statusCode).toBe(404);
    await notFoundApp.close();
  });

  it("streams a segment image via same-origin proxy with auth, ownership, and missing-segment guards", async () => {
    const assets = [buildAsset("asset-master"), buildAsset("asset-seg-0"), buildAsset("asset-seg-1")];
    const workflow = seedWorkflow({ stage: "segments_ready", segments: [{ index: 0, assetId: "asset-seg-0", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg0", createdAt: "2026-07-01T00:00:00.000Z" }, { index: 1, assetId: "asset-seg-1", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg1", createdAt: "2026-07-01T00:00:00.000Z" }] });

    const app = await createApp({ prisma: createPrismaMock({ assets, workflows: [workflow] }) });
    const ok = await app.inject({ method: "GET", url: "/api/workflow/ecom/wf-seeded/segments/0/blob" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");
    expect(ok.rawPayload.equals(Buffer.from(pngB64, "base64"))).toBe(true);
    const missing = await app.inject({ method: "GET", url: "/api/workflow/ecom/wf-seeded/segments/2/blob" });
    expect(missing.statusCode).toBe(404);
    await app.close();

    const unauthApp = await createApp({ prisma: createPrismaMock({ assets, workflows: [workflow] }), userId: "" });
    expect((await unauthApp.inject({ method: "GET", url: "/api/workflow/ecom/wf-seeded/segments/0/blob" })).statusCode).toBe(401);
    await unauthApp.close();

    const foreignApp = await createApp({ prisma: createPrismaMock({ assets, workflows: [workflow] }), userId: "u2" });
    expect((await foreignApp.inject({ method: "GET", url: "/api/workflow/ecom/wf-seeded/segments/0/blob" })).statusCode).toBe(404);
    await foreignApp.close();
  });

  it("rejects concurrent redraw and stitch mutations with 409 without double edit, store, or charge", async () => {
    const redrawImage = createDeferred<{ kind: "b64"; b64: string; mime: "image/png" }>();
    const stitchStore = createDeferred<{ originalUrl: string; thumbnailUrl: string; objectKey: string; mime: string }>();
    const redrawServices = createServices({ callImageEdit: vi.fn(async () => redrawImage.promise) });
    const redrawBilling = createBillingMock();
    const redrawWorkflow = seedWorkflow({ segments: [{ index: 0, assetId: "asset-seg-0", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg0", createdAt: "2026-07-01T00:00:00.000Z" }, { index: 1, assetId: "asset-seg-1", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg1", createdAt: "2026-07-01T00:00:00.000Z" }] });
    const redrawRedis = createFakeRedis();
    const redrawPrisma = createPrismaMock({ assets: [buildAsset("asset-master"), buildAsset("asset-seg-0"), buildAsset("asset-seg-1")], workflows: [redrawWorkflow] });
    const redrawAppA = await createApp({ prisma: redrawPrisma, billing: redrawBilling, services: redrawServices, workflowMutationLocker: createRedisWorkflowMutationLocker(redrawRedis) });
    const redrawAppB = await createApp({ prisma: redrawPrisma, billing: redrawBilling, services: redrawServices, workflowMutationLocker: createRedisWorkflowMutationLocker(redrawRedis) });
    const redrawFirst = redrawAppA.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/1/redraw" });
    await vi.waitFor(() => expect(redrawServices.callImageEdit).toHaveBeenCalledTimes(1));
    const redrawSecond = await redrawAppB.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/1/redraw" });
    expect(redrawSecond.statusCode).toBe(409);
    expect(redrawSecond.json().error).toContain("工作流正在处理");
    redrawImage.resolve({ kind: "b64", b64: pngB64, mime: "image/png" });
    const redrawDone = await redrawFirst;
    expect(redrawDone.statusCode).toBe(200);
    expect(redrawServices.callImageEdit).toHaveBeenCalledTimes(1);
    expect(redrawServices.storeWorkflowImage).toHaveBeenCalledTimes(1);
    expect(redrawBilling.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation_1k")).toHaveLength(1);
    await redrawAppA.close();
    await redrawAppB.close();

    const stitchServices = createServices({ storeWorkflowImage: vi.fn(async () => stitchStore.promise) });
    const stitchBilling = createBillingMock();
    const stitchWorkflow = seedWorkflow({ stage: "segments_ready", segments: [{ index: 0, assetId: "asset-seg-0", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg0", createdAt: "2026-07-01T00:00:00.000Z" }, { index: 1, assetId: "asset-seg-1", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg1", createdAt: "2026-07-01T00:00:00.000Z" }, { index: 2, assetId: "asset-seg-2", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg2", createdAt: "2026-07-01T00:00:00.000Z" }] });
    const stitchRedis = createFakeRedis();
    const stitchPrisma = createPrismaMock({ assets: [buildAsset("asset-master"), buildAsset("asset-seg-0"), buildAsset("asset-seg-1")], workflows: [stitchWorkflow] });
    const stitchAppA = await createApp({ prisma: stitchPrisma, billing: stitchBilling, services: stitchServices, workflowMutationLocker: createRedisWorkflowMutationLocker(stitchRedis) });
    const stitchAppB = await createApp({ prisma: stitchPrisma, billing: stitchBilling, services: stitchServices, workflowMutationLocker: createRedisWorkflowMutationLocker(stitchRedis) });
    const stitchFirst = stitchAppA.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/stitch", payload: { image: { b64: pngB64, mime: "image/png" } } });
    await vi.waitFor(() => expect(stitchServices.storeWorkflowImage).toHaveBeenCalledTimes(1));
    const stitchSecond = await stitchAppB.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/stitch", payload: { image: { b64: pngB64, mime: "image/png" } } });
    expect(stitchSecond.statusCode).toBe(409);
    expect(stitchSecond.json().error).toContain("工作流正在处理");
    stitchStore.resolve({ originalUrl: dataUrl, thumbnailUrl: dataUrl, objectKey: "ecom/test.png", mime: "image/png" });
    const stitchDone = await stitchFirst;
    expect(stitchDone.statusCode).toBe(200);
    expect(stitchServices.storeWorkflowImage).toHaveBeenCalledTimes(1);
    expect(stitchBilling.reserveResource).not.toHaveBeenCalled();
    await stitchAppA.close();
    await stitchAppB.close();
  });

  it("refunds and returns 409 when the final workflow update hits an optimistic concurrency conflict", async () => {
    const prisma = createPrismaMock();
    interceptCommitOnce(prisma, async () => ({ count: 0 }));
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });

    const response = await injectMaster(app);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("工作流正在处理");
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    expect(billing.refundResource).toHaveBeenCalledTimes(1);
    expect(prisma.__state.workflows[0]?.stage).toBe("master_running");
    expect(prisma.__state.workflows[0]?.error).toBeNull();
    await app.close();
  });

  it("does not delete a newer Redis lock when an expired holder releases", async () => {
    let releaseHooked = false;
    const key = redisLockKey("release-race");
    const redis = createFakeRedis({
      beforeEval: ({ key: evalKey, args, forceSet }) => {
        if (!releaseHooked && evalKey === key && args.length === 1) {
          releaseHooked = true;
          forceSet(evalKey, "new-holder-token", 10_000);
        }
      },
    });
    const locker = createRedisWorkflowMutationLocker(redis, 1_000);

    await expect(locker.withLock("release-race", async () => "done")).resolves.toBe("done");

    expect(releaseHooked).toBe(true);
    expect(redis.peek(key)).toBe("new-holder-token");
  });

  it("renews Redis locks while a workflow mutation is still running", async () => {
    vi.useFakeTimers();
    try {
      const key = redisLockKey("long-task");
      const redis = createFakeRedis();
      const locker = createRedisWorkflowMutationLocker(redis, 1_200);
      const hold = createDeferred<void>();

      const running = locker.withLock("long-task", async () => {
        await hold.promise;
        return "done";
      });
      await vi.waitFor(() => expect(redis.peek(key)).not.toBeNull());
      await vi.advanceTimersByTimeAsync(3_000);

      expect(await redis.set(key, "second-holder", "PX", 1_200, "NX")).toBeNull();
      hold.resolve();
      await expect(running).resolves.toBe("done");
      expect(await redis.set(key, "second-holder", "PX", 1_200, "NX")).toBe("OK");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopt-master: selects an existing master image without charging and creates master_ready workflow", async () => {
    const masterAsset = buildAsset("asset-main", "u1");
    const prisma = createPrismaMock({ assets: [masterAsset] });
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/adopt-master", payload: { ...masterRequest, masterAssetId: "asset-main" } });
    expect(res.statusCode).toBe(200);
    const wf = res.json().data.workflow;
    expect(wf.masterAssetId).toBe("asset-main");
    expect(wf.stage).toBe("master_ready");
    expect(billing.reserveResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("adopt-master: returns 400 when masterAssetId does not belong to user", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/adopt-master", payload: { ...masterRequest, masterAssetId: "not-mine" } });
    expect(res.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("adopt-master: 商品名称为空也能选主图当母版(放宽 product.name)", async () => {
    const prisma = createPrismaMock({ assets: [buildAsset("asset-main", "u1")] });
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });
    const res = await app.inject({ method: "POST", url: "/api/workflow/ecom/adopt-master", payload: { ...masterRequest, product: { name: "", category: "电子产品", sellingPoints: ["全能AI办公"], extra: "" }, masterAssetId: "asset-main" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.workflow.stage).toBe("master_ready");
    await app.close();
  });

  it("supports variable segment counts (2-8) with confirm and stitch driven by segmentCount", async () => {
    const assets = [buildAsset("asset-master")];
    const payload = { ...masterRequest, segmentCount: 5 };
    const billing = createBillingMock(), services = createServices();
    const app = await createApp({ billing, services });
    const master = await injectMaster(app, payload);
    expect(master.statusCode).toBe(200);
    expect(master.json().data.workflow.segmentCount).toBe(5);
    const segmentPrompts = services.callImageEdit.mock.calls.slice(1).map(([args]) => (args as { prompt: string }).prompt);
    expect(segmentPrompts).toHaveLength(0);
    await app.close();

    const confirmAssets = [buildAsset("asset-master"), buildAsset("asset-seg-0"), buildAsset("asset-seg-1"), buildAsset("asset-seg-2"), buildAsset("asset-seg-3"), buildAsset("asset-seg-4")];
    const confirmWorkflow = seedWorkflow({ segmentCount: 5, masterAssetId: "asset-master" });
    const confirmBilling = createBillingMock(), confirmServices = createServices();
    const confirmApp = await createApp({ prisma: createPrismaMock({ assets: confirmAssets, workflows: [confirmWorkflow] }), billing: confirmBilling, services: confirmServices });
    const confirm = await confirmApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/confirm" });
    expect(confirm.statusCode).toBe(200);
    expect(confirmBilling.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "image_generation_1k")).toHaveLength(5);
    const prompts = confirmServices.callImageEdit.mock.calls.map(([args]) => (args as { prompt: string }).prompt);
    expect(prompts[0]).toContain("分段名称：第 1 段（共 5 段）「首屏」");
    expect(prompts[2]).toContain("分段名称：第 3 段（共 5 段）「中段」");
    expect(prompts[2]).toContain("多中段区别：本段为中段之一");
    expect(prompts[4]).toContain("分段名称：第 5 段（共 5 段）「尾段」");
    for (const prompt of prompts) expect(prompt).toContain("约 1/5");
    await confirmApp.close();

    const stitchAssets = [buildAsset("asset-master"), ...Array.from({ length: 5 }, (_, i) => buildAsset(`asset-seg-${i}`))];
    const stitchWorkflow = seedWorkflow({ segmentCount: 5, stage: "segments_ready", segments: Array.from({ length: 5 }, (_, i) => ({ index: i, assetId: `asset-seg-${i}`, originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: `seg${i}`, createdAt: "2026-07-01T00:00:00.000Z" })) });
    const stitchBilling = createBillingMock();
    const stitchApp = await createApp({ prisma: createPrismaMock({ assets: stitchAssets, workflows: [stitchWorkflow] }), billing: stitchBilling });
    const stitch = await stitchApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/stitch", payload: { image: { b64: pngB64, mime: "image/png" } } });
    expect(stitch.statusCode).toBe(200);
    expect(stitchBilling.reserveResource).not.toHaveBeenCalled();
    await stitchApp.close();

    const incompleteBilling = createBillingMock();
    const incompleteWorkflow = seedWorkflow({ segmentCount: 5, stage: "segments_ready", segments: Array.from({ length: 4 }, (_, i) => ({ index: i, assetId: `asset-seg-${i}`, originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: `seg${i}`, createdAt: "2026-07-01T00:00:00.000Z" })) });
    const incompleteApp = await createApp({ prisma: createPrismaMock({ assets: stitchAssets, workflows: [incompleteWorkflow] }), billing: incompleteBilling });
    const incomplete = await incompleteApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/stitch", payload: { image: { b64: pngB64, mime: "image/png" } } });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error).toContain("分段图齐全");
    await incompleteApp.close();
  });

  it("persists the selected model and locks master, segments, and retry generation onto it", async () => {
    const prisma = createPrismaMock();
    const services = createServices();
    const app = await createApp({ prisma, services });
    const master = await injectMaster(app, { ...masterRequest, model: QWEN_MODEL, resolution: "2K" });
    expect(master.statusCode).toBe(200);
    expect(master.json().data.workflow.model).toBe(QWEN_MODEL);
    expect(prisma.__state.workflows[0]?.model).toBe(QWEN_MODEL);
    const confirm = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-1/segments/confirm" });
    expect(confirm.statusCode).toBe(200);
    const retry = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-1/master/retry" });
    expect(retry.statusCode).toBe(200);
    // 1 master + 3 segments + 1 retry 全部走锁定模型，不再读环境默认模型
    expect(services.loadImageGenerationConfigForModel.mock.calls.map(([model]) => model)).toEqual(Array.from({ length: 5 }, () => QWEN_MODEL));
    expect(services.loadImageGenerationConfig).not.toHaveBeenCalled();
    expect(services.callImageEdit).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ model: QWEN_MODEL }) }));
    await app.close();

    const defaultServices = createServices();
    const defaultApp = await createApp({ services: defaultServices });
    const defaultMaster = await injectMaster(defaultApp);
    expect(defaultMaster.statusCode).toBe(200);
    expect(defaultMaster.json().data.workflow.model).toBeNull();
    expect(defaultServices.loadImageGenerationConfig).toHaveBeenCalled();
    expect(defaultServices.loadImageGenerationConfigForModel).not.toHaveBeenCalled();
    await defaultApp.close();
  });

  it("rejects qwen 4K on master and adopt-master with a clear 400 and unknown models with 400", async () => {
    const prisma = createPrismaMock({ assets: [buildAsset("asset-main", "u1")] });
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });
    const rejected = await injectMaster(app, { ...masterRequest, model: QWEN_MODEL, resolution: "4K" });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("Qwen 模型最高支持 2K，请切换清晰度或模型");
    const adoptRejected = await app.inject({ method: "POST", url: "/api/workflow/ecom/adopt-master", payload: { ...masterRequest, masterAssetId: "asset-main", model: QWEN_MODEL, resolution: "4K" } });
    expect(adoptRejected.statusCode).toBe(400);
    expect(adoptRejected.json().error).toBe("Qwen 模型最高支持 2K，请切换清晰度或模型");
    const unknownModel = await injectMaster(app, { ...masterRequest, model: "not-a-model" });
    expect(unknownModel.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(prisma.__state.workflows).toHaveLength(0);
    // gpt-image-2 详情图三档尺寸均满足 16 倍数与像素约束，放行
    const gptOk = await injectMaster(app, { ...masterRequest, model: "gpt-image-2", resolution: "4K" });
    expect(gptOk.statusCode).toBe(200);
    await app.close();
  });

  it("uses deterministic master operation ids persisted before charge across attempts", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const failApp = await createApp({ prisma, billing, services: { callImageGeneration: vi.fn(async () => { throw new Error("upstream down"); }) }, maxAttempts: 1 });
    const failed = await injectMaster(failApp);
    expect(failed.statusCode).toBe(502);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ operationId: "ecom-master:wf-1:a0" }));
    expect(billing.refundResource).toHaveBeenCalledWith("ecom-master:wf-1:a0");
    expect(prisma.__state.workflows[0]?.billingOperationIds).toEqual(["ecom-master:wf-1:a0"]);
    await failApp.close();

    const retryBilling = createBillingMock();
    const retryApp = await createApp({ prisma, billing: retryBilling });
    const retry = await retryApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-1/master/retry" });
    expect(retry.statusCode).toBe(200);
    expect(retryBilling.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ operationId: "ecom-master:wf-1:a1" }));
    expect(retry.json().data.workflow.billingOperationIds).toEqual(["ecom-master:wf-1:a0", "ecom-master:wf-1:a1"]);
    await retryApp.close();
  });

  it("charges admin-configured dedicated ecom keys first, then model keys, then the generic image key", async () => {
    const dedicatedBilling = createBillingMock([priceRow("ecom_master_generation_1k", 30), priceRow("ecom_segment_generation_1k", 15)]);
    const dedicatedPrisma = createPrismaMock();
    const dedicatedApp = await createApp({ prisma: dedicatedPrisma, billing: dedicatedBilling });
    const master = await injectMaster(dedicatedApp);
    expect(master.statusCode).toBe(200);
    expect(dedicatedBilling.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "ecom_master_generation_1k" }));
    const confirm = await dedicatedApp.inject({ method: "POST", url: "/api/workflow/ecom/wf-1/segments/confirm" });
    expect(confirm.statusCode).toBe(200);
    expect(dedicatedBilling.reserveResource.mock.calls.filter(([args]) => (args as { resourceKey: string }).resourceKey === "ecom_segment_generation_1k")).toHaveLength(3);
    await dedicatedApp.close();

    const modelKeyBilling = createBillingMock([priceRow("image_generation_qwen_image_2_0_pro_2026_04_22_1k", 8)]);
    const modelKeyApp = await createApp({ billing: modelKeyBilling });
    const modelMaster = await injectMaster(modelKeyApp, { ...masterRequest, model: QWEN_MODEL });
    expect(modelMaster.statusCode).toBe(200);
    expect(modelKeyBilling.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_qwen_image_2_0_pro_2026_04_22_1k" }));
    await modelKeyApp.close();
  });

  it("pricing endpoint honors ?model=, reflects dedicated keys, and reports stitch as free", async () => {
    const billing = createBillingMock([
      priceRow("ecom_master_generation_1k", 30),
      priceRow("image_generation_qwen_image_2_0_pro_2026_04_22_2k", 66),
      priceRow("ecom_stitch", 1),
    ]);
    const app = await createApp({ billing });
    const priced = await app.inject({ method: "GET", url: `/api/workflow/ecom/pricing?model=${QWEN_MODEL}` });
    expect(priced.statusCode).toBe(200);
    const data = priced.json().data;
    expect(data.master["1K"]).toMatchObject({ resourceKey: "ecom_master_generation_1k", rate: 30 });
    expect(data.master["2K"]).toMatchObject({ resourceKey: "image_generation_qwen_image_2_0_pro_2026_04_22_2k", rate: 66 });
    expect(data.segment["1K"].resourceKey).toBe("image_generation_1k");
    expect(data.stitch.rate).toBe(0);
    const generic = await app.inject({ method: "GET", url: "/api/workflow/ecom/pricing?model=unknown-model" });
    expect(generic.statusCode).toBe(200);
    expect(generic.json().data.master["2K"].resourceKey).toBe("image_generation_2k");
    await app.close();
  });

  it("re-derives the operation id when a concurrent writer wins the CAS append, never charging a duplicate id", async () => {
    const assets = [buildAsset("asset-master"), buildAsset("asset-seg-0"), buildAsset("asset-seg-1")];
    const workflow = seedWorkflow({ segments: [{ index: 0, assetId: "asset-seg-0", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg0", createdAt: "2026-07-01T00:00:00.000Z" }] });
    const prisma = createPrismaMock({ assets, workflows: [workflow] });
    const billing = createBillingMock();
    // 模拟并发请求抢先 push 了 a0：本次 CAS 必然失败，必须重新取行派生 a1，而不是复用 a0。
    const append = interceptAppend(prisma, async (attempt, original) => {
      if (attempt === 1) {
        const row = prisma.__state.workflows[0]!;
        row.billingOperationIds = [...row.billingOperationIds, "ecom-segment:wf-seeded:1:a0"];
        row.updatedAt = new Date(row.updatedAt.getTime() + 500);
        return { count: 0 };
      }
      return original();
    });
    const app = await createApp({ prisma, billing });

    const redraw = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/1/redraw" });

    expect(redraw.statusCode).toBe(200);
    expect(append.attempts()).toBe(2);
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ operationId: "ecom-segment:wf-seeded:1:a1" }));
    const persisted = prisma.__state.workflows[0]!.billingOperationIds;
    expect(persisted).toEqual(["ecom-segment:wf-seeded:1:a0", "ecom-segment:wf-seeded:1:a1"]);
    expect(new Set(persisted).size).toBe(persisted.length);
    await app.close();
  });

  it("returns 409 without charging when the CAS append keeps losing to concurrent writers", async () => {
    const prisma = createPrismaMock({
      assets: [buildAsset("asset-master"), buildAsset("asset-seg-0")],
      workflows: [seedWorkflow({ segments: [{ index: 0, assetId: "asset-seg-0", originalUrl: dataUrl, thumbnailUrl: dataUrl, prompt: "seg0", createdAt: "2026-07-01T00:00:00.000Z" }] })],
    });
    const billing = createBillingMock();
    const append = interceptAppend(prisma, async () => ({ count: 0 }));
    const app = await createApp({ prisma, billing });

    const response = await app.inject({ method: "POST", url: "/api/workflow/ecom/wf-seeded/segments/1/redraw" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("工作流正在处理");
    expect(append.attempts()).toBe(5);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(prisma.__state.workflows[0]?.billingOperationIds).toEqual([]);
    await app.close();
  });

  it("warns instead of silently falling back when listResourcePrices fails", async () => {
    const billing = createBillingMock([]);
    billing.listResourcePrices!.mockRejectedValueOnce(new Error("billing pricing down"));
    const app = await createApp({ billing });
    const warn = vi.spyOn(app.log, "warn");

    const master = await injectMaster(app);

    expect(master.statusCode).toBe(200);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k" }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: "billing pricing down" }), expect.stringContaining("listResourcePrices failed"));
    await app.close();
  });
});
