import { Buffer } from "node:buffer";
import Fastify from "fastify";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { tryOnWorkflowRoutes } from "./try-on-routes.js";
import { TRY_ON_CONSENT_VERSION } from "./try-on-prompts.js";

type TryOnRouteDeps = NonNullable<Parameters<typeof tryOnWorkflowRoutes>[1]>;
type CallImageEdit = NonNullable<TryOnRouteDeps["callImageEdit"]>;

type ReferenceRow = {
  id: string;
  userId: string;
  kind: string;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type OutputRow = {
  id: string;
  taskId: string;
  userId: string;
  requestIndex: number;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: Date;
};
type TaskRow = {
  id: string;
  userId: string;
  requestId: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  count: number;
  description: string;
  effectivePrompt: string;
  garmentFrontAssetId: string;
  garmentDetailAssetId: string | null;
  modelAssetId: string | null;
  status: string;
  completedCount: number;
  error: string | null;
  consentVersion: string | null;
  billingOperationId: string;
  billingResourceKey: string;
  billingReservedUnits: number;
  billingSettledUnits: number;
  billingStatus: string;
  cancelRequested: boolean;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function reference(kind: string, id: string, userId = "u1"): ReferenceRow {
  const now = new Date();
  return {
    id,
    userId,
    kind,
    objectKey: `workflow/try-ons/references/${userId}/seed/0-${id}.jpg`,
    mime: "image/jpeg",
    width: 800,
    height: 1000,
    sizeBytes: 1000,
    expiresAt: new Date(Date.now() + 86_400_000),
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createPrismaMock(seed: ReferenceRow[] = []) {
  const references = [...seed];
  const tasks: TaskRow[] = [];
  const outputs: OutputRow[] = [];
  const withOutputs = (task: TaskRow) => ({ ...task, outputs: outputs.filter((output) => output.taskId === task.id) });
  const matchesTask = (task: TaskRow, where: Record<string, any> = {}) => {
    if (where.id && task.id !== where.id) return false;
    if (where.userId && task.userId !== where.userId) return false;
    if (where.requestId && task.requestId !== where.requestId) return false;
    if (where.status?.in && !where.status.in.includes(task.status)) return false;
    if (where.billingStatus && task.billingStatus !== where.billingStatus) return false;
    if (where.updatedAt?.lt && task.updatedAt >= where.updatedAt.lt) return false;
    if (
      where.OR &&
      !where.OR.some((condition: Record<string, string>) =>
        Object.entries(condition).every(([key, value]) => (task as any)[key] === value),
      )
    )
      return false;
    return true;
  };
  const prisma = {
    tryOnReferenceAsset: {
      findMany: vi.fn(async (args: { where?: Record<string, any>; take?: number }) => {
        const where = args.where ?? {};
        const rows = references
          .filter((row) => {
            if (where.userId && row.userId !== where.userId) return false;
            if (where.id?.in && !where.id.in.includes(row.id)) return false;
            if (where.deletedAt === null && row.deletedAt !== null) return false;
            if (where.expiresAt?.lte && (!row.expiresAt || row.expiresAt > where.expiresAt.lte)) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return args.take ? rows.slice(0, args.take) : rows;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => references.find((row) => row.id === where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, any> }) =>
          references.find(
            (row) =>
              (!where.id || row.id === where.id) &&
              (!where.userId || row.userId === where.userId) &&
              (where.deletedAt !== null || row.deletedAt === null),
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Omit<ReferenceRow, "id" | "createdAt" | "updatedAt" | "deletedAt"> }) => {
        const now = new Date();
        const row: ReferenceRow = {
          ...data,
          id: `ref-${references.length + 1}`,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        references.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ReferenceRow> }) => {
        const row = references.find((item) => item.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Partial<ReferenceRow> }) => {
        let count = 0;
        for (const row of references) {
          if (where.id?.in && !where.id.in.includes(row.id)) continue;
          if (where.deletedAt === null && row.deletedAt !== null) continue;
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
        return { count };
      }),
    },
    tryOnTask: {
      findFirst: vi.fn(async (args: { where?: Record<string, any>; include?: unknown; select?: unknown }) => {
        const row = tasks.find((task) => matchesTask(task, args.where));
        if (!row) return null;
        return args.select ? { id: row.id } : args.include ? withOutputs(row) : row;
      }),
      findUnique: vi.fn(
        async (args: { where: { id?: string; requestId?: string }; include?: unknown; select?: unknown }) => {
          const row = tasks.find(
            (task) =>
              (!args.where.id || task.id === args.where.id) &&
              (!args.where.requestId || task.requestId === args.where.requestId),
          );
          if (!row) return null;
          return args.select ? { id: row.id } : args.include ? withOutputs(row) : row;
        },
      ),
      findMany: vi.fn(async (args: { where?: Record<string, any>; include?: unknown; take?: number }) => {
        let rows = tasks
          .filter((task) => matchesTask(task, args.where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (args.take) rows = rows.slice(0, args.take);
        return args.include ? rows.map(withOutputs) : rows;
      }),
      create: vi.fn(async ({ data, include }: { data: any; include?: unknown }) => {
        const now = new Date();
        const row: TaskRow = {
          ...data,
          id: `task-${tasks.length + 1}`,
          completedCount: 0,
          error: null,
          cancelRequested: false,
          startedAt: now,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        tasks.push(row);
        return include ? withOutputs(row) : row;
      }),
      update: vi.fn(
        async ({ where, data, include }: { where: { id: string }; data: Partial<TaskRow>; include?: unknown }) => {
          const row = tasks.find((task) => task.id === where.id)!;
          Object.assign(row, data, { updatedAt: new Date() });
          return include ? withOutputs(row) : row;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = tasks.findIndex((task) => task.id === where.id);
        return tasks.splice(index, 1)[0];
      }),
    },
    tryOnOutput: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => outputs.find((row) => row.id === where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { taskId: string } }) =>
        outputs.filter((row) => row.taskId === where.taskId),
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { taskId_requestIndex: { taskId: string; requestIndex: number } };
          create: Omit<OutputRow, "id" | "createdAt">;
        }) => {
          const existing = outputs.find(
            (row) =>
              row.taskId === where.taskId_requestIndex.taskId &&
              row.requestIndex === where.taskId_requestIndex.requestIndex,
          );
          if (existing) return existing;
          const row: OutputRow = { ...create, id: `output-${outputs.length + 1}`, createdAt: new Date() };
          outputs.push(row);
          return row;
        },
      ),
    },
  };
  return { prisma, references, tasks, outputs };
}

const validPayload = {
  requestId: "try-on-request-1",
  model: "doubao-seedream-5-0-260128",
  aspectRatio: "3:4",
  resolution: "2K",
  count: 1,
  garmentFrontAssetId: "front-1",
  description: "明亮影棚",
};

function persistedTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = new Date();
  return {
    id: "task-pending-1",
    userId: "u1",
    requestId: "try-on-pending-1",
    model: "doubao-seedream-5-0-260128",
    aspectRatio: "3:4",
    resolution: "2K",
    count: 1,
    description: "",
    effectivePrompt: "生成服装试穿图",
    garmentFrontAssetId: "front-1",
    garmentDetailAssetId: null,
    modelAssetId: null,
    status: "pending",
    completedCount: 0,
    error: null,
    consentVersion: null,
    billingOperationId: "try-on:try-on-pending-1",
    billingResourceKey: "image_generation_2k",
    billingReservedUnits: 0,
    billingSettledUnits: 0,
    billingStatus: "pending",
    cancelRequested: false,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function createApp(
  db: ReturnType<typeof createPrismaMock>,
  callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" })),
  options: {
    readonly authenticated?: boolean;
    readonly maxAttempts?: number;
    readonly outputSize?: { readonly width: number; readonly height: number };
  } = {},
) {
  const app = Fastify({ bodyLimit: 30 * 1024 * 1024 });
  app.decorateRequest("userId", "");
  if (options.authenticated !== false)
    app.addHook("onRequest", async (req) => {
      req.userId = "u1";
    });
  const objects = new Map<string, Buffer>();
  const inputBytes = await sharp({ create: { width: 40, height: 50, channels: 3, background: "#907050" } })
    .jpeg()
    .toBuffer();
  const outputSize = options.outputSize ?? { width: 1728, height: 2304 };
  const outputBytes = await sharp({ create: { ...outputSize, channels: 3, background: "#305070" } })
    .png()
    .toBuffer();
  db.references.forEach((row) => objects.set(row.objectKey, inputBytes));
  const billing = {
    reserveResource: vi.fn(async () => ({ reserved: 20 })),
    settleResource: vi.fn(async () => ({ settled: 20 })),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({ data: [] })),
  };
  const scheduled: Promise<void>[] = [];
  const storeImage = vi.fn(async (args: any) => {
    const ref = args.namespace.endsWith("references");
    const key = `${args.namespace}/${args.userId}/${args.requestId}/${args.requestIndex}-stored.${ref ? "jpg" : "png"}`;
    objects.set(key, ref ? Buffer.from(args.image.b64, "base64") : outputBytes);
    return { originalUrl: "", thumbnailUrl: "", mime: ref ? "image/jpeg" : "image/png", objectKey: key };
  });
  await app.register(tryOnWorkflowRoutes, {
    prisma: db.prisma as unknown as PrismaClient,
    billing,
    fetchFn: vi.fn() as unknown as typeof fetch,
    scheduleTask: (work: () => Promise<void>) => {
      scheduled.push(work());
    },
    retryDelayMs: 1,
    maxAttempts: options.maxAttempts ?? 1,
    storeImage,
    loadStoredImage: async (key: string) => objects.get(key) ?? Promise.reject(new Error("missing object")),
    deleteStoredImage: async (key: string) => {
      objects.delete(key);
    },
    callImageEdit,
  });
  await app.ready();
  return { app, billing, scheduled, storeImage, callImageEdit };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "try-on-test-secret-123456789";
  process.env.ARK_API_KEY = "ark-test-key";
  process.env.GPT_IMAGE_API_KEY = "gpt-test-key";
});

describe("try-on workflow routes", () => {
  it("requires authentication on every state-changing or private-data route", async () => {
    const db = createPrismaMock([reference("garment_front", "front-1")]);
    const { app, billing, storeImage } = await createApp(db, undefined, { authenticated: false });
    const cases = [
      { method: "GET" as const, url: "/api/workflow/try-ons/options" },
      { method: "POST" as const, url: "/api/workflow/try-ons/references", payload: {} },
      { method: "DELETE" as const, url: "/api/workflow/try-ons/references/front-1" },
      { method: "GET" as const, url: "/api/workflow/try-ons/state" },
      { method: "POST" as const, url: "/api/workflow/try-ons/generate", payload: validPayload },
      { method: "POST" as const, url: "/api/workflow/try-ons/tasks/try-on-task-1/cancel" },
      { method: "DELETE" as const, url: "/api/workflow/try-ons/tasks/try-on-task-1" },
    ];
    for (const one of cases) {
      const response = await app.inject(one);
      expect(response.statusCode, `${one.method} ${one.url}`).toBe(401);
    }
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(storeImage).not.toHaveBeenCalled();
    expect(db.prisma.tryOnTask.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes role-tagged uploads and stores them privately", async () => {
    const db = createPrismaMock();
    const { app, storeImage } = await createApp(db);
    const source = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#eeccaa" } })
      .png()
      .toBuffer();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/references",
      payload: { kind: "garment_front", image: { b64: source.toString("base64"), mime: "image/png" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset).toMatchObject({
      kind: "garment_front",
      mime: "image/jpeg",
      width: 32,
      height: 24,
    });
    expect(response.json().data.asset).not.toHaveProperty("objectKey");
    expect(storeImage).toHaveBeenCalledWith(
      expect.objectContaining({ acl: "private", namespace: "workflow/try-ons/references" }),
    );
    await app.close();
  });

  it("rejects images above 40MP before storing them", async () => {
    const db = createPrismaMock();
    const { app, storeImage } = await createApp(db);
    const oversizedSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="5001"><rect width="100%" height="100%" fill="red"/></svg>',
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/references",
      payload: { kind: "garment_front", image: { b64: oversizedSvg.toString("base64"), mime: "image/png" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("像素尺寸过大");
    expect(storeImage).not.toHaveBeenCalled();
    await app.close();
  });

  it("generates with a garment only and settles successful images", async () => {
    const db = createPrismaMock([reference("garment_front", "front-1")]);
    const callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" }));
    const { app, billing, scheduled } = await createApp(db, callImageEdit);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: { ...validPayload, count: 2 },
    });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    expect(callImageEdit).toHaveBeenCalledTimes(2);
    expect(callImageEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        size: "1728x2304",
        prompt: expect.stringContaining("创建一位自然、真实、适合展示该服装的单人模特"),
        referenceImages: [expect.objectContaining({ filename: "garment-front.jpg" })],
      }),
    );
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: "try-on:try-on-request-1",
      userId: "u1",
      resourceKey: "image_generation_2k",
      units: 2,
    });
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "try-on:try-on-request-1",
      resourceKey: "image_generation_2k",
      units: 2,
    });
    expect(db.tasks[0]).toMatchObject({
      status: "completed",
      completedCount: 2,
      billingStatus: "settled",
      consentVersion: null,
    });
    await app.close();
  });

  it("keeps duplicate requests idempotent and isolates another user's assets", async () => {
    const db = createPrismaMock([
      reference("garment_front", "front-1"),
      reference("garment_front", "other-front", "u2"),
    ]);
    const { app, billing, scheduled } = await createApp(db);
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: { ...validPayload, requestId: "try-on-other-user", garmentFrontAssetId: "other-front" },
    });
    expect(forbidden.statusCode).toBe(404);

    const first = await app.inject({ method: "POST", url: "/api/workflow/try-ons/generate", payload: validPayload });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: validPayload,
    });
    expect(first.statusCode).toBe(202);
    expect([200, 202]).toContain(duplicate.statusCode);
    expect(db.tasks).toHaveLength(1);
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    await Promise.all(scheduled);
    await app.close();
  });

  it("settles only successful images when a batch partially fails", async () => {
    const db = createPrismaMock([reference("garment_front", "front-1")]);
    let calls = 0;
    const callImageEdit = vi.fn<CallImageEdit>(async () => {
      calls += 1;
      if (calls === 1) return { kind: "b64" as const, b64: "", mime: "image/png" };
      throw new Error("upstream failed");
    });
    const { app, billing, scheduled } = await createApp(db, callImageEdit);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: { ...validPayload, count: 2 },
    });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    expect(db.tasks[0]).toMatchObject({
      status: "partial",
      completedCount: 1,
      billingStatus: "settled",
      billingSettledUnits: 1,
    });
    expect(db.outputs).toHaveLength(1);
    expect(billing.settleResource).toHaveBeenCalledWith(expect.objectContaining({ units: 1 }));
    await app.close();
  });

  it("retries transient failures up to the configured attempt limit", async () => {
    const db = createPrismaMock([reference("garment_front", "front-1")]);
    const callImageEdit = vi
      .fn<CallImageEdit>()
      .mockRejectedValueOnce(new Error("temporary one"))
      .mockRejectedValueOnce(new Error("temporary two"))
      .mockResolvedValue({ kind: "b64", b64: "", mime: "image/png" });
    const { app, scheduled } = await createApp(db, callImageEdit, { maxAttempts: 3 });
    await app.inject({ method: "POST", url: "/api/workflow/try-ons/generate", payload: validPayload });
    await Promise.all(scheduled);
    expect(callImageEdit).toHaveBeenCalledTimes(3);
    expect(db.tasks[0]).toMatchObject({ status: "completed", completedCount: 1 });
    await app.close();
  });

  it("refunds a fully failed task and cancels an active task exactly once", async () => {
    const failedDb = createPrismaMock([reference("garment_front", "front-1")]);
    const failed = await createApp(
      failedDb,
      vi.fn<CallImageEdit>(async () => {
        throw new Error("upstream failed");
      }),
    );
    await failed.app.inject({ method: "POST", url: "/api/workflow/try-ons/generate", payload: validPayload });
    await Promise.all(failed.scheduled);
    expect(failedDb.tasks[0]).toMatchObject({ status: "failed", completedCount: 0, billingStatus: "refunded" });
    expect(failed.billing.refundResource).toHaveBeenCalledWith("try-on:try-on-request-1");
    await failed.app.close();

    const cancelledDb = createPrismaMock([reference("garment_front", "front-1")]);
    const pendingEdit = vi.fn<CallImageEdit>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const cancelled = await createApp(cancelledDb, pendingEdit);
    await cancelled.app.inject({ method: "POST", url: "/api/workflow/try-ons/generate", payload: validPayload });
    const blockedDelete = await cancelled.app.inject({
      method: "DELETE",
      url: "/api/workflow/try-ons/references/front-1",
    });
    expect(blockedDelete.statusCode).toBe(409);
    const response = await cancelled.app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/tasks/try-on-request-1/cancel",
    });
    expect(response.statusCode).toBe(200);
    await Promise.all(cancelled.scheduled);
    expect(cancelledDb.tasks[0]).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      billingStatus: "refunded",
    });
    expect(cancelled.billing.refundResource).toHaveBeenCalledTimes(1);
    await cancelled.app.close();
  });

  it("recovers a persisted pending task and settles at delivered resolution", async () => {
    const db = createPrismaMock([reference("garment_front", "front-1")]);
    db.tasks.push(persistedTask({ model: "gpt-image-2" }));
    const { app, billing, scheduled } = await createApp(db, undefined, { outputSize: { width: 1086, height: 1448 } });
    const response = await app.inject({ method: "GET", url: "/api/workflow/try-ons/state" });
    expect(response.statusCode).toBe(200);
    await Promise.all(scheduled);
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: "try-on:try-on-pending-1",
      userId: "u1",
      resourceKey: "image_generation_2k",
      units: 1,
    });
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "try-on:try-on-pending-1",
      resourceKey: "image_generation_1k",
      units: 1,
    });
    expect(db.tasks[0]).toMatchObject({
      status: "completed",
      billingStatus: "settled",
      billingResourceKey: "image_generation_1k",
    });
    await app.close();
  });

  it("requires model consent and sends garment, detail, then model in fixed order", async () => {
    const db = createPrismaMock([
      reference("garment_front", "front-1"),
      reference("garment_detail", "detail-1"),
      reference("model", "model-1"),
    ]);
    const callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" }));
    const { app, billing, scheduled } = await createApp(db, callImageEdit);
    const denied = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: { ...validPayload, garmentDetailAssetId: "detail-1", modelAssetId: "model-1" },
    });
    expect(denied.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: {
        ...validPayload,
        garmentDetailAssetId: "detail-1",
        modelAssetId: "model-1",
        authorizationAccepted: true,
        consentVersion: TRY_ON_CONSENT_VERSION,
      },
    });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    const call = callImageEdit.mock.calls[0]![0];
    expect(call.referenceImages.map((image) => image.filename)).toEqual([
      "garment-front.jpg",
      "garment-detail.jpg",
      "model-reference.jpg",
    ]);
    expect(call.prompt).toContain("严格保持模特人物身份一致");
    expect(db.tasks[0]).toMatchObject({ consentVersion: TRY_ON_CONSENT_VERSION, modelAssetId: "model-1" });
    await app.close();
  });

  it("rejects wrong roles and unsupported model resolution before billing", async () => {
    const db = createPrismaMock([reference("model", "front-1")]);
    const { app, billing } = await createApp(db);
    const wrongRole = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: validPayload,
    });
    expect(wrongRole.statusCode).toBe(404);
    const unsupported = await app.inject({
      method: "POST",
      url: "/api/workflow/try-ons/generate",
      payload: { ...validPayload, model: "gpt-image-2", resolution: "4K" },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the portrait-aligned options and model-aware pricing matrix", async () => {
    const db = createPrismaMock();
    const { app } = await createApp(db);
    const response = await app.inject({ method: "GET", url: "/api/workflow/try-ons/options" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      model: "doubao-seedream-5-0-260128",
      consentVersion: TRY_ON_CONSENT_VERSION,
      aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
      resolutions: ["1K", "2K", "4K"],
      pricingByModel: {
        "doubao-seedream-5-0-260128": { "2K": 20, "4K": 40 },
        "gpt-image-2": { "1K": 10, "2K": 20 },
      },
    });
    await app.close();
  });
});
