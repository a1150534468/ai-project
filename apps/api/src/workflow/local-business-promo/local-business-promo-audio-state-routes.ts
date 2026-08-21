import type { FastifyInstance } from "fastify";
import {
  authUserId,
  findOwnedProject,
  serializeProjectAudioState,
} from "./local-business-promo-route-helpers.js";
import {
  projectParamsSchema,
  type LocalBusinessPromoRouteContext,
  updateAudioActiveSchema,
} from "./local-business-promo-route-types.js";

export function registerLocalBusinessPromoAudioStateRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  app.patch("/api/workflow/local-business-promos/projects/:projectId/audio/active", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    const parsed = updateAudioActiveSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (parsed.data.narrationAssetId) {
      const narration = await ctx.prisma.audioAsset.findFirst({
        where: { id: parsed.data.narrationAssetId, userId, projectId: project.id, kind: "narration" },
      });
      if (!narration) return reply.code(404).send({ error: "口播版本不存在" });
    }
    if (parsed.data.bgmAssetId) {
      const bgm = await ctx.prisma.audioAsset.findFirst({
        where: { id: parsed.data.bgmAssetId, userId, projectId: project.id, kind: "bgm" },
      });
      if (!bgm) return reply.code(404).send({ error: "背景音乐版本不存在" });
    }
    const nextProject = await ctx.prisma.localBusinessPromoProject.update({
      where: { id: project.id },
      data: {
        ...(Object.prototype.hasOwnProperty.call(parsed.data, "narrationAssetId") ? { activeNarrationAssetId: parsed.data.narrationAssetId ?? null } : {}),
        ...(Object.prototype.hasOwnProperty.call(parsed.data, "bgmAssetId") ? { activeBgmAssetId: parsed.data.bgmAssetId ?? null } : {}),
      },
    });
    return {
      success: true,
      data: {
        audio: await serializeProjectAudioState(ctx.prisma, userId, nextProject),
      },
    };
  });

  app.get("/api/workflow/local-business-promos/projects/:projectId/audio/state", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return {
      success: true,
      data: await serializeProjectAudioState(ctx.prisma, userId, project),
    };
  });
}
