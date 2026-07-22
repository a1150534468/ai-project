import { Buffer } from "node:buffer";
import Fastify from "fastify";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { portraitWorkflowRoutes } from "./portrait-routes.js";
import { PORTRAIT_CONSENT_VERSION } from "./portrait-prompts.js";

type ReferenceRow = {
  id: string; userId: string; objectKey: string; mime: string; width: number; height: number; sizeBytes: number;
  expiresAt: Date | null; deletedAt: Date | null; createdAt: Date; updatedAt: Date;
};
type OutputRow = {
  id: string; taskId: string; userId: string; requestIndex: number; objectKey: string; mime: string;
  width: number; height: number; sizeBytes: number; createdAt: Date;
};
type TaskRow = {
  id: string; userId: string; requestId: string; model: string; presetId: string; aspectRatio: string; resolution: string;
  count: number; prompt: string; effectivePrompt: string; options: unknown; referenceAssetIds: string[]; status: string;
  completedCount: number; error: string | null; consentVersion: string; billingOperationId: string; billingResourceKey: string;
  billingReservedUnits: number; billingSettledUnits: number; billingStatus: string; cancelRequested: boolean;
  startedAt: Date; completedAt: Date | null; createdAt: Date; updatedAt: Date;
};

function createPrismaMock(seed?: { references?: ReferenceRow[]; tasks?: TaskRow[]; outputs?: OutputRow[] }) {
  const references = seed?.references ?? [];
  const tasks = seed?.tasks ?? [];
  const outputs = seed?.outputs ?? [];
  const withOutputs = (task: TaskRow) => ({ ...task, outputs: outputs.filter((output) => output.taskId === task.id) });
  const matchesTask = (task: TaskRow, where: Record<string, any> = {}) => {
    if (where.id && task.id !== where.id) return false;
    if (where.userId && task.userId !== where.userId) return false;
    if (where.requestId && task.requestId !== where.requestId) return false;
    if (typeof where.status === "string" && task.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(task.status)) return false;
    if (where.referenceAssetIds?.has && !task.referenceAssetIds.includes(where.referenceAssetIds.has)) return false;
    return true;
  };
  const prisma = {
    portraitReferenceAsset: {
      findMany: vi.fn(async (args: { where?: Record<string, any>; orderBy?: unknown; take?: number }) => {
        const where = args.where ?? {};
        let rows = references.filter((row) => {
          if (where.userId && row.userId !== where.userId) return false;
          if (where.id?.in && !where.id.in.includes(row.id)) return false;
          if (where.deletedAt === null && row.deletedAt !== null) return false;
          if (where.expiresAt?.lte && (!row.expiresAt || row.expiresAt > where.expiresAt.lte)) return false;
          return true;
        });
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return args.take ? rows.slice(0, args.take) : rows;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => references.find((row) => row.id === args.where.id) ?? null),
      findFirst: vi.fn(async (args: { where: Record<string, any> }) => references.find((row) =>
        (!args.where.id || row.id === args.where.id) &&
        (!args.where.userId || row.userId === args.where.userId) &&
        (args.where.deletedAt !== null || row.deletedAt === null)
      ) ?? null),
      create: vi.fn(async (args: { data: Omit<ReferenceRow, "id" | "createdAt" | "updatedAt" | "deletedAt"> & { deletedAt?: Date | null } }) => {
        const row: ReferenceRow = { ...args.data, id: `ref-${references.length + 1}`, deletedAt: args.data.deletedAt ?? null, createdAt: new Date(), updatedAt: new Date() };
        references.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<ReferenceRow> }) => {
        const row = references.find((item) => item.id === args.where.id);
        if (!row) throw new Error("reference not found");
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      }),
      updateMany: vi.fn(async (args: { where: Record<string, any>; data: Partial<ReferenceRow> }) => {
        let count = 0;
        references.forEach((row) => {
          if (args.where.id?.in && !args.where.id.in.includes(row.id)) return;
          if (args.where.deletedAt === null && row.deletedAt !== null) return;
          Object.assign(row, args.data, { updatedAt: new Date() });
          count += 1;
        });
        return { count };
      }),
    },
    portraitTask: {
      findFirst: vi.fn(async (args: { where?: Record<string, any>; include?: unknown; orderBy?: unknown; select?: unknown }) => {
        const row = tasks.find((task) => matchesTask(task, args.where));
        if (!row) return null;
        return args.select ? { id: row.id } : args.include ? withOutputs(row) : row;
      }),
      findUnique: vi.fn(async (args: { where: { id?: string; requestId?: string }; include?: unknown; select?: unknown }) => {
        const row = tasks.find((task) => (!args.where.id || task.id === args.where.id) && (!args.where.requestId || task.requestId === args.where.requestId));
        if (!row) return null;
        return args.select ? { id: row.id } : args.include ? withOutputs(row) : row;
      }),
      findMany: vi.fn(async (args: { where?: Record<string, any>; include?: unknown; orderBy?: unknown; take?: number }) => {
        let rows = tasks.filter((task) => matchesTask(task, args.where));
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (args.take) rows = rows.slice(0, args.take);
        return args.include ? rows.map(withOutputs) : rows;
      }),
      create: vi.fn(async (args: { data: Omit<TaskRow, "id" | "startedAt" | "completedAt" | "createdAt" | "updatedAt" | "cancelRequested" | "completedCount" | "error">; include?: unknown }) => {
        const row: TaskRow = {
          ...args.data,
          id: `task-${tasks.length + 1}`,
          completedCount: 0,
          error: null,
          cancelRequested: false,
          startedAt: new Date(),
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        tasks.push(row);
        return args.include ? withOutputs(row) : row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<TaskRow>; include?: unknown }) => {
        const row = tasks.find((task) => task.id === args.where.id);
        if (!row) throw new Error("task not found");
        Object.assign(row, args.data, { updatedAt: new Date() });
        return args.include ? withOutputs(row) : row;
      }),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const index = tasks.findIndex((task) => task.id === args.where.id);
        if (index < 0) throw new Error("task not found");
        const [row] = tasks.splice(index, 1);
        for (let i = outputs.length - 1; i >= 0; i -= 1) if (outputs[i]?.taskId === row!.id) outputs.splice(i, 1);
        return row;
      }),
    },
    portraitOutput: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => outputs.find((row) => row.id === args.where.id) ?? null),
      upsert: vi.fn(async (args: { where: { taskId_requestIndex: { taskId: string; requestIndex: number } }; create: Omit<OutputRow, "id" | "createdAt"> }) => {
        const existing = outputs.find((row) => row.taskId === args.where.taskId_requestIndex.taskId && row.requestIndex === args.where.taskId_requestIndex.requestIndex);
        if (existing) return existing;
        const row: OutputRow = { ...args.create, id: `output-${outputs.length + 1}`, createdAt: new Date() };
        outputs.push(row);
        return row;
      }),
    },
  };
  return { prisma, references, tasks, outputs };
}

function reference(userId = "u1", id = "ref-1"): ReferenceRow {
  return {
    id,
    userId,
    objectKey: `workflow/portraits/references/${userId}/seed/0-${id}.jpg`,
    mime: "image/jpeg",
    width: 800,
    height: 1000,
    sizeBytes: 1000,
    expiresAt: new Date(Date.now() + 86_400_000),
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function pendingTaskRow(): TaskRow {
  const now = new Date();
  return {
    id: "task-pending",
    userId: "u1",
    requestId: "portrait-pending-1",
    model: "doubao-seedream-5-0-260128",
    presetId: "business",
    aspectRatio: "3:4",
    resolution: "2K",
    count: 1,
    prompt: "",
    effectivePrompt: "严格保持人物身份一致",
    options: {},
    referenceAssetIds: ["ref-1"],
    status: "pending",
    completedCount: 0,
    error: null,
    consentVersion: PORTRAIT_CONSENT_VERSION,
    billingOperationId: "portrait:portrait-pending-1",
    billingResourceKey: "image_generation_2k",
    billingReservedUnits: 0,
    billingSettledUnits: 0,
    billingStatus: "pending",
    cancelRequested: false,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

const validPayload = {
  requestId: "portrait-request-1",
  presetId: "business",
  aspectRatio: "3:4",
  resolution: "2K",
  count: 1,
  referenceAssetIds: ["ref-1"],
  options: { scene: "办公室", outfit: "深色西装", extraPrompt: "自然微笑" },
  authorizationAccepted: true,
  consentVersion: PORTRAIT_CONSENT_VERSION,
};

async function createApp(args: {
  db: ReturnType<typeof createPrismaMock>;
  authenticated?: boolean;
  callImageEdit?: (args: any) => Promise<any>;
  scheduled?: Promise<void>[];
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => { (req as unknown as { userId: string }).userId = args.authenticated === false ? "" : "u1"; });
  const objects = new Map<string, Buffer>();
  const refBytes = await sharp({ create: { width: 40, height: 50, channels: 3, background: "#807060" } }).jpeg().toBuffer();
  args.db.references.forEach((row) => objects.set(row.objectKey, refBytes));
  const outputBytes = await sharp({ create: { width: 48, height: 64, channels: 3, background: "#406080" } }).png().toBuffer();
  const billing = {
    reserveResource: vi.fn(async () => ({ reserved: 20 })),
    settleResource: vi.fn(async () => ({ settled: 20 })),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({ data: [] })),
  };
  const storeImage = vi.fn(async (storeArgs: any) => {
    const kind = storeArgs.namespace.endsWith("references") ? "references" : "outputs";
    const key = `${storeArgs.namespace}/${storeArgs.userId}/${storeArgs.requestId}/${storeArgs.requestIndex}-stored.${kind === "references" ? "jpg" : "png"}`;
    const bytes = kind === "references" ? Buffer.from(storeArgs.image.b64, "base64") : outputBytes;
    objects.set(key, bytes);
    return { originalUrl: "", thumbnailUrl: "", mime: kind === "references" ? "image/jpeg" : "image/png", objectKey: key };
  });
  const scheduled = args.scheduled ?? [];
  await app.register(portraitWorkflowRoutes, {
    prisma: args.db.prisma as unknown as PrismaClient,
    billing,
    fetchFn: vi.fn() as unknown as typeof fetch,
    scheduleTask: (work: () => Promise<void>) => { scheduled.push(work()); },
    retryDelayMs: 1,
    maxAttempts: 1,
    storeImage,
    loadStoredImage: async (key: string) => {
      const value = objects.get(key);
      if (!value) throw new Error("missing object");
      return value;
    },
    deleteStoredImage: async (key: string) => { objects.delete(key); },
    callImageEdit: args.callImageEdit ?? vi.fn(async () => ({ kind: "b64", b64: outputBytes.toString("base64"), mime: "image/png" })),
  });
  await app.ready();
  return { app, billing, storeImage, scheduled, objects };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "portrait-test-secret-123456789";
  process.env.ARK_API_KEY = "ark-test-key";
});

describe("portrait workflow routes", () => {
  it("requires authentication and explicit likeness authorization", async () => {
    const db = createPrismaMock({ references: [reference()] });
    const unauthenticated = await createApp({ db, authenticated: false });
    expect((await unauthenticated.app.inject({ method: "GET", url: "/api/workflow/portraits/options" })).statusCode).toBe(401);
    await unauthenticated.app.close();

    const authenticated = await createApp({ db });
    const response = await authenticated.app.inject({
      method: "POST",
      url: "/api/workflow/portraits/generate",
      payload: { ...validPayload, authorizationAccepted: false },
    });
    expect(response.statusCode).toBe(400);
    expect(authenticated.billing.reserveResource).not.toHaveBeenCalled();
    await authenticated.app.close();
  });

  it("normalizes uploads and stores portrait references privately", async () => {
    const db = createPrismaMock();
    const { app, storeImage } = await createApp({ db });
    const source = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#ffccaa" } }).png().toBuffer();
    const response = await app.inject({ method: "POST", url: "/api/workflow/portraits/references", payload: { image: { b64: source.toString("base64"), mime: "image/png" } } });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset).toMatchObject({ mime: "image/jpeg", width: 32, height: 24 });
    expect(response.json().data.asset).not.toHaveProperty("objectKey");
    expect(storeImage).toHaveBeenCalledWith(expect.objectContaining({ acl: "private", namespace: "workflow/portraits/references" }));
    const storedImage = storeImage.mock.calls[0]?.[0].image;
    expect(storedImage.kind).toBe("b64");
    expect((await sharp(Buffer.from(storedImage.b64, "base64")).metadata()).format).toBe("jpeg");
    await app.close();
  });

  it("reserves points, runs Seedream with references, and settles successful units", async () => {
    const db = createPrismaMock({ references: [reference()] });
    const callImageEdit = vi.fn(async () => ({ kind: "b64" as const, b64: Buffer.from("result").toString("base64"), mime: "image/png" }));
    const { app, billing, scheduled } = await createApp({ db, callImageEdit });
    const response = await app.inject({ method: "POST", url: "/api/workflow/portraits/generate", payload: { ...validPayload, count: 2 } });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);

    expect(billing.reserveResource).toHaveBeenCalledWith({ operationId: "portrait:portrait-request-1", userId: "u1", resourceKey: "image_generation_2k", units: 2 });
    expect(billing.settleResource).toHaveBeenCalledWith({ operationId: "portrait:portrait-request-1", resourceKey: "image_generation_2k", units: 2 });
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(callImageEdit).toHaveBeenCalledTimes(2);
    expect(callImageEdit).toHaveBeenCalledWith(expect.objectContaining({ size: "1728x2304", prompt: expect.stringContaining("严格保持人物身份一致") }));
    expect(db.tasks[0]).toMatchObject({ status: "completed", completedCount: 2, billingStatus: "settled", billingSettledUnits: 2 });
    expect(db.outputs).toHaveLength(2);
    await app.close();
  });

  it("refunds a fully failed generation and keeps another user's references inaccessible", async () => {
    const db = createPrismaMock({ references: [reference("u2", "ref-other"), reference()] });
    const { app, billing, scheduled } = await createApp({ db, callImageEdit: vi.fn(async () => { throw new Error("upstream failed"); }) });
    const other = await app.inject({ method: "POST", url: "/api/workflow/portraits/generate", payload: { ...validPayload, requestId: "portrait-request-other", referenceAssetIds: ["ref-other"] } });
    expect(other.statusCode).toBe(404);

    const response = await app.inject({ method: "POST", url: "/api/workflow/portraits/generate", payload: validPayload });
    expect(response.statusCode).toBe(202);
    await Promise.all(scheduled);
    expect(db.tasks[0]).toMatchObject({ status: "failed", completedCount: 0, billingStatus: "refunded" });
    expect(billing.refundResource).toHaveBeenCalledWith("portrait:portrait-request-1");
    expect(billing.settleResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("cancels an active task, refunds it, and protects its reference from deletion", async () => {
    const db = createPrismaMock({ references: [reference()] });
    const callImageEdit = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const { app, billing, scheduled } = await createApp({ db, callImageEdit });
    await app.inject({ method: "POST", url: "/api/workflow/portraits/generate", payload: validPayload });
    const blockedDelete = await app.inject({ method: "DELETE", url: "/api/workflow/portraits/references/ref-1" });
    expect(blockedDelete.statusCode).toBe(409);
    const cancelled = await app.inject({ method: "POST", url: "/api/workflow/portraits/tasks/portrait-request-1/cancel" });
    expect(cancelled.statusCode).toBe(200);
    await Promise.all(scheduled);
    expect(db.tasks[0]).toMatchObject({ status: "cancelled", cancelRequested: true, billingStatus: "refunded" });
    expect(billing.refundResource).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("re-reserves a persisted pending task before restart recovery generates it", async () => {
    const db = createPrismaMock({ references: [reference()], tasks: [pendingTaskRow()] });
    const { app, billing, scheduled } = await createApp({ db });
    const response = await app.inject({ method: "GET", url: "/api/workflow/portraits/state" });
    expect(response.statusCode).toBe(200);
    await Promise.all(scheduled);
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: "portrait:portrait-pending-1",
      userId: "u1",
      resourceKey: "image_generation_2k",
      units: 1,
    });
    expect(db.tasks[0]).toMatchObject({ status: "completed", billingStatus: "settled", completedCount: 1 });
    await app.close();
  });
});
