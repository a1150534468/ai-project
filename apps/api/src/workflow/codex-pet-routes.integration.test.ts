import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import Fastify from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CODEX_PET_PLANNED_IMAGE_CALL_LIMIT } from "./codex-pet-call-ledger.js";
import {
  CODEX_PET_RESOURCE_KEY,
  codexPetRoutes,
} from "./codex-pet-routes.js";

const prisma = getPrisma();
const enabled = Boolean(process.env.DATABASE_URL);
const cleanupUserIds: string[] = [];

afterAll(async () => {
  if (cleanupUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  await prisma.$disconnect();
});

describe.skipIf(!enabled)("Codex pet start route database integration", () => {
  it("acquires the real PostgreSQL advisory lock, charges once, and queues the run", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        uid: `pet-route-${suffix}`,
        username: `pet-route-${suffix}`,
        passwordHash: "test",
      },
    });
    cleanupUserIds.push(user.id);
    const project = await prisma.codexPetProject.create({
      data: {
        userId: user.id,
        name: "本地事务锁测试宠",
        prompt: "一只蓝色圆角机器人",
        stylePreset: "pixel",
        status: "draft",
      },
    });

    // 按次计费合同：启动只预留 14 次调用额度，实际张数由 Worker 结算。
    const chargeResource = vi.fn(async () => ({ charged: 200 }));
    const reserveResource = vi.fn(async () => ({ reserved: 200 * CODEX_PET_PLANNED_IMAGE_CALL_LIMIT }));
    const settleResource = vi.fn(async () => ({ settled: 200 }));
    const enqueueRun = vi.fn(async () => undefined);
    const app = Fastify({ logger: false });
    app.decorateRequest("userId", "");
    app.addHook("onRequest", async (request) => {
      const raw = request.headers["x-test-user"];
      (request as unknown as { userId: string }).userId = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
    });
    await app.register(codexPetRoutes, {
      prisma,
      billing: {
        chargeResource,
        reserveResource,
        settleResource,
        refundResource: vi.fn(async () => ({ success: true })),
        listResourcePrices: vi.fn(async () => ({
          data: [{
            resourceKey: CODEX_PET_RESOURCE_KEY,
            displayName: "Codex 桌宠",
            pricingType: "PER_UNIT" as const,
            rate: 200,
            perUnits: 1,
            enabled: true,
          }],
        })),
      },
      enqueueRun,
      enqueueProjectCleanup: vi.fn(async () => undefined),
      notifyRunEvent: vi.fn(async () => undefined),
      subscribeRunEvents: vi.fn(async () => undefined),
      validateReferenceAsset: vi.fn(async () => true),
      signingSecret: "test-signing-secret-that-is-long-enough",
      publicBaseUrl: "http://127.0.0.1:8090",
      assertVisualQaReady: () => undefined,
      assertImageReady: () => undefined,
    });

    try {
      const idempotencyKey = `start-${suffix}`;
      const response = await app.inject({
        method: "POST",
        url: `/api/workflow/codex-pets/projects/${project.id}/start`,
        headers: {
          "x-test-user": user.id,
          "idempotency-key": idempotencyKey,
        },
        payload: { idempotencyKey },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json() as {
        readonly success: boolean;
        readonly data: { readonly run: { readonly id: string; readonly status: string } };
      };
      expect(body.success).toBe(true);
      expect(body.data.run.status).toBe("queued");
      expect(chargeResource).not.toHaveBeenCalled();
      expect(reserveResource).toHaveBeenCalledTimes(1);
      expect(reserveResource).toHaveBeenCalledWith({
        operationId: `codex-pet:run:${body.data.run.id}:planned-images`,
        userId: user.id,
        resourceKey: CODEX_PET_RESOURCE_KEY,
        units: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
      });
      expect(enqueueRun).toHaveBeenCalledWith(body.data.run.id);

      const [storedRun, storedProject, queuedEvent] = await Promise.all([
        prisma.codexPetRun.findUnique({ where: { id: body.data.run.id } }),
        prisma.codexPetProject.findUnique({ where: { id: project.id } }),
        prisma.codexPetEvent.findFirst({ where: { runId: body.data.run.id, type: "run.queued" } }),
      ]);
      expect(storedRun).toMatchObject({
        userId: user.id,
        projectId: project.id,
        status: "queued",
        billingChargeStatus: "reserved",
        billingSettlementStatus: "reserved",
        billingReservedUnits: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        billingReservedPoints: 200 * CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
      });
      expect(storedProject).toMatchObject({ status: "queued", latestRunId: body.data.run.id });
      expect(queuedEvent).not.toBeNull();

      const replay = await app.inject({
        method: "POST",
        url: `/api/workflow/codex-pets/projects/${project.id}/start`,
        headers: {
          "x-test-user": user.id,
          "idempotency-key": idempotencyKey,
        },
        payload: { idempotencyKey },
      });
      expect(replay.statusCode).toBe(200);
      expect((replay.json() as { data: { run: { id: string } } }).data.run.id).toBe(body.data.run.id);
      expect(await prisma.codexPetRun.count({ where: { projectId: project.id } })).toBe(1);
      expect(reserveResource).toHaveBeenCalledTimes(1);
      expect(chargeResource).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
