import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import Fastify from "fastify";
import sharp from "sharp";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { portraitWorkflowRoutes } from "./portrait/index.js";
import { PORTRAIT_CONSENT_VERSION } from "./portrait/portrait-prompts.js";
import { tryOnWorkflowRoutes } from "./try-on/index.js";
import type { GeneratedImage } from "./_shared/image-service.js";

const prisma = getPrisma();
const userIds: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe.skipIf(!process.env.DATABASE_URL)("恢复的生图场景：真库生命周期，不依赖计费服务", () => {
  it.each(["portraits", "try-ons"] as const)("%s 上传、生成、取件、历史、幂等、隔离与删除", async (scene) => {
    vi.stubEnv("SESSION_SECRET", "restored-image-integration-secret-2026");
    vi.stubEnv("ARK_API_KEY", "local-test-not-a-real-key");
    vi.stubEnv("BILLING_BASE_URL", "");
    vi.stubEnv("BILLING_API_KEY", "");
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { uid: suffix, username: `image-qa-${suffix}`, passwordHash: "test" },
    });
    const other = await prisma.user.create({
      data: { uid: `${suffix}-other`, username: `other-${suffix}`, passwordHash: "test" },
    });
    userIds.push(user.id, other.id);
    const app = Fastify();
    app.decorateRequest("userId", "");
    app.addHook("onRequest", async (req) => {
      req.userId = String(req.headers["x-test-user"] ?? "");
    });
    const headers = { "x-test-user": user.id };
    const path = `/api/workflow/${scene}`;
    const objects = new Map<string, Buffer>();
    const jobs: Promise<void>[] = [];
    const output = await sharp({ create: { width: 1728, height: 2304, channels: 3, background: "#aabbcc" } })
      .png()
      .toBuffer();
    const callImageEdit = vi.fn(
      async (): Promise<GeneratedImage> => ({ kind: "b64", b64: output.toString("base64"), mime: "image/png" }),
    );
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("Unexpected network call in isolated generation test");
    });
    const deps = {
      prisma,
      callImageEdit,
      fetchFn,
      maxAttempts: 1,
      retryDelayMs: 1,
      scheduleTask: (work: () => Promise<void>) => {
        jobs.push(work());
      },
      storeImage: async (args: {
        image: GeneratedImage;
        namespace: string;
        userId: string;
        requestId: string;
        requestIndex: number;
        acl: "private";
      }) => {
        expect(args.acl).toBe("private");
        if (args.image.kind !== "b64") throw new Error("fixture must be inline");
        const key = `${args.namespace}/${args.userId}/${args.requestId}/${args.requestIndex}-${randomUUID()}`;
        objects.set(key, Buffer.from(args.image.b64, "base64"));
        return { originalUrl: "", thumbnailUrl: "", objectKey: key, mime: args.image.mime ?? "image/png" };
      },
      loadStoredImage: async (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error("Missing object");
        return bytes;
      },
      deleteStoredImage: async (key: string) => {
        objects.delete(key);
      },
      // Deliberately no billing dependency: exercise the production unmetered default.
    };
    try {
      if (scene === "portraits") await app.register(portraitWorkflowRoutes, deps);
      else await app.register(tryOnWorkflowRoutes, deps);
      await app.ready();
      expect((await app.inject({ method: "GET", url: `${path}/state` })).statusCode).toBe(401);
      const options = await app.inject({ method: "GET", url: `${path}/options`, headers });
      expect(options.statusCode).toBe(200);
      const input = await sharp({ create: { width: 32, height: 40, channels: 3, background: "white" } })
        .png()
        .toBuffer();
      const upload = await app.inject({
        method: "POST",
        url: `${path}/references`,
        headers,
        payload: {
          image: { b64: input.toString("base64"), mime: "image/png" },
          ...(scene === "try-ons" ? { kind: "garment_front" } : {}),
        },
      });
      expect(upload.statusCode, upload.body).toBe(200);
      const asset = upload.json().data.asset;
      const payload = {
        requestId: `qa-${suffix}`,
        model: "doubao-seedream-5-0-260128",
        aspectRatio: "3:4",
        resolution: "2K",
        count: 1,
        ...(scene === "portraits"
          ? {
              presetId: "business-elite",
              referenceAssetIds: [asset.id],
              authorizationAccepted: true,
              consentVersion: PORTRAIT_CONSENT_VERSION,
            }
          : { garmentFrontAssetId: asset.id, description: "synthetic fixture" }),
      };
      const denied = await app.inject({
        method: "POST",
        url: `${path}/generate`,
        headers: { "x-test-user": other.id },
        payload,
      });
      expect(denied.statusCode).toBe(404);
      const generated = await app.inject({ method: "POST", url: `${path}/generate`, headers, payload });
      expect(generated.statusCode, generated.body).toBe(202);
      await Promise.all(jobs);
      const state = await app.inject({ method: "GET", url: `${path}/state`, headers });
      const task = state.json().data.tasks[0];
      expect(task).toMatchObject({ status: "completed", completedCount: 1 });
      expect(task.outputs).toHaveLength(1);
      const download = await app.inject({ method: "GET", url: task.outputs[0].originalUrl });
      expect(download.statusCode, download.body).toBe(200);
      expect(download.rawPayload.equals(output)).toBe(true);
      const unsigned = new URL(task.outputs[0].originalUrl, "http://local.test").pathname;
      expect((await app.inject({ method: "GET", url: unsigned })).statusCode).toBe(400);
      const retry = await app.inject({ method: "POST", url: `${path}/generate`, headers, payload });
      expect(retry.statusCode).toBe(200);
      await Promise.all(jobs);
      expect(callImageEdit).toHaveBeenCalledTimes(1);
      expect(fetchFn).not.toHaveBeenCalled();
      const otherState = await app.inject({
        method: "GET",
        url: `${path}/state`,
        headers: { "x-test-user": other.id },
      });
      expect(otherState.json().data.tasks).toEqual([]);
      expect(
        (await app.inject({ method: "DELETE", url: `${path}/tasks/${payload.requestId}`, headers })).statusCode,
      ).toBe(200);
      expect((await app.inject({ method: "GET", url: `${path}/state`, headers })).json().data.tasks).toEqual([]);
    } finally {
      await Promise.allSettled(jobs);
      await app.close();
    }
  });
});
