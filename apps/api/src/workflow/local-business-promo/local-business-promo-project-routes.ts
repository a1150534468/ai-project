import type { FastifyInstance } from "fastify";
import {
  buildOptionsPayload,
  createDefaultSettings,
  createEmptyBrief,
  createEmptyMaterials,
  formatProjectTitle,
  localBusinessPromoBriefSchema,
  localBusinessPromoSettingsSchema,
  requiredBriefFieldsMissing,
  LOCAL_BUSINESS_PROMO_DEFAULT_TITLE,
  type LocalBusinessPromoBrief,
  type LocalBusinessPromoMaterials,
  type LocalBusinessPromoSettings,
} from "./local-business-promo-core.js";
import { authUserId, findOwnedProject, nextProjectStatus, projectStateFromRow, reconcileProjectRunState, safeErrorMessage, serializeProjectSummary } from "./local-business-promo-route-helpers.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import {
  PROJECT_KEEP_LIMIT,
  createProjectSchema,
  projectParamsSchema,
  type LocalBusinessPromoRouteContext,
  updateProjectSchema,
  updateScriptSchema,
} from "./local-business-promo-route-types.js";
import { sanitizeLocalBusinessPromoMaterials } from "./local-business-promo-material-security.js";

export function registerLocalBusinessPromoProjectRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  app.get("/api/workflow/local-business-promos/options", async () => ({
    success: true,
    data: buildOptionsPayload(),
  }));

  app.get("/api/workflow/local-business-promos/projects", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const rows = await ctx.prisma.localBusinessPromoProject.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: PROJECT_KEEP_LIMIT,
    });
    const consistentRows = await Promise.all(rows.map((row) => reconcileProjectRunState(ctx.prisma, userId, row)));
    return {
      success: true,
      data: consistentRows.map(serializeProjectSummary),
    };
  });

  app.post("/api/workflow/local-business-promos/projects", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const brief = createEmptyBrief();
    const row = await ctx.prisma.localBusinessPromoProject.create({
      data: {
        userId,
        title: parsed.data.title.trim() || LOCAL_BUSINESS_PROMO_DEFAULT_TITLE,
        brief,
        materials: createEmptyMaterials(),
        settings: createDefaultSettings(),
        scriptDraft: "",
        latestRunId: null,
        status: "draft",
      },
    });
    return reply.code(201).send({ success: true, data: { project: projectStateFromRow(row) } });
  });

  app.get("/api/workflow/local-business-promos/projects/:projectId", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = projectParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, parsed.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: { project: projectStateFromRow(project) } };
  });

  app.patch("/api/workflow/local-business-promos/projects/:projectId", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const current = projectStateFromRow(project);
    const brief: LocalBusinessPromoBrief = parsed.data.brief
      ? localBusinessPromoBriefSchema.parse({ ...current.brief, ...parsed.data.brief })
      : current.brief;
    let materials: LocalBusinessPromoMaterials = parsed.data.materials ?? current.materials;
    if (parsed.data.materials) {
      try {
        materials = sanitizeLocalBusinessPromoMaterials(userId, parsed.data.materials);
      } catch (error) {
        return reply.code(400).send({ error: safeErrorMessage(error) });
      }
    }
    const settings: LocalBusinessPromoSettings = parsed.data.settings
      ? localBusinessPromoSettingsSchema.parse({ ...current.settings, ...parsed.data.settings })
      : current.settings;
    const title = formatProjectTitle(parsed.data.title ?? project.title, brief);
    const updated = await ctx.prisma.localBusinessPromoProject.update({
      where: { id: project.id },
      data: {
        title,
        brief,
        materials,
        settings,
        status: nextProjectStatus(project),
      },
    });
    return { success: true, data: { project: projectStateFromRow(updated) } };
  });

  app.post("/api/workflow/local-business-promos/projects/:projectId/script/generate", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const state = projectStateFromRow(project);
    const missing = requiredBriefFieldsMissing(state.brief);
    if (missing.length > 0) return reply.code(400).send({ error: `请先完善资料：${missing.join("、")}` });
    try {
      const scriptDraft = await ctx.generateScript({
        userId,
        brief: state.brief,
        settings: state.settings,
      });
      const updated = await ctx.prisma.localBusinessPromoProject.update({
        where: { id: project.id },
        data: {
          title: formatProjectTitle(project.title, state.brief),
          brief: state.brief,
          scriptDraft,
          status: nextProjectStatus(project, { scriptDraft }),
        },
      });
      return { success: true, data: { project: projectStateFromRow(updated) } };
    } catch (error) {
      return reply.code(502).send({ error: errorMessageOrFallback(error, "口播文案生成失败") });
    }
  });

  app.patch("/api/workflow/local-business-promos/projects/:projectId/script", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    const parsed = updateScriptSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const updated = await ctx.prisma.localBusinessPromoProject.update({
      where: { id: project.id },
      data: {
        scriptDraft: parsed.data.scriptDraft,
        status: nextProjectStatus(project, { scriptDraft: parsed.data.scriptDraft }),
      },
    });
    return { success: true, data: { project: projectStateFromRow(updated) } };
  });
}
