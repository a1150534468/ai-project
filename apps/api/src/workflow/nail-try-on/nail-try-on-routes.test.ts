import { Buffer } from "node:buffer";
import Fastify from "fastify";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { nailTryOnWorkflowRoutes } from "./nail-try-on-routes.js";
import { portraitReservationTtlSeconds } from "../portrait/portrait-shared.js";
import { humanImageOutputSize } from "../_shared/human-image-options.js";
import { NAIL_TRY_ON_CONSENT_VERSION } from "./nail-try-on-prompts.js";

type NailRouteDeps = NonNullable<Parameters<typeof nailTryOnWorkflowRoutes>[1]>;
type CallImageEdit = NonNullable<NailRouteDeps["callImageEdit"]>;

// 默认档位：gpt-image-2 支持 1K，1:1 → 1024x1024，手照与蒙版都用它。
const TIER = humanImageOutputSize("1K", "1:1");
const [TIER_W, TIER_H] = TIER.split("x").map(Number) as [number, number];

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
  handAssetId: string;
  nailDesignAssetId: string | null;
  maskObjectKey: string;
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

function reference(kind: string, id: string, userId = "u1", width = TIER_W, height = TIER_H): ReferenceRow {
  const now = new Date();
  return {
    id,
    userId,
    kind,
    objectKey: `workflow/nail-try-ons/references/${userId}/seed/0-${id}.jpg`,
    mime: "image/jpeg",
    width,
    height,
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
    if (
      where.OR &&
      !where.OR.some((condition: Record<string, string>) =>
        Object.entries(condition).every(([key, value]) => (task as any)[key] === value),
      )
    )
      return false;
    return true;
  };
  const nailTryOnReferenceAsset = {
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
      const row: ReferenceRow = { ...data, id: `ref-${references.length + 1}`, deletedAt: null, createdAt: now, updatedAt: now };
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
  };
  const nailTryOnTask = {
    findFirst: vi.fn(async (args: { where?: Record<string, any>; include?: unknown; select?: unknown }) => {
      const row = tasks.find((task) => matchesTask(task, args.where));
      if (!row) return null;
      return args.select ? { id: row.id } : args.include ? withOutputs(row) : row;
    }),
    findUnique: vi.fn(async (args: { where: { id?: string; requestId?: string }; include?: unknown; select?: unknown }) => {
      const row = tasks.find(
        (task) => (!args.where.id || task.id === args.where.id) && (!args.where.requestId || task.requestId === args.where.requestId),
      );
      if (!row) return null;
      return args.select ? { id: row.id } : args.include ? withOutputs(row) : row;
    }),
    findMany: vi.fn(async (args: { where?: Record<string, any>; include?: unknown; take?: number }) => {
      let rows = tasks.filter((task) => matchesTask(task, args.where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
    update: vi.fn(async ({ where, data, include }: { where: { id: string }; data: Partial<TaskRow>; include?: unknown }) => {
      const row = tasks.find((task) => task.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return include ? withOutputs(row) : row;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const index = tasks.findIndex((task) => task.id === where.id);
      return tasks.splice(index, 1)[0];
    }),
  };
  const nailTryOnOutput = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => outputs.find((row) => row.id === where.id) ?? null),
    findMany: vi.fn(async ({ where }: { where: { taskId: string } }) => outputs.filter((row) => row.taskId === where.taskId)),
    upsert: vi.fn(
      async ({ where, create }: { where: { taskId_requestIndex: { taskId: string; requestIndex: number } }; create: Omit<OutputRow, "id" | "createdAt"> }) => {
        const existing = outputs.find(
          (row) => row.taskId === where.taskId_requestIndex.taskId && row.requestIndex === where.taskId_requestIndex.requestIndex,
        );
        if (existing) return existing;
        const row: OutputRow = { ...create, id: `output-${outputs.length + 1}`, createdAt: new Date() };
        outputs.push(row);
        return row;
      },
    ),
  };
  const prisma = { nailTryOnReferenceAsset, nailTryOnTask, nailTryOnOutput };
  return { prisma, references, tasks, outputs };
}
async function maskB64(width = TIER_W, height = TIER_H, channels: 3 | 4 = 4): Promise<string> {
  const image = sharp({ create: { width, height, channels, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  return (await image.png().toBuffer()).toString("base64");
}

async function createApp(
  db: ReturnType<typeof createPrismaMock>,
  callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" })),
  options: { readonly authenticated?: boolean; readonly maxAttempts?: number; readonly outputSize?: { readonly width: number; readonly height: number } } = {},
) {
  const app = Fastify({ bodyLimit: 30 * 1024 * 1024 });
  app.decorateRequest("userId", "");
  if (options.authenticated !== false)
    app.addHook("onRequest", async (req) => {
      req.userId = "u1";
    });
  const objects = new Map<string, Buffer>();
  const inputBytes = await sharp({ create: { width: 40, height: 50, channels: 3, background: "#907050" } }).jpeg().toBuffer();
  const outputSize = options.outputSize ?? { width: TIER_W, height: TIER_H };
  const outputBytes = await sharp({ create: { ...outputSize, channels: 3, background: "#305070" } }).png().toBuffer();
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
    const mask = args.namespace.endsWith("masks");
    const ext = ref ? "jpg" : "png";
    const key = `${args.namespace}/${args.userId}/${args.requestId}/${args.requestIndex}-stored.${ext}`;
    objects.set(key, ref || mask ? Buffer.from(args.image.b64, "base64") : outputBytes);
    return { originalUrl: "", thumbnailUrl: "", mime: ref ? "image/jpeg" : "image/png", objectKey: key };
  });
  await app.register(nailTryOnWorkflowRoutes, {
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
  return { app, billing, scheduled, storeImage, callImageEdit, objects };
}
async function generatePayload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "nail-try-on-request-1",
    aspectRatio: "1:1" as const,
    resolution: "1K" as const,
    handAssetId: "hand-1",
    mask: { b64: await maskB64() },
    authorizationAccepted: true,
    consentVersion: NAIL_TRY_ON_CONSENT_VERSION,
    ...overrides,
  };
}

function persistedTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = new Date();
  return {
    id: "task-seed",
    userId: "u1",
    requestId: "nail-try-on-pending-1",
    model: "gpt-image-2",
    aspectRatio: "1:1",
    resolution: "1K",
    count: 1,
    description: "",
    effectivePrompt: "prompt",
    handAssetId: "hand-1",
    nailDesignAssetId: null,
    maskObjectKey: "workflow/nail-try-ons/masks/u1/nail-try-on-pending-1/0-stored.png",
    status: "pending",
    completedCount: 0,
    error: null,
    consentVersion: NAIL_TRY_ON_CONSENT_VERSION,
    billingOperationId: "nail-try-on:nail-try-on-pending-1",
    billingResourceKey: "image_generation_1k",
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
beforeEach(() => {
  process.env.SESSION_SECRET = "nail-try-on-test-secret-123456789";
  process.env.ARK_API_KEY = "ark-test-key";
  process.env.GPT_IMAGE_API_KEY = "gpt-test-key";
});

describe("nail try-on workflow routes", () => {
  it("requires authentication on every private route", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    const { app, billing, storeImage } = await createApp(db, undefined, { authenticated: false });
    const cases = [
      { method: "GET" as const, url: "/api/workflow/nail-try-ons/options" },
      { method: "POST" as const, url: "/api/workflow/nail-try-ons/references", payload: {} },
      { method: "DELETE" as const, url: "/api/workflow/nail-try-ons/references/hand-1" },
      { method: "GET" as const, url: "/api/workflow/nail-try-ons/state" },
      { method: "POST" as const, url: "/api/workflow/nail-try-ons/generate", payload: await generatePayload() },
      { method: "POST" as const, url: "/api/workflow/nail-try-ons/tasks/nail-try-on-request-1/cancel" },
      { method: "DELETE" as const, url: "/api/workflow/nail-try-ons/tasks/nail-try-on-request-1" },
    ];
    for (const one of cases) {
      const response = await app.inject(one);
      expect(response.statusCode, `${one.method} ${one.url}`).toBe(401);
    }
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(storeImage).not.toHaveBeenCalled();
    expect(db.prisma.nailTryOnTask.create).not.toHaveBeenCalled();
    await app.close();
  });
  it("normalizes a hand upload and stores it privately as jpeg", async () => {
    const db = createPrismaMock();
    const { app, storeImage } = await createApp(db);
    const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#eeccaa" } }).png().toBuffer();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/references",
      payload: { kind: "hand", image: { b64: source.toString("base64"), mime: "image/png" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset).toMatchObject({ kind: "hand", mime: "image/jpeg", width: 64, height: 48 });
    expect(response.json().data.asset).not.toHaveProperty("objectKey");
    expect(storeImage).toHaveBeenCalledWith(
      expect.objectContaining({ acl: "private", namespace: "workflow/nail-try-ons/references" }),
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
      url: "/api/workflow/nail-try-ons/references",
      payload: { kind: "hand", image: { b64: oversizedSvg.toString("base64"), mime: "image/png" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("像素尺寸过大");
    expect(storeImage).not.toHaveBeenCalled();
    await app.close();
  });
  it("rejects generation without hand-photo authorization on every request", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    const { app, billing, storeImage } = await createApp(db);
    const noConsent = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ authorizationAccepted: false, consentVersion: undefined }),
    });
    expect(noConsent.statusCode).toBe(400);
    const wrongVersion = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ consentVersion: "stale-version" }),
    });
    expect(wrongVersion.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(storeImage).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a hand photo whose size does not match the chosen ratio", async () => {
    const db = createPrismaMock([reference("hand", "hand-1", "u1", 864, 1152)]);
    const { app, billing, storeImage } = await createApp(db);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("手部照片尺寸与所选比例不一致");
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(storeImage).not.toHaveBeenCalled();
    await app.close();
  });
  it("rejects a mask that is mis-sized or lacks alpha before billing", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    const { app, billing, storeImage } = await createApp(db);
    const wrongSize = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ mask: { b64: await maskB64(512, 512) } }),
    });
    expect(wrongSize.statusCode).toBe(400);
    expect(wrongSize.json().error).toContain("蒙版");
    const noAlpha = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ mask: { b64: await maskB64(TIER_W, TIER_H, 3) } }),
    });
    expect(noAlpha.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(storeImage).not.toHaveBeenCalled();
    await app.close();
  });
  it("locks the hand by forwarding a png mask to the openai edit and settles", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    const callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" }));
    const { app, billing, scheduled, storeImage } = await createApp(db, callImageEdit);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ count: 2 }),
    });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    expect(callImageEdit).toHaveBeenCalledTimes(2);
    const call = callImageEdit.mock.calls[0]![0];
    expect(call.size).toBe(`${TIER_W}x${TIER_H}`);
    expect(call.referenceImages.map((image) => image.filename)).toEqual(["nail-hand.jpg"]);
    expect(call.mask).toMatchObject({ mime: "image/png", filename: "nail-mask.png" });
    expect(call.mask?.b64).toBeTruthy();
    expect(call.prompt).toContain("必须原样保留的底图");
    expect(call.prompt).toContain("严格保持手不变");
    expect(storeImage).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "workflow/nail-try-ons/masks", acl: "private" }),
    );
    expect(storeImage).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "workflow/nail-try-ons/outputs", acl: "private" }),
    );
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: "nail-try-on:nail-try-on-request-1",
      userId: "u1",
      resourceKey: "image_generation_1k",
      units: 2,
      reservationTtlSeconds: portraitReservationTtlSeconds(2),
    });
    expect(billing.settleResource).toHaveBeenCalledWith({
      operationId: "nail-try-on:nail-try-on-request-1",
      resourceKey: "image_generation_1k",
      units: 2,
    });
    expect(db.tasks[0]).toMatchObject({
      status: "completed",
      completedCount: 2,
      billingStatus: "settled",
      consentVersion: NAIL_TRY_ON_CONSENT_VERSION,
    });
    await app.close();
  });
  it("passes the hand then the nail-design reference in fixed order", async () => {
    const db = createPrismaMock([reference("hand", "hand-1"), reference("nail_design", "design-1")]);
    const callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" }));
    const { app, scheduled } = await createApp(db, callImageEdit);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ nailDesignAssetId: "design-1" }),
    });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    const call = callImageEdit.mock.calls[0]![0];
    expect(call.referenceImages.map((image) => image.filename)).toEqual(["nail-hand.jpg", "nail-design.jpg"]);
    expect(call.prompt).toContain("参考图 2 是美甲样式参考");
    expect(db.tasks[0]).toMatchObject({ nailDesignAssetId: "design-1" });
    await app.close();
  });

  it("degrades to full-image edit (no mask) when the model has no mask support", async () => {
    const db = createPrismaMock([reference("hand", "hand-1", "u1", 2048, 2048)]);
    const callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" }));
    const { app, scheduled } = await createApp(db, callImageEdit, { outputSize: { width: 2048, height: 2048 } });
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({
        model: "doubao-seedream-5-0-260128",
        resolution: "2K",
        mask: { b64: await maskB64(2048, 2048) },
      }),
    });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    const call = callImageEdit.mock.calls[0]![0];
    expect(call.mask).toBeUndefined();
    expect(call.size).toBe("2048x2048");
    expect(call.referenceImages.map((image) => image.filename)).toEqual(["nail-hand.jpg"]);
    expect(db.tasks[0]).toMatchObject({ status: "completed", model: "doubao-seedream-5-0-260128" });
    await app.close();
  });
  it("keeps duplicate requests idempotent and isolates another user's hand photo", async () => {
    const db = createPrismaMock([reference("hand", "hand-1"), reference("hand", "other-hand", "u2")]);
    const { app, billing, scheduled } = await createApp(db);
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ requestId: "nail-try-on-cross-user", handAssetId: "other-hand" }),
    });
    expect(forbidden.statusCode).toBe(404);

    const first = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload(),
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload(),
    });
    expect(first.statusCode).toBe(202);
    expect([200, 202]).toContain(duplicate.statusCode);
    expect(db.tasks).toHaveLength(1);
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    await Promise.all(scheduled);
    await app.close();
  });
  it("settles only successful images when a batch partially fails", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    let calls = 0;
    const callImageEdit = vi.fn<CallImageEdit>(async () => {
      calls += 1;
      if (calls === 1) return { kind: "b64" as const, b64: "", mime: "image/png" };
      throw new Error("upstream failed");
    });
    const { app, billing, scheduled } = await createApp(db, callImageEdit);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ count: 2 }),
    });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    expect(db.tasks[0]).toMatchObject({ status: "partial", completedCount: 1, billingStatus: "settled", billingSettledUnits: 1 });
    expect(db.outputs).toHaveLength(1);
    expect(billing.settleResource).toHaveBeenCalledWith(expect.objectContaining({ units: 1 }));
    await app.close();
  });

  it("retries transient failures up to the configured attempt limit", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    const callImageEdit = vi
      .fn<CallImageEdit>()
      .mockRejectedValueOnce(new Error("temporary one"))
      .mockRejectedValueOnce(new Error("temporary two"))
      .mockResolvedValue({ kind: "b64", b64: "", mime: "image/png" });
    const { app, scheduled } = await createApp(db, callImageEdit, { maxAttempts: 3 });
    await app.inject({ method: "POST", url: "/api/workflow/nail-try-ons/generate", payload: await generatePayload() });
    await Promise.all(scheduled);
    expect(callImageEdit).toHaveBeenCalledTimes(3);
    expect(db.tasks[0]).toMatchObject({ status: "completed", completedCount: 1 });
    await app.close();
  });
  it("refunds a fully failed task and cancels an active task exactly once", async () => {
    const failedDb = createPrismaMock([reference("hand", "hand-1")]);
    const failed = await createApp(
      failedDb,
      vi.fn<CallImageEdit>(async () => {
        throw new Error("upstream failed");
      }),
    );
    await failed.app.inject({ method: "POST", url: "/api/workflow/nail-try-ons/generate", payload: await generatePayload() });
    await Promise.all(failed.scheduled);
    expect(failedDb.tasks[0]).toMatchObject({ status: "failed", completedCount: 0, billingStatus: "refunded" });
    expect(failed.billing.refundResource).toHaveBeenCalledWith("nail-try-on:nail-try-on-request-1");
    await failed.app.close();

    const cancelledDb = createPrismaMock([reference("hand", "hand-1")]);
    const pendingEdit = vi.fn<CallImageEdit>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const cancelled = await createApp(cancelledDb, pendingEdit);
    await cancelled.app.inject({ method: "POST", url: "/api/workflow/nail-try-ons/generate", payload: await generatePayload() });
    const blockedDelete = await cancelled.app.inject({
      method: "DELETE",
      url: "/api/workflow/nail-try-ons/references/hand-1",
    });
    expect(blockedDelete.statusCode).toBe(409);
    const response = await cancelled.app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/tasks/nail-try-on-request-1/cancel",
    });
    expect(response.statusCode).toBe(200);
    await Promise.all(cancelled.scheduled);
    expect(cancelledDb.tasks[0]).toMatchObject({ status: "cancelled", cancelRequested: true, billingStatus: "refunded" });
    expect(cancelled.billing.refundResource).toHaveBeenCalledTimes(1);
    await cancelled.app.close();
  });
  it("recovers a persisted pending task on state read and settles it", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    db.tasks.push(persistedTask());
    const callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" }));
    const { app, billing, scheduled, objects } = await createApp(db, callImageEdit);
    objects.set(
      "workflow/nail-try-ons/masks/u1/nail-try-on-pending-1/0-stored.png",
      Buffer.from(await maskB64(), "base64"),
    );
    const response = await app.inject({ method: "GET", url: "/api/workflow/nail-try-ons/state" });
    expect(response.statusCode).toBe(200);
    await Promise.all(scheduled);
    expect(billing.reserveResource).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "nail-try-on:nail-try-on-pending-1", units: 1 }),
    );
    expect(callImageEdit.mock.calls[0]![0].mask).toMatchObject({ filename: "nail-mask.png" });
    expect(db.tasks[0]).toMatchObject({ status: "completed", billingStatus: "settled" });
    await app.close();
  });

  it("fails a stale in-flight task on state read without a persistent reaper", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    db.tasks.push(
      persistedTask({
        id: "task-stale",
        requestId: "nail-try-on-stale-1",
        status: "running",
        billingStatus: "reserved",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    );
    const callImageEdit = vi.fn<CallImageEdit>(async () => ({ kind: "b64" as const, b64: "", mime: "image/png" }));
    const { app, scheduled } = await createApp(db, callImageEdit);
    const response = await app.inject({ method: "GET", url: "/api/workflow/nail-try-ons/state" });
    expect(response.statusCode).toBe(200);
    await Promise.all(scheduled);
    expect(callImageEdit).not.toHaveBeenCalled();
    expect(db.tasks[0]).toMatchObject({ status: "failed", completedCount: 0 });
    expect(db.tasks[0]!.error).toContain("超时");
    await app.close();
  });
  it("deletes a terminal task and reclaims its outputs and mask object", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    const { app, scheduled, objects } = await createApp(db);
    await app.inject({ method: "POST", url: "/api/workflow/nail-try-ons/generate", payload: await generatePayload() });
    await Promise.all(scheduled);
    const maskKey = "workflow/nail-try-ons/masks/u1/nail-try-on-request-1/0-stored.png";
    const outputKey = "workflow/nail-try-ons/outputs/u1/nail-try-on-request-1/0-stored.png";
    expect(objects.has(maskKey)).toBe(true);
    expect(objects.has(outputKey)).toBe(true);
    const del = await app.inject({ method: "DELETE", url: "/api/workflow/nail-try-ons/tasks/nail-try-on-request-1" });
    expect(del.statusCode).toBe(200);
    expect(objects.has(maskKey)).toBe(false);
    expect(objects.has(outputKey)).toBe(false);
    expect(db.tasks).toHaveLength(0);
    await app.close();
  });

  it("rejects an unsupported model resolution before billing", async () => {
    const db = createPrismaMock([reference("hand", "hand-1")]);
    const { app, billing } = await createApp(db);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/nail-try-ons/generate",
      payload: await generatePayload({ model: "gpt-image-2", resolution: "4K" }),
    });
    expect(response.statusCode).toBe(400);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    await app.close();
  });
  it("returns the default model, consent version, and mask-aware model matrix", async () => {
    const db = createPrismaMock();
    const { app } = await createApp(db);
    const response = await app.inject({ method: "GET", url: "/api/workflow/nail-try-ons/options" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      model: "gpt-image-2",
      consentVersion: NAIL_TRY_ON_CONSENT_VERSION,
      aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
      resolutions: ["1K", "2K", "4K"],
      pricingByModel: {
        "doubao-seedream-5-0-260128": { "2K": 0, "4K": 0 },
        "gpt-image-2": { "1K": 0, "2K": 0 },
      },
    });
    const models = response.json().data.models as { value: string; supportsMask: boolean }[];
    expect(models.find((model) => model.value === "gpt-image-2")?.supportsMask).toBe(true);
    expect(models.find((model) => model.value === "doubao-seedream-5-0-260128")?.supportsMask).toBe(false);
    await app.close();
  });
});




