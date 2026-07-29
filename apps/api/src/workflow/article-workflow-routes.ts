import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  articleWorkflowPlatformConfig,
  resolveArticleWorkflowMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { canRecoverArticleProject, canSaveArticleProject, DEFAULT_ARTICLE_MODEL, scheduledRunner, ARTICLE_HISTORY_LIMIT, type ArticleWorkflowBilling, type ArticleWorkflowRouteDeps } from "./article-workflow-shared.js";
import { getObject, loadS3Config, makeS3 } from "../storage/s3.js";
import {
  articleWorkflowBatchParamsSchema,
  articleWorkflowImageBlobParamsSchema,
  articleWorkflowImageBlobQuerySchema,
  articleWorkflowImageParamsSchema,
  articleWorkflowProjectParamsSchema,
  createArticleWorkflowProjectSchema,
  regenerateArticleWorkflowImageSchema,
  rewriteArticleWorkflowProjectSchema,
  updateArticleWorkflowCaptionProjectSchema,
  updateArticleWorkflowProjectSchema,
} from "./article-workflow-schema.js";
import { articleWorkflowCaptionSummary } from "./article-workflow-caption.js";
import { resolveArticleWorkflowPricing } from "./article-workflow-pricing.js";
import { findOwnedArticleWorkflowProject, updateArticleWorkflowProjectState } from "./article-workflow-store.js";
import { applyArticleImageManifestToHtml, findArticleImageBySlot } from "./article-workflow-image-manifest.js";
import { assertArticleWorkflowBodyNotDestroyed, assertArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";
import { generateArticleWorkflowImageAsset } from "./article-workflow-images.js";
import {
  articleWorkflowImageBlobSignatureValid,
  articleWorkflowStableBodyHtml,
} from "./article-workflow-image-url.js";
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
  const loadImageBlob = deps.loadImageBlob ?? ((objectKey: string) => getObject(makeS3(loadS3Config(env)), objectKey));
  const model = env.ARTICLE_WORKFLOW_MODEL?.trim() || env.LLM_DEFAULT_MODEL?.trim() || DEFAULT_ARTICLE_MODEL;

  app.get("/api/workflow/article-workflow/pricing", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    try {
      return { success: true, data: await resolveArticleWorkflowPricing(billing) };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "获取图文计价失败" });
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

  /**
   * 配图取图：正文里的 `<img src>` 指到这里，而不是内嵌 base64。
   *
   * 两种鉴权，任一成立即可：
   * - 短期签名（出参时现签，见 `serializeArticleWorkflowProject`）——页面里的 `<img>`
   *   带不上 `Authorization` 头，只能靠地址自身证明身份；
   * - 会话 + 资产归属校验——给带得上头的调用方（脚本、一键复制前的预取）。
   *
   * 库里存的始终是不带签名的稳定地址：正文要落库，签名会过期。
   * 注册在 GET /:id 之前，否则 `images` 会被当成项目 id。
   */
  app.get("/api/workflow/article-workflow/images/:assetId/blob", async (req, reply) => {
    const params = articleWorkflowImageBlobParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const query = articleWorkflowImageBlobQuerySchema.safeParse(req.query ?? {});
    const signed = query.success && query.data.exp && query.data.sig
      ? articleWorkflowImageBlobSignatureValid({
        assetId: params.data.assetId,
        expiresAtMs: Number(query.data.exp),
        signature: query.data.sig,
        env,
      })
      : false;

    let userId: string | undefined;
    if (!signed) {
      userId = authUserId(req as { userId?: string }, reply) ?? undefined;
      if (!userId) return;
    }
    const asset = await prisma.imageAsset.findFirst({
      // 签名已经证明这张图是我们自己发出去的，不再按 userId 过滤
      where: userId ? { id: params.data.assetId, userId } : { id: params.data.assetId },
      select: { objectKey: true, mime: true },
    });
    if (!asset?.objectKey) return reply.code(404).send({ error: "配图不存在" });
    try {
      const bytes = await loadImageBlob(asset.objectKey);
      return reply
        .header("Cache-Control", "private, max-age=86400")
        .header("X-Content-Type-Options", "nosniff")
        .type(asset.mime.startsWith("image/") ? asset.mime : "image/png")
        .send(bytes);
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "配图加载失败" });
    }
  });

  // 必须注册在 GET /:id 之前，否则 batch 会被当成项目 id
  app.get("/api/workflow/article-workflow/batch/:batchId", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowBatchParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const rows = await prisma.articleWorkflowProject.findMany({
      where: { userId, batchId: params.data.batchId },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) return reply.code(404).send({ error: "批次不存在" });
    return {
      success: true,
      data: { batchId: params.data.batchId, projects: rows.map((row) => serializeArticleWorkflowProject(row, env)) },
    };
  });

  app.get("/api/workflow/article-workflow/:id", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowProjectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: serializeArticleWorkflowProject(project, env) };
  });

  app.patch("/api/workflow/article-workflow/:id", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowProjectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });

    // 失败/生成中的行不接受保存：否则前端自动保存会把空编辑器写成 ready，冲掉失败原因
    if (!canSaveArticleProject(project.status)) {
      return reply.code(409).send({ error: "项目尚未生成成功，无法保存" });
    }

    const current = readArticleWorkflowProject(project);
    // 校验形状由项目所属平台决定，caption 项目不接受 bodyHtml
    if (articleWorkflowPlatformConfig(current.platform).outputKind === "caption") {
      const parsedCaption = updateArticleWorkflowCaptionProjectSchema.safeParse(req.body);
      if (!parsedCaption.success) return reply.code(400).send({ error: "参数不合法" });
      const updated = await prisma.articleWorkflowProject.update({
        where: { id: project.id },
        data: {
          title: parsedCaption.data.title,
          summary: parsedCaption.data.summary?.trim()
            ?? articleWorkflowCaptionSummary(parsedCaption.data.captionText),
          captionText: parsedCaption.data.captionText,
          tagsJson: jsonValue(parsedCaption.data.tags),
          status: "ready",
          progressStage: "ready",
          progressPercent: 100,
          progressMessage: "已保存修改",
          error: null,
        },
      });
      return { success: true, data: serializeArticleWorkflowProject(updated, env) };
    }

    const parsed = updateArticleWorkflowProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    // 先跟库里的旧正文比，拦住整体销毁；再走形状校验。
    // 顺序很重要：形状校验的 expectedVisibleText 取自请求自身，对「被清空」是无感的。
    try {
      assertArticleWorkflowBodyNotDestroyed({
        nextHtml: parsed.data.bodyHtml,
        currentHtml: current.bodyHtml,
      });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "保存被拒绝";
      return reply.code(422).send({ error: message });
    }
    const guardedHtml = assertArticleWorkflowHtmlFragment({
      html: parsed.data.bodyHtml,
      expectedVisibleText: articleWorkflowVisibleTextFromHtml(parsed.data.bodyHtml),
    });
    // 落库前把出参时现签的短期地址还原成稳定地址，否则存进去的是一批会过期的死链。
    // 配图区随后会按 manifest 整段重建，这一步管的是重建覆盖不到的残留。
    const bodyHtml = applyArticleImageManifestToHtml(
      articleWorkflowStableBodyHtml(guardedHtml),
      current.imageManifest,
    );
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
    return { success: true, data: serializeArticleWorkflowProject(updated, env) };
  });

  // 用户点击重试：只面向 failed 行，拿库里存着的 sourceText 原样重跑首轮生成。
  // 与 rewrite 分开——rewrite 要求已有成品可改，重试面对的恰恰是没有成品的那一行。
  app.post("/api/workflow/article-workflow/:id/retry", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowProjectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (project.status !== "failed") return reply.code(409).send({ error: "只有生成失败的图文可以重试" });

    const platform = project.platform as ArticleWorkflowPlatform;
    const generationMode = resolveArticleWorkflowMode(
      platform,
      project.generationMode as "preserve-text" | "polish-text",
    );
    await prisma.articleWorkflowProject.update({
      where: { id: project.id },
      data: {
        status: "generating",
        progressStage: "queued",
        progressPercent: 0,
        progressMessage: "排队重试中",
        error: null,
      },
    });

    scheduleTask(() => runInitialArticleWorkflowGeneration({
      prisma,
      billing,
      llm,
      fetchFn,
      env,
      userId,
      projectId: project.id,
      sourceFormat: project.sourceFormat as ArticleWorkflowSourceFormat,
      sourceText: project.sourceText,
      generationMode,
      platform,
      model,
    }));

    return { success: true, data: { projectId: project.id } };
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

    // 平台不支持的模式在落库前裁定，避免库里存着 runner 不会执行的模式
    const generationMode = resolveArticleWorkflowMode(
      project.platform as ArticleWorkflowPlatform,
      parsed.data.generationMode ?? (project.generationMode as "preserve-text" | "polish-text"),
    );
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
    const platformConfig = articleWorkflowPlatformConfig(current.platform);
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
        platformConfig,
      });
      const nextManifest = current.imageManifest.map((image) => image.slot === target.slot ? nextImage : image);
      // caption 平台没有正文 HTML，只更新 manifest
      const nextHtml = platformConfig.outputKind === "caption"
        ? undefined
        : applyArticleImageManifestToHtml(current.bodyHtml, nextManifest);
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
      return { success: true, data: serializeArticleWorkflowProject(updated, env) };
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
