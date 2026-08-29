import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { CODEX_PET_PLANNED_IMAGE_CALL_LIMIT } from "./codex-pet-call-ledger.js";
import { safeDiagnostic } from "./codex-pet-route-helpers.js";
import type { CodexPetRouteContext } from "./codex-pet-route-context.js";

export function registerCodexPetCatalogRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const { codexPetModelOptions, price } = ctx;

  app.get("/api/workflow/codex-pets/pricing", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    try {
      const pricing = await price();
      return {
        success: true,
        data: {
          pricing: {
            ...pricing,
            plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
            includedBaseCandidates: 2,
          },
        },
      };
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error) }, "failed to load Codex pet pricing");
      return reply.code(502).send({ error: "获取桌宠套餐价格失败" });
    }
  });

  app.get("/api/workflow/codex-pets/models", { preHandler: requireUser }, async (request, reply) => {
    try {
      return { success: true, data: await codexPetModelOptions() };
    } catch (error) {
      app.log.warn({ error: safeDiagnostic(error) }, "failed to load Codex pet model catalog");
      return reply.code(503).send({ error: "模型目录暂不可用，请稍后重试" });
    }
  });
}
