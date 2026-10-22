/**
 * sticker 路由层回归测试：接 workflow 骨架（route-context + requireUser + zod）后，
 * 用假 context 断言鉴权与状态分支，不再需要真 DB / 真 S3 / 真模型。
 */
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createStickerRouteContext } from "./sticker-route-context.js";
import { registerStickerTaskRoutes } from "./sticker-task-routes.js";
import { registerStickerUploadRoutes } from "./sticker-upload-routes.js";

interface FakePack {
  id: string;
  userId: string;
  requestId: string;
  name: string;
  characterPrompt: string;
  style: string;
  referenceObjectKey: string | null;
  baseImageRequestId: string | null;
  presetKeys: string[];
  status: string;
  completedCount: number;
  failedCount: number;
  executionToken: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makePack(overrides: Partial<FakePack> = {}): FakePack {
  return {
    id: "pack-1",
    userId: "user-1",
    requestId: "sticker_req1",
    name: "测试包",
    characterPrompt: "一只猫",
    style: "cute",
    referenceObjectKey: null,
    baseImageRequestId: null,
    presetKeys: ["happy"],
    status: "queued",
    completedCount: 0,
    failedCount: 0,
    executionToken: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeFakePrisma(packs: FakePack[]) {
  return {
    stickerPack: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const pack = makePack({ id: `pack-${packs.length + 1}`, ...(data as Partial<FakePack>) });
        packs.push(pack);
        return pack;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        packs.find((p) => p.id === where.id && p.userId === where.userId) ?? null),
      findMany: vi.fn(async () => packs),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const pack = packs.find(
          (p) => p.id === where.id && p.userId === where.userId && p.status === where.status,
        );
        if (!pack) return { count: 0 };
        Object.assign(pack, data);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    imageAsset: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
  };
}

const BOUNDARY = "sticker-test-boundary";

function uploadPayload(content: Buffer, mimetype = "image/png"): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="ref.png"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function makeApp(packs: FakePack[]) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = (req.headers["x-test-user"] as string | undefined) ?? "";
  });
  // 与 server-foundation 一致地放大 fileSize 上限，否则 busboy 先截断、走不到 handler 的 413
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });
  const startPack = vi.fn();
  const storeReference = vi.fn(async () => undefined);
  const context = createStickerRouteContext(app, {
    prisma: makeFakePrisma(packs) as never,
    startPack,
    storeReference,
  });
  registerStickerTaskRoutes(context);
  registerStickerUploadRoutes(context);
  await app.ready();
  return { app, startPack, storeReference };
}

const AUTH = { "x-test-user": "user-1" };

describe("sticker 路由鉴权（requireUser）", () => {
  it("未登录一律 401", async () => {
    const { app } = await makeApp([]);
    for (const url of ["/api/workflow/sticker/presets", "/api/workflow/sticker/packs"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
    const created = await app.inject({ method: "POST", url: "/api/workflow/sticker/packs", payload: {} });
    expect(created.statusCode).toBe(401);
    const upload = await app.inject({
      method: "POST",
      url: "/api/workflow/sticker/reference-upload",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: uploadPayload(Buffer.from("x")),
    });
    expect(upload.statusCode).toBe(401);
    await app.close();
  });
});

describe("sticker 创建校验（zod）", () => {
  it("无描述无参考图 → 400；描述超 500 字 → 400；他人参考图 key → 400", async () => {
    const { app } = await makeApp([]);
    const empty = await app.inject({ method: "POST", url: "/api/workflow/sticker/packs", headers: AUTH, payload: {} });
    expect(empty.statusCode).toBe(400);
    const tooLong = await app.inject({
      method: "POST",
      url: "/api/workflow/sticker/packs",
      headers: AUTH,
      payload: { characterPrompt: "x".repeat(501) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toContain("500");
    const foreign = await app.inject({
      method: "POST",
      url: "/api/workflow/sticker/packs",
      headers: AUTH,
      payload: { referenceObjectKey: "workflow/stickers/user-2/reference-a.png" },
    });
    expect(foreign.statusCode).toBe(400);
    await app.close();
  });

  it("合法创建 → 201 且 presetKeys 默认全选", async () => {
    const packs: FakePack[] = [];
    const { app } = await makeApp(packs);
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow/sticker/packs",
      headers: AUTH,
      payload: { characterPrompt: "一只橘猫" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pack.status).toBe("queued");
    expect(res.json().pack.presetKeys.length).toBeGreaterThan(1);
    await app.close();
  });
});

describe("sticker 状态分支（409）", () => {
  it("run 非 queued 的 pack → 409 且不调度；queued → 200 且调度一次", async () => {
    const running = makePack({ id: "pack-run", status: "running" });
    const queued = makePack({ id: "pack-queued", status: "queued" });
    const { app, startPack } = await makeApp([running, queued]);
    const conflict = await app.inject({ method: "POST", url: "/api/workflow/sticker/packs/pack-run/run", headers: AUTH });
    expect(conflict.statusCode).toBe(409);
    expect(startPack).not.toHaveBeenCalled();
    const ok = await app.inject({ method: "POST", url: "/api/workflow/sticker/packs/pack-queued/run", headers: AUTH });
    expect(ok.statusCode).toBe(200);
    expect(startPack).toHaveBeenCalledTimes(1);
    expect(startPack).toHaveBeenCalledWith("pack-queued");
    await app.close();
  });

  it("retry 非 failed → 409；删除进行中的 pack → 409", async () => {
    const running = makePack({ id: "pack-run", status: "running" });
    const { app } = await makeApp([running]);
    const retry = await app.inject({ method: "POST", url: "/api/workflow/sticker/packs/pack-run/retry", headers: AUTH });
    expect(retry.statusCode).toBe(409);
    const del = await app.inject({ method: "DELETE", url: "/api/workflow/sticker/packs/pack-run", headers: AUTH });
    expect(del.statusCode).toBe(409);
    await app.close();
  });

  it("别人的 pack → 404", async () => {
    const other = makePack({ id: "pack-other", userId: "user-2" });
    const { app } = await makeApp([other]);
    const res = await app.inject({ method: "GET", url: "/api/workflow/sticker/packs/pack-other", headers: AUTH });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("sticker 参考图上传", () => {
  it("超过 10MB → 413", async () => {
    const { app, storeReference } = await makeApp([]);
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow/sticker/reference-upload",
      headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: uploadPayload(Buffer.alloc(10 * 1024 * 1024 + 1)),
    });
    expect(res.statusCode).toBe(413);
    expect(storeReference).not.toHaveBeenCalled();
    await app.close();
  });

  it("合法 PNG → 200 并经 context.storeReference 落存储", async () => {
    const { app, storeReference } = await makeApp([]);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow/sticker/reference-upload",
      headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: uploadPayload(png),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().referenceObjectKey).toMatch(/^workflow\/stickers\/user-1\/reference-.+\.png$/);
    expect(storeReference).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
