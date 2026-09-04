import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { safeDiagnostic } from "./codex-pet-route-helpers.js";
import type { CodexPetRouteContext } from "./codex-pet-route-context.js";

export function registerCodexPetCatalogRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const { codexPetModelOptions } = ctx;

  app.get("/api/workflow/codex-pets/models", { preHandler: requireUser }, async (request, reply) => {
    try {
      return { success: true, data: await codexPetModelOptions() };
    } catch (error) {
      app.log.warn({ error: safeDiagnostic(error) }, "failed to load Codex pet model catalog");
      return reply.code(503).send({ error: "模型目录暂不可用，请稍后重试" });
    }
  });
}
