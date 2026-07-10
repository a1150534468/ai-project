import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getPrisma, getRedis } from "@yc/db";
import { createBillingClient, InsufficientBalanceError } from "@yc/billing";
import { buildEcomPrompt, ECOM_PLATFORMS, ECOM_TEMPLATES, getEcomPlatform, getEcomTemplate } from "./ecom-prompts.js";
import { ecomMasterResourceKey, ecomSegmentResourceKey, ecomSizeForResolution } from "./ecom-resolution.js";
import { authUserId, buildSegmentRecord, ECOM_RESOURCE_KEYS, findCurrentWorkflow, findWorkflowOrReply, imageDataUrl, listRecentWorkflows, loadOwnedReferenceImages, loadReferenceImage, loadSerializedWorkflow, loadSerializedWorkflows, parseSegments, parseWorkflowProduct, readBillingClientEnv, RefundCompensationError, resolveLanguage, safeErrorMessage, serializeAsset } from "./ecom-route-helpers.js";
import { createRedisWorkflowMutationLocker, workflowCreateMutationKey, workflowMutationKey, WorkflowMutationConflictError } from "./ecom-route-mutation.js";
import { adoptMasterRequestSchema, imageBodySchema, masterRequestSchema, segmentParamsSchema, workflowParamsSchema, type EcomRouteDeps } from "./ecom-route-types.js";
import { resolveEcomPricing } from "./workflow-pricing.js";
import { callImageEdit as callImageEditService, callImageGeneration as callImageGenerationService, loadImageGenerationConfig as loadImageGenerationConfigService, retryUntilSuccess as retryUntilSuccessService, storeWorkflowImage as storeWorkflowImageService } from "./image-service.js";

const DEFAULT_SIZE = "1024x1024", DEFAULT_ECOM_MAX_ATTEMPTS = 2, REFERENCE_MODEL = "ecom_reference_upload", REFERENCE_PROMPT = "ecom_reference_upload";
type EcomWorkflowRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["ecomWorkflow"]["findFirst"]>>>;
type StoredWorkflowImage = Awaited<ReturnType<NonNullable<EcomRouteDeps["storeWorkflowImage"]>>>;

async function commitArtifact(args: {
  readonly prisma: ReturnType<typeof getPrisma>;
  readonly billing: NonNullable<EcomRouteDeps["billing"]>;
  readonly workflow: EcomWorkflowRow;
  readonly operationId: string;
  readonly resourceKey: string;
  readonly size: string;
  readonly prompt: string;
  readonly stored: StoredWorkflowImage;
  readonly updateWorkflow: (assetId: string, createdAt: Date) => Parameters<ReturnType<typeof getPrisma>["ecomWorkflow"]["update"]>[0]["data"];
}) {
  await args.billing.chargeResource({ operationId: args.operationId, userId: args.workflow.userId, resourceKey: args.resourceKey, units: 1 });
  try {
    return await args.prisma.$transaction(async (tx) => {
      const asset = await tx.imageAsset.create({
        data: {
          userId: args.workflow.userId,
          requestId: args.operationId,
          requestIndex: 0,
          prompt: args.prompt,
          model: REFERENCE_MODEL,
          size: args.size,
          originalUrl: args.stored.originalUrl,
          thumbnailUrl: args.stored.thumbnailUrl,
          objectKey: args.stored.objectKey,
          mime: args.stored.mime,
        },
      });
      const updated = await tx.ecomWorkflow.updateMany({
        where: { id: args.workflow.id, userId: args.workflow.userId, updatedAt: args.workflow.updatedAt },
        data: args.updateWorkflow(asset.id, asset.createdAt),
      });
      if (updated.count !== 1) throw new WorkflowMutationConflictError();
      const workflow = await tx.ecomWorkflow.findFirst({ where: { id: args.workflow.id, userId: args.workflow.userId } });
      if (!workflow) throw new Error("workflow not found");
      return { asset, workflow };
    });
  } catch (artifactError) {
    try {
      await args.billing.refundResource(args.operationId);
    } catch (refundError) {
      const detail = `${safeErrorMessage(artifactError)}；退款失败：${safeErrorMessage(refundError)}`;
      try {
        await args.prisma.ecomWorkflow.update({
          where: { id: args.workflow.id },
          data: {
            error: `扣费补偿失败，operationId=${args.operationId}，${detail}`,
            billingOperationIds: [...args.workflow.billingOperationIds, args.operationId],
          },
        });
      } catch (persistError) {
        throw new RefundCompensationError(args.operationId, `${detail}；补偿记录失败：${safeErrorMessage(persistError)}`);
      }
      throw new RefundCompensationError(args.operationId, detail);
    }
    throw artifactError;
  }
}

export async function ecomWorkflowRoutes(app: FastifyInstance, deps: EcomRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient(readBillingClientEnv());
  const fetchFn = deps.fetchFn ?? fetch;
  const callImageGeneration = deps.callImageGeneration ?? callImageGenerationService;
  const callImageEdit = deps.callImageEdit ?? callImageEditService;
  const retryUntilSuccess = deps.retryUntilSuccess ?? retryUntilSuccessService;
  const storeWorkflowImage = deps.storeWorkflowImage ?? storeWorkflowImageService;
  const loadImageGenerationConfig = deps.loadImageGenerationConfig ?? loadImageGenerationConfigService;
  const workflowMutationLocker = deps.workflowMutationLocker ?? createRedisWorkflowMutationLocker(getRedis());
  const retryDelayMs = deps.retryDelayMs ?? 1_000, maxAttempts = deps.maxAttempts ?? DEFAULT_ECOM_MAX_ATTEMPTS;
  const replyBillingFailure = (reply: FastifyReply, error: unknown, fallback: string) => error instanceof InsufficientBalanceError
    ? reply.code(402).send({ error: "积分不足，请充值" })
    : error instanceof RefundCompensationError
      ? reply.code(502).send({ error: safeErrorMessage(error) })
      : reply.code(502).send({ error: fallback });
  const replyWorkflowMutationFailure = async (args: {
    readonly reply: FastifyReply;
    readonly workflow: EcomWorkflowRow;
    readonly failedStage: "master_failed" | "segment_failed" | "stitch_failed";
    readonly error: unknown;
    readonly fallback: string;
  }) => {
    if (args.error instanceof WorkflowMutationConflictError) return args.reply.code(409).send({ error: safeErrorMessage(args.error) });
    await prisma.ecomWorkflow.update({ where: { id: args.workflow.id }, data: { stage: args.failedStage, error: safeErrorMessage(args.error) } });
    return replyBillingFailure(args.reply, args.error, args.fallback);
  };
  const markWorkflowStage = (workflow: EcomWorkflowRow, stage: string) =>
    prisma.ecomWorkflow.update({ where: { id: workflow.id }, data: { stage, error: null } });

  async function generateMaster(workflow: EcomWorkflowRow) {
    const product = parseWorkflowProduct(workflow.product);
    const prompt = buildEcomPrompt({ platformId: workflow.platform, templateId: workflow.template, kind: "master", ...product });
    const operationId = `ecom-master:${workflow.id}:${randomUUID()}`;
    const size = ecomSizeForResolution(workflow.resolution);
    const referenceImages = workflow.referenceAssetIds.length > 0 ? await loadOwnedReferenceImages(prisma, workflow.userId, workflow.referenceAssetIds, fetchFn) : null;
    const image = await retryUntilSuccess(
      () => referenceImages
        ? callImageEdit({ config: loadImageGenerationConfig(), prompt, referenceImages, fetchFn, size })
        : callImageGeneration({ config: loadImageGenerationConfig(), prompt, size, fetchFn }),
      { retryDelayMs, maxAttempts },
    );
    const stored = await storeWorkflowImage({ image, userId: workflow.userId, requestId: operationId, requestIndex: 0, fetchFn });
    return commitArtifact({
      prisma,
      billing,
      workflow,
      operationId,
      resourceKey: ecomMasterResourceKey(workflow.resolution),
      size,
      prompt,
      stored,
      updateWorkflow: (assetId) => ({
        masterAssetId: assetId,
        stage: "master_ready",
        error: null,
        billingOperationIds: [...workflow.billingOperationIds, operationId],
      }),
    });
  }

  async function generateSegment(workflow: EcomWorkflowRow, index: number, stageAfterSuccess = "segments_ready") {
    const product = parseWorkflowProduct(workflow.product);
    const segments = parseSegments(workflow.segments);
    const previous = index === 0 ? null : segments.find((item) => item.index === index - 1) ?? null;
    const masterId = workflow.masterAssetId;
    if (!masterId || (index > 0 && !previous)) throw new Error("missing segment references");
    const ids = [masterId, previous?.assetId].filter((value): value is string => Boolean(value));
    const prompt = buildEcomPrompt({ platformId: workflow.platform, templateId: workflow.template, kind: "segment", segmentIndex: index, segmentCount: workflow.segmentCount, ...product });
    const referenceImages = await loadOwnedReferenceImages(prisma, workflow.userId, ids, fetchFn);
    const size = ecomSizeForResolution(workflow.resolution);
    const image = await retryUntilSuccess(() => callImageEdit({ config: loadImageGenerationConfig(), prompt, referenceImages, fetchFn, size }), { retryDelayMs, maxAttempts });
    const operationId = `ecom-segment:${workflow.id}:${index}:${randomUUID()}`;
    const stored = await storeWorkflowImage({ image, userId: workflow.userId, requestId: operationId, requestIndex: 0, fetchFn });
    const committed = await commitArtifact({
      prisma,
      billing,
      workflow,
      operationId,
      resourceKey: ecomSegmentResourceKey(workflow.resolution),
      size,
      prompt,
      stored,
      updateWorkflow: (assetId, createdAt) => ({
        segments: [...segments.filter((item) => item.index !== index), buildSegmentRecord({ index, assetId, originalUrl: stored.originalUrl, thumbnailUrl: stored.thumbnailUrl, prompt, createdAt })].sort((a, b) => a.index - b.index),
        stage: stageAfterSuccess,
        error: null,
        billingOperationIds: [...workflow.billingOperationIds, operationId],
      }),
    });
    return committed.workflow;
  }

  app.get("/api/workflow/ecom/options", async () => ({ success: true, data: { platforms: ECOM_PLATFORMS, templates: ECOM_TEMPLATES } }));

  app.get("/api/workflow/ecom/pricing", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    try {
      return { success: true, data: await resolveEcomPricing(billing) };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "获取电商长图计价失败" });
    }
  });
  app.get("/api/workflow/ecom/current", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const workflow = await findCurrentWorkflow(prisma, userId);
    return { success: true, data: { workflow: workflow ? await loadSerializedWorkflow(prisma, workflow) : null } };
  });
  app.get("/api/workflow/ecom/history", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    return { success: true, data: { workflows: await loadSerializedWorkflows(prisma, await listRecentWorkflows(prisma, userId)) } };
  });

  app.post("/api/workflow/ecom/references", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const parsed = imageBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const row = await prisma.imageAsset.create({
      data: {
        userId,
        requestId: `ecom-reference:${randomUUID()}`,
        requestIndex: 0,
        prompt: REFERENCE_PROMPT,
        model: REFERENCE_MODEL,
        size: DEFAULT_SIZE,
        originalUrl: imageDataUrl(parsed.data.image),
        thumbnailUrl: imageDataUrl(parsed.data.image),
        objectKey: null,
        mime: parsed.data.image.mime?.startsWith("image/") ? parsed.data.image.mime : "image/png",
      },
    });
    return { success: true, data: { asset: serializeAsset(row) } };
  });

  app.post("/api/workflow/ecom/master", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const parsed = masterRequestSchema.safeParse(req.body);
    if (!parsed.success || !getEcomPlatform(parsed.data.platformId) || !getEcomTemplate(parsed.data.templateId)) return reply.code(400).send({ error: "参数不合法" });
    const referenceAssets = parsed.data.referenceAssetIds.length > 0 ? await prisma.imageAsset.findMany({ where: { userId, id: { in: parsed.data.referenceAssetIds } } }) : [];
    if (referenceAssets.length !== parsed.data.referenceAssetIds.length) return reply.code(400).send({ error: "引用图不存在" });
    try {
      return await workflowMutationLocker.withLock(workflowCreateMutationKey(userId), async () => {
        const workflow = await prisma.ecomWorkflow.create({ data: { userId, platform: parsed.data.platformId, language: resolveLanguage(parsed.data.platformId), template: parsed.data.templateId, resolution: parsed.data.resolution, segmentCount: parsed.data.segmentCount, product: parsed.data.product, referenceAssetIds: parsed.data.referenceAssetIds, masterAssetId: null, segments: [], stitchedAssetId: null, stage: "master_running", error: null, billingOperationIds: [] } });
        try {
          const committed = await generateMaster(workflow);
          return { success: true, data: { workflow: await loadSerializedWorkflow(prisma, committed.workflow) } };
        } catch (error) {
          return replyWorkflowMutationFailure({ reply, workflow, failedStage: "master_failed", error, fallback: "主图生成失败" });
        }
      });
    } catch (error) {
      if (error instanceof WorkflowMutationConflictError) return reply.code(409).send({ error: safeErrorMessage(error) });
      return replyBillingFailure(reply, error, "主图生成失败");
    }
  });

  app.post("/api/workflow/ecom/adopt-master", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const parsed = adoptMasterRequestSchema.safeParse(req.body);
    if (!parsed.success || !getEcomPlatform(parsed.data.platformId) || !getEcomTemplate(parsed.data.templateId)) return reply.code(400).send({ error: "参数不合法" });
    const master = await prisma.imageAsset.findFirst({ where: { id: parsed.data.masterAssetId, userId } });
    if (!master) return reply.code(400).send({ error: "所选主图不存在" });
    const referenceAssets = parsed.data.referenceAssetIds.length > 0 ? await prisma.imageAsset.findMany({ where: { userId, id: { in: parsed.data.referenceAssetIds } } }) : [];
    if (referenceAssets.length !== parsed.data.referenceAssetIds.length) return reply.code(400).send({ error: "引用图不存在" });
    try {
      return await workflowMutationLocker.withLock(workflowCreateMutationKey(userId), async () => {
        const workflow = await prisma.ecomWorkflow.create({ data: { userId, platform: parsed.data.platformId, language: resolveLanguage(parsed.data.platformId), template: parsed.data.templateId, resolution: parsed.data.resolution, segmentCount: parsed.data.segmentCount, product: parsed.data.product, referenceAssetIds: parsed.data.referenceAssetIds, masterAssetId: parsed.data.masterAssetId, segments: [], stitchedAssetId: null, stage: "master_ready", error: null, billingOperationIds: [] } });
        return { success: true, data: { workflow: await loadSerializedWorkflow(prisma, workflow) } };
      });
    } catch (error) {
      if (error instanceof WorkflowMutationConflictError) return reply.code(409).send({ error: safeErrorMessage(error) });
      return reply.code(502).send({ error: "选用主图作为母版失败" });
    }
  });

  app.post("/api/workflow/ecom/:workflowId/master/retry", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const params = workflowParamsSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const workflow = await findWorkflowOrReply(prisma, params.data.workflowId, userId, reply);
    if (!workflow) return;
    try {
      const committed = await workflowMutationLocker.withLock(workflowMutationKey(workflow.id), async () => generateMaster(await markWorkflowStage(workflow, "master_running")));
      return { success: true, data: { workflow: await loadSerializedWorkflow(prisma, committed.workflow) } };
    } catch (error) {
      return replyWorkflowMutationFailure({ reply, workflow, failedStage: "master_failed", error, fallback: "主图生成失败" });
    }
  });

  app.post("/api/workflow/ecom/:workflowId/segments/confirm", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const params = workflowParamsSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    let workflow = await findWorkflowOrReply(prisma, params.data.workflowId, userId, reply);
    if (!workflow) return;
    try {
      const baseWorkflow = workflow;
      workflow = await workflowMutationLocker.withLock(workflowMutationKey(baseWorkflow.id), async () => {
        let currentWorkflow: EcomWorkflowRow = await markWorkflowStage(baseWorkflow, "segments_running");
        const missingIndexes = Array.from({ length: currentWorkflow.segmentCount }, (_, i) => i).filter((index) => !parseSegments(currentWorkflow.segments).find((item) => item.index === index));
        if (missingIndexes.length === 0) {
          return prisma.ecomWorkflow.update({ where: { id: currentWorkflow.id }, data: { stage: "segments_ready", error: null } });
        }
        for (const index of missingIndexes) {
          currentWorkflow = await generateSegment(currentWorkflow, index, index === missingIndexes.at(-1) ? "segments_ready" : "segments_running");
        }
        return currentWorkflow;
      });
      return { success: true, data: { workflow: await loadSerializedWorkflow(prisma, workflow) } };
    } catch (error) {
      return replyWorkflowMutationFailure({ reply, workflow, failedStage: "segment_failed", error, fallback: "分段生成失败" });
    }
  });

  app.post("/api/workflow/ecom/:workflowId/segments/:index/redraw", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const params = segmentParamsSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const workflow = await findWorkflowOrReply(prisma, params.data.workflowId, userId, reply);
    if (!workflow) return;
    try {
      const updated = await workflowMutationLocker.withLock(workflowMutationKey(workflow.id), async () => generateSegment(await markWorkflowStage(workflow, "segments_running"), params.data.index));
      return { success: true, data: { workflow: await loadSerializedWorkflow(prisma, updated) } };
    } catch (error) {
      return replyWorkflowMutationFailure({ reply, workflow, failedStage: "segment_failed", error, fallback: "分段重绘失败" });
    }
  });

  app.post("/api/workflow/ecom/:workflowId/stitch", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const params = workflowParamsSchema.safeParse(req.params);
    const body = imageBodySchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const workflow = await findWorkflowOrReply(prisma, params.data.workflowId, userId, reply);
    if (!workflow) return;
    const segments = parseSegments(workflow.segments);
    const canStitch = (workflow.stage === "segments_ready" || workflow.stage === "stitched")
      && Array.from({ length: workflow.segmentCount }, (_, i) => i).every((index) => segments.some((segment) => segment.index === index && segment.originalUrl.trim()));
    if (!canStitch) return reply.code(409).send({ error: "分段图齐全后才可以拼接保存" });
    try {
      const committed = await workflowMutationLocker.withLock(workflowMutationKey(workflow.id), async () => {
        const operationId = `ecom-stitch:${workflow.id}:${randomUUID()}`;
        const stored = await storeWorkflowImage({ image: { kind: "b64", b64: body.data.image.b64, mime: body.data.image.mime ?? "image/png" }, userId, requestId: operationId, requestIndex: 0, fetchFn });
        return commitArtifact({
          prisma,
          billing,
          workflow,
          operationId,
          resourceKey: ECOM_RESOURCE_KEYS.stitch,
          size: ecomSizeForResolution(workflow.resolution),
          prompt: "ecom_stitch",
          stored,
          updateWorkflow: (assetId) => ({ stitchedAssetId: assetId, stage: "stitched", error: null, billingOperationIds: [...workflow.billingOperationIds, operationId] }),
        });
      });
      return { success: true, data: { workflow: await loadSerializedWorkflow(prisma, committed.workflow) } };
    } catch (error) {
      return replyWorkflowMutationFailure({ reply, workflow, failedStage: "stitch_failed", error, fallback: "拼接保存失败" });
    }
  });

  // 同源代理：分段原图存在 OSS（跨 origin），浏览器直接 fetch 会被 CORS 拦成 Failed to fetch，
  // 由后端服务端拉取后同源回传，供浏览器拼接长图使用。URL 由 workflowId+index 定位，不接受任意地址，无 SSRF。
  app.get("/api/workflow/ecom/:workflowId/segments/:index/blob", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const params = segmentParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const workflow = await findWorkflowOrReply(prisma, params.data.workflowId, userId, reply);
    if (!workflow) return;
    const segment = parseSegments(workflow.segments).find((item) => item.index === params.data.index && item.originalUrl.trim());
    if (!segment) return reply.code(404).send({ error: "分段图片不存在" });
    const asset = await prisma.imageAsset.findFirst({ where: { id: segment.assetId, userId } });
    if (!asset) return reply.code(404).send({ error: "分段图片不存在" });
    try {
      const inline = await loadReferenceImage(asset, fetchFn);
      const mime = inline.mime?.startsWith("image/") ? inline.mime : "image/png";
      return reply.header("Cache-Control", "private, max-age=300").type(mime).send(Buffer.from(inline.b64, "base64"));
    } catch {
      return reply.code(502).send({ error: "分段图片下载失败" });
    }
  });
}
