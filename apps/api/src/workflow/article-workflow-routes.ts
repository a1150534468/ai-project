import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  articleWorkflowPlatformConfig,
  resolveArticleWorkflowMode,
  type ArticleWorkflowPlatform,
} from "@ai-assistant/article-workflow";
import { canRecoverArticleProject, DEFAULT_ARTICLE_MODEL, scheduledRunner, ARTICLE_HISTORY_LIMIT, type ArticleWorkflowBilling, type ArticleWorkflowRouteDeps } from "./article-workflow-shared.js";
import {
  articleWorkflowImageParamsSchema,
  articleWorkflowProjectParamsSchema,
  createArticleWorkflowProjectSchema,
  regenerateArticleWorkflowImageSchema,
  rewriteArticleWorkflowProjectSchema,
  updateArticleWorkflowProjectSchema,
} from "./article-workflow-schema.js";
import { resolveArticleWorkflowPricing } from "./article-workflow-pricing.js";
import { findOwnedArticleWorkflowProject, updateArticleWorkflowProjectState } from "./article-workflow-store.js";
import { applyArticleImageManifestToHtml, findArticleImageBySlot } from "./article-workflow-image-manifest.js";
import { assertArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";
import { generateArticleWorkflowImageAsset } from "./article-workflow-images.js";
import { runArticleWorkflowRewrite, runInitialArticleWorkflowGeneration } from "./article-workflow-runner.js";
import { jsonValue, readArticleWorkflowProject, serializeArticleWorkflowProject, serializeArticleWorkflowProjectSummary } from "./article-workflow-serializer.js";
import { authUserId, safeErrorMessage } from "./ecom-route-helpers.js";

export async function articleWorkflowRoutes(app: FastifyInstance, deps: ArticleWorkflowRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = (deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  })) as ArticleWorkflowBilling;
  const llm = deps.llm ?? createLlmClient(loadLlmConfig());
  const fetchFn = deps.fetchFn ?? fetch;
  const env = deps.env ?? process.env;
  const scheduleTask = deps.scheduleTask ?? scheduledRunner(app);
  const model = env.ARTICLE_WORKFLOW_MODEL?.trim() || env.LLM_DEFAULT_MODEL?.trim() || DEFAULT_ARTICLE_MODEL;

  app.get("/api/workflow/article-workflow/pricing", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    try {
      return { success: true, data: await resolveArticleWorkflowPricing(billing) };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "获取公众号图文计价失败" });
    }
  });

  app.post("/api/workflow/article-workflow", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = createArticleWorkflowProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    // 一次导入 = 一个批次 = 每平台一行，每行独立生成、独立扣费、独立失败
    const batchId = randomUUID();
    const created: { projectId: string; platform: ArticleWorkflowPlatform }[] = [];
    for (const platform of parsed.data.platforms) {
      const generationMode = resolveArticleWorkflowMode(platform, parsed.data.generationMode);
      const project = await prisma.articleWorkflowProject.create({
        data: {
          userId,
          platform,
          batchId,
          sourceFormat: parsed.data.sourceFormat,
          sourceText: parsed.data.sourceText,
          generationMode,
          title: "",
          summary: "",
          bodyHtml: "",
          captionText: "",
          tagsJson: jsonValue([]),
          imageManifestJson: jsonValue([]),
          status: "generating",
          progressStage: "queued",
          progressPercent: 0,
          progressMessage: "排队生成中",
          error: null,
        },
      });
      created.push({ projectId: project.id, platform });

      scheduleTask(() => runInitialArticleWorkflowGeneration({
        prisma,
        billing,
        llm,
        fetchFn,
        env,
        userId,
        projectId: project.id,
        sourceFormat: parsed.data.sourceFormat,
        sourceText: parsed.data.sourceText,
        generationMode,
        platform,
        model,
      }));
    }

    // projectId 保留首行，旧前端与既有用例不受影响
    return reply.code(201).send({
      success: true,
      data: { batchId, projects: created, projectId: created[0]!.projectId },
    });
  });

  app.get("/api/workflow/article-workflow/history", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const rows = await prisma.articleWorkflowProject.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: ARTICLE_HISTORY_LIMIT,
    });
    return { success: true, data: rows.map(serializeArticleWorkflowProjectSummary) };
  });

  app.get("/api/workflow/article-workflow/:id", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowProjectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: serializeArticleWorkflowProject(project) };
  });

  app.patch("/api/workflow/article-workflow/:id", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowProjectParamsSchema.safeParse(req.params);
    const parsed = updateArticleWorkflowProjectSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });

    const current = readArticleWorkflowProject(project);
    const guardedHtml = assertArticleWorkflowHtmlFragment({
      html: parsed.data.bodyHtml,
      expectedVisibleText: articleWorkflowVisibleTextFromHtml(parsed.data.bodyHtml),
    });
    const bodyHtml = applyArticleImageManifestToHtml(guardedHtml, current.imageManifest);
    const updated = await prisma.articleWorkflowProject.update({
      where: { id: project.id },
      data: {
        title: parsed.data.title.trim(),
        summary: parsed.data.summary.trim(),
        bodyHtml,
        status: "ready",
        progressStage: "ready",
        progressPercent: 100,
        progressMessage: "已保存修改",
        error: null,
      },
    });
    return { success: true, data: serializeArticleWorkflowProject(updated) };
  });

  app.post("/api/workflow/article-workflow/:id/rewrite", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowProjectParamsSchema.safeParse(req.params);
    const parsed = rewriteArticleWorkflowProjectSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (!canRecoverArticleProject(project.status)) return reply.code(409).send({ error: "项目尚未准备好改稿" });

    const generationMode = parsed.data.generationMode ?? (project.generationMode as "preserve-text" | "polish-text");
    await prisma.articleWorkflowProject.update({
      where: { id: project.id },
      data: {
        status: "revising",
        progressStage: "queued",
        progressPercent: 0,
        progressMessage: "排队改稿中",
        generationMode,
        error: null,
      },
    });

    scheduleTask(() => runArticleWorkflowRewrite({
      prisma,
      billing,
      llm,
      fetchFn,
      env,
      project: {
        ...project,
        generationMode,
      },
      instruction: parsed.data.instruction,
      generationMode,
      regenerateImages: parsed.data.regenerateImages,
      model,
    }));

    return { success: true, data: { projectId: project.id } };
  });

  app.post("/api/workflow/article-workflow/:id/images/:slot/regenerate", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowImageParamsSchema.safeParse(req.params);
    const parsed = regenerateArticleWorkflowImageSchema.safeParse(req.body ?? {});
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (!canRecoverArticleProject(project.status)) return reply.code(409).send({ error: "项目尚未准备好重生图片" });

    const current = readArticleWorkflowProject(project);
    const target = findArticleImageBySlot(current.imageManifest, params.data.slot);
    if (!target) return reply.code(400).send({ error: "图片槽位不存在" });

    await updateArticleWorkflowProjectState(prisma, project.id, {
      status: "revising",
      progressStage: "illustrating",
      progressPercent: 18,
      progressMessage: "正在重生图片",
      error: null,
    });

    try {
      const nextImage = await generateArticleWorkflowImageAsset({
        prisma,
        billing,
        fetchFn,
        env,
        userId,
        projectId: project.id,
        image: {
          ...target,
          prompt: parsed.data.promptOverride?.trim() || target.prompt,
        },
        platformConfig: articleWorkflowPlatformConfig(current.platform),
      });
      const nextManifest = current.imageManifest.map((image) => image.slot === target.slot ? nextImage : image);
      const nextHtml = applyArticleImageManifestToHtml(current.bodyHtml, nextManifest);
      const updated = await prisma.articleWorkflowProject.update({
        where: { id: project.id },
        data: {
          bodyHtml: nextHtml,
          imageManifestJson: jsonValue(nextManifest),
          status: "ready",
          progressStage: "ready",
          progressPercent: 100,
          progressMessage: "图片已更新",
          error: null,
        },
      });
      return { success: true, data: serializeArticleWorkflowProject(updated) };
    } catch (error) {
      await updateArticleWorkflowProjectState(prisma, project.id, {
        status: "failed",
        progressStage: "failed",
        progressPercent: 100,
        progressMessage: "图片重生失败",
        error: safeErrorMessage(error),
      }).catch(() => undefined);
      return reply.code(502).send({ error: safeErrorMessage(error) });
    }
  });
}
