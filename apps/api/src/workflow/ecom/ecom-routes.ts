import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { buildEcomPrompt, ECOM_PLATFORMS, ECOM_TEMPLATES, getEcomPlatform, getEcomTemplate } from "./ecom-prompts.js";
import { ecomMasterResourceKey, ecomModelSizeError, ecomSegmentResourceKey, ecomSizeForResolution, normalizeEcomResolution, type EcomResolution } from "./ecom-resolution.js";
import { deliveredImageResolution, pixelsFromSize } from "../_shared/image-delivered-tier.js";
import { authUserId } from "../_shared/route-auth.js";
import { loadOwnedReferenceImages, loadReferenceImage } from "../_shared/reference-image.js";
import { appendBillingOperationId, buildSegmentRecord, ecomImageReservationTtlSeconds, findCurrentWorkflow, findWorkflowOrReply, listRecentWorkflows, loadSerializedWorkflow, loadSerializedWorkflows, parseSegments, parseWorkflowProduct, readBillingClientEnv, RefundCompensationError, resolveLanguage, safeErrorMessage, serializeAsset } from "./ecom-route-helpers.js";
import { createRedisWorkflowMutationLocker, workflowCreateMutationKey, workflowMutationKey, WorkflowMutationConflictError } from "./ecom-route-mutation.js";
import { adoptMasterRequestSchema, imageBodySchema, masterRequestSchema, parsePricingModelQuery, segmentParamsSchema, workflowParamsSchema, type EcomRouteDeps } from "./ecom-route-types.js";
import { ecomMasterPriceFallback, ecomSegmentPriceFallback, ECOM_RESOURCE_KEYS, resolveImageChargeRow, resolveImagePricingMatrix, type WorkflowResourcePriceRow } from "../_shared/workflow-pricing.js";
import { callImageEdit as callImageEditService, callImageGeneration as callImageGenerationService, IMAGE_REFERENCE_MAX_BYTES, loadImageGenerationConfig as loadImageGenerationConfigService, loadImageGenerationConfigForModel as loadImageGenerationConfigForModelService, retryUntilSuccess as retryUntilSuccessService, storeWorkflowImage as storeWorkflowImageService } from "../_shared/image-service.js";

const DEFAULT_SIZE = "1024x1024", DEFAULT_ECOM_MAX_ATTEMPTS = 2, REFERENCE_MODEL = "ecom_reference_upload", REFERENCE_PROMPT = "ecom_reference_upload";
// 拼接为纯浏览器合成，不再扣点；保留字段形状供前端兼容展示。
const ECOM_STITCH_FREE_PRICE = {
  resourceKey: ECOM_RESOURCE_KEYS.stitch,
  displayName: "电商长图拼接",
  pricingType: "PER_CALL",
  rate: 0,
  perUnits: 1,
  enabled: true,
} as const;
type EcomWorkflowRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["ecomWorkflow"]["findFirst"]>>>;
type StoredWorkflowImage = Awaited<ReturnType<NonNullable<EcomRouteDeps["storeWorkflowImage"]>>>;
type CommittedArtifact = Awaited<ReturnType<typeof commitArtifact>>;

async function commitArtifact(args: {
  readonly prisma: ReturnType<typeof getPrisma>;
  readonly workflow: EcomWorkflowRow;
  readonly operationId: string;
  readonly size: string;
  readonly prompt: string;
  readonly model: string;
  readonly stored: StoredWorkflowImage;
  readonly updateWorkflow: (assetId: string, createdAt: Date) => Parameters<ReturnType<typeof getPrisma>["ecomWorkflow"]["update"]>[0]["data"];
}) {
  return args.prisma.$transaction(async (tx) => {
    const asset = await tx.imageAsset.create({
      data: {
        userId: args.workflow.userId,
        requestId: args.operationId,
        requestIndex: 0,
        prompt: args.prompt,
        model: args.model,
        size: args.size,
        originalUrl: args.stored.originalUrl,
        thumbnailUrl: args.stored.thumbnailUrl,
        objectKey: args.stored.objectKey,
        mime: args.stored.mime,
        width: args.stored.width ?? null,
        height: args.stored.height ?? null,
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
}

/**
 * 先把 operationId 原子落库（CAS push）、再扣费，失败即退款；扣费/生成始终使用落库后的最新 workflow 行。
 *
 * 计费客户端支持 reserve/settle 时走"请求档预留 → 交付档结算"：中转上游常只认宽高比、
 * 忽略绝对像素，请求 2K 实际只交付 1K 时按请求档收就是多收一倍。settle 传交付档 key，
 * 差额由计费服务自动退回。老客户端（只有 chargeResource）保持原语义不变。
 */
async function runChargedOperation<T>(args: {
  readonly prisma: ReturnType<typeof getPrisma>;
  readonly billing: NonNullable<EcomRouteDeps["billing"]>;
  readonly workflow: EcomWorkflowRow;
  readonly operationPrefix: string;
  readonly resourceKey: string;
  /**
   * 预留有效期（秒）。必填而不是可选：漏传就退回 billing 的 10 分钟全局兜底，
   * 而单张图的最坏耗时是它的三倍多，预留会在出图途中被按 actual=0 关账，
   * 之后 settle 静默返回 0——下面那个 onSettleError 也不会响，因为 settle 本身没报错。
   */
  readonly reservationTtlSeconds: number;
  /** 结算档位 key：由实际交付像素决定，返回 null 表示按请求档结算。 */
  readonly settleKeyFor?: (result: T) => Promise<string | null>;
  readonly onSettleError?: (error: unknown, operationId: string) => void;
  readonly work: (workflow: EcomWorkflowRow, operationId: string) => Promise<T>;
}): Promise<T> {
  const { operationId, row: workflow } = await appendBillingOperationId<EcomWorkflowRow>({
    row: args.workflow,
    prefix: args.operationPrefix,
    updateMany: ({ updatedAt, operationId: id }) => args.prisma.ecomWorkflow.updateMany({
      where: { id: args.workflow.id, userId: args.workflow.userId, updatedAt },
      data: { billingOperationIds: { push: id } },
    }),
    reload: () => args.prisma.ecomWorkflow.findFirst({ where: { id: args.workflow.id, userId: args.workflow.userId } }) as Promise<EcomWorkflowRow | null>,
  });
  const { reserveResource, settleResource } = args.billing;
  const canReserve = Boolean(reserveResource && settleResource);
  if (canReserve) {
    await reserveResource!({
      operationId,
      userId: workflow.userId,
      resourceKey: args.resourceKey,
      units: 1,
      reservationTtlSeconds: args.reservationTtlSeconds,
    });
  } else {
    await args.billing.chargeResource({ operationId, userId: workflow.userId, resourceKey: args.resourceKey, units: 1 });
  }
  try {
    const result = await args.work(workflow, operationId);
    if (canReserve) {
      // 结算失败不能把已生成的图判为失败退款——图已交付，退款等于白送。留痕给对账兜底。
      try {
        const settleKey = (await args.settleKeyFor?.(result)) ?? args.resourceKey;
        await settleResource!({ operationId, resourceKey: settleKey, units: 1 });
      } catch (settleError) {
        args.onSettleError?.(settleError, operationId);
      }
    }
    return result;
  } catch (operationError) {
    try {
      await args.billing.refundResource(operationId);
    } catch (refundError) {
      const detail = `${safeErrorMessage(operationError)}；退款失败：${safeErrorMessage(refundError)}`;
      try {
        await args.prisma.ecomWorkflow.update({
          where: { id: workflow.id },
          data: { error: `扣费补偿失败，operationId=${operationId}，${detail}` },
        });
      } catch (persistError) {
        throw new RefundCompensationError(operationId, `${detail}；补偿记录失败：${safeErrorMessage(persistError)}`);
      }
      throw new RefundCompensationError(operationId, detail);
    }
    throw operationError;
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
  const loadImageGenerationConfigForModel = deps.loadImageGenerationConfigForModel ?? loadImageGenerationConfigForModelService;
  // 任务落库了 model 后，全部后续生成（分段/重绘/重试）都锁定在同一模型上。
  const loadConfigForWorkflow = (model: string | null | undefined) =>
    model ? loadImageGenerationConfigForModel(model) : loadImageGenerationConfig();
  // 拉不到管理台费率时回落通用 key，但必须留痕，否则扣费 key 悄悄降级无从排查。
  const listPriceRows = async (): Promise<readonly WorkflowResourcePriceRow[]> => {
    if (!billing.listResourcePrices) return [];
    try {
      return (await billing.listResourcePrices()).data ?? [];
    } catch (error) {
      app.log.warn({ error: safeErrorMessage(error) }, "ecom listResourcePrices failed, falling back to generic image pricing keys");
      return [];
    }
  };
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

  /**
   * 按实际交付像素定结算档位。交付像素拿不到（url 直存等）时返回 null，按请求档结算。
   * 只会往下降，不会往上升——请求 1K 上游多给不能反过来多收。
   */
  const settleKeyForAsset = async (args: {
    readonly asset: { readonly width: number | null; readonly height: number | null };
    readonly workflow: EcomWorkflowRow;
    readonly dedicatedKey: (resolution: string) => string;
    readonly fallback: (resolution: EcomResolution) => WorkflowResourcePriceRow;
  }): Promise<string | null> => {
    const requested = normalizeEcomResolution(args.workflow.resolution);
    const settled = deliveredImageResolution({
      requested,
      deliveredPixels: pixelsFromSize(`${args.asset.width ?? 0}x${args.asset.height ?? 0}`),
      pixelsForResolution: (resolution) => pixelsFromSize(ecomSizeForResolution(resolution)),
    });
    if (settled === requested) return null;
    const row = resolveImageChargeRow(await listPriceRows(), {
      resolution: settled as EcomResolution,
      model: args.workflow.model ?? undefined,
      dedicatedKey: args.dedicatedKey(settled),
      fallback: args.fallback,
    });
    app.log.info(
      { workflowId: args.workflow.id, requested, settled, resourceKey: row.resourceKey },
      "ecom settling at delivered resolution tier",
    );
    return row.resourceKey;
  };
  const onSettleError = (error: unknown, operationId: string) => {
    app.log.error({ error: safeErrorMessage(error), operationId }, "ecom settleResource failed; reservation left for reconciliation");
  };

  async function generateMaster(workflow: EcomWorkflowRow, priceRows: readonly WorkflowResourcePriceRow[]) {
    const product = parseWorkflowProduct(workflow.product);
    const prompt = buildEcomPrompt({ platformId: workflow.platform, templateId: workflow.template, kind: "master", ...product });
    const size = ecomSizeForResolution(workflow.resolution);
    const referenceImages = workflow.referenceAssetIds.length > 0 ? await loadOwnedReferenceImages(prisma, workflow.userId, workflow.referenceAssetIds, fetchFn) : null;
    const config = loadConfigForWorkflow(workflow.model);
    const chargeRow = resolveImageChargeRow(priceRows, {
      resolution: workflow.resolution as EcomResolution,
      model: workflow.model ?? undefined,
      dedicatedKey: ecomMasterResourceKey(workflow.resolution),
      fallback: ecomMasterPriceFallback,
    });
    return runChargedOperation({
      prisma,
      billing,
      workflow,
      operationPrefix: `ecom-master:${workflow.id}:a`,
      resourceKey: chargeRow.resourceKey,
      reservationTtlSeconds: ecomImageReservationTtlSeconds({ maxAttempts, retryDelayMs }),
      settleKeyFor: (committed: CommittedArtifact) => settleKeyForAsset({
        asset: committed.asset,
        workflow,
        dedicatedKey: ecomMasterResourceKey,
        fallback: ecomMasterPriceFallback,
      }),
      onSettleError,
      work: async (chargedWorkflow, operationId) => {
        const image = await retryUntilSuccess(
          () => referenceImages
            ? callImageEdit({ config, prompt, referenceImages, fetchFn, size })
            : callImageGeneration({ config, prompt, size, fetchFn }),
          { retryDelayMs, maxAttempts },
        );
        const stored = await storeWorkflowImage({ image, userId: chargedWorkflow.userId, requestId: operationId, requestIndex: 0, fetchFn });
        return commitArtifact({
          prisma,
          workflow: chargedWorkflow,
          operationId,
          size,
          prompt,
          model: config.model || REFERENCE_MODEL,
          stored,
          updateWorkflow: (assetId) => ({
            masterAssetId: assetId,
            stage: "master_ready",
            error: null,
          }),
        });
      },
    });
  }

  async function generateSegment(workflow: EcomWorkflowRow, index: number, priceRows: readonly WorkflowResourcePriceRow[], stageAfterSuccess = "segments_ready") {
    const product = parseWorkflowProduct(workflow.product);
    const segments = parseSegments(workflow.segments);
    const previous = index === 0 ? null : segments.find((item) => item.index === index - 1) ?? null;
    const masterId = workflow.masterAssetId;
    if (!masterId || (index > 0 && !previous)) throw new Error("missing segment references");
    const ids = [masterId, previous?.assetId].filter((value): value is string => Boolean(value));
    const prompt = buildEcomPrompt({ platformId: workflow.platform, templateId: workflow.template, kind: "segment", segmentIndex: index, segmentCount: workflow.segmentCount, ...product });
    const referenceImages = await loadOwnedReferenceImages(prisma, workflow.userId, ids, fetchFn);
    const size = ecomSizeForResolution(workflow.resolution);
    const config = loadConfigForWorkflow(workflow.model);
    const chargeRow = resolveImageChargeRow(priceRows, {
      resolution: workflow.resolution as EcomResolution,
      model: workflow.model ?? undefined,
      dedicatedKey: ecomSegmentResourceKey(workflow.resolution),
      fallback: ecomSegmentPriceFallback,
    });
    const committed = await runChargedOperation({
      prisma,
      billing,
      workflow,
      operationPrefix: `ecom-segment:${workflow.id}:${index}:a`,
      resourceKey: chargeRow.resourceKey,
      reservationTtlSeconds: ecomImageReservationTtlSeconds({ maxAttempts, retryDelayMs }),
      settleKeyFor: (committed: CommittedArtifact) => settleKeyForAsset({
        asset: committed.asset,
        workflow,
        dedicatedKey: ecomSegmentResourceKey,
        fallback: ecomSegmentPriceFallback,
      }),
      onSettleError,
      work: async (chargedWorkflow, operationId) => {
        const image = await retryUntilSuccess(() => callImageEdit({ config, prompt, referenceImages, fetchFn, size }), { retryDelayMs, maxAttempts });
        const stored = await storeWorkflowImage({ image, userId: chargedWorkflow.userId, requestId: operationId, requestIndex: 0, fetchFn });
        return commitArtifact({
          prisma,
          workflow: chargedWorkflow,
          operationId,
          size,
          prompt,
          model: config.model || REFERENCE_MODEL,
          stored,
          updateWorkflow: (assetId, createdAt) => ({
            segments: [...segments.filter((item) => item.index !== index), buildSegmentRecord({ index, assetId, originalUrl: stored.originalUrl, thumbnailUrl: stored.thumbnailUrl, prompt, createdAt })].sort((a, b) => a.index - b.index),
            stage: stageAfterSuccess,
            error: null,
          }),
        });
      },
    });
    return committed.workflow;
  }

  app.get("/api/workflow/ecom/options", async () => ({ success: true, data: { platforms: ECOM_PLATFORMS, templates: ECOM_TEMPLATES } }));

  app.get("/api/workflow/ecom/pricing", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const model = parsePricingModelQuery(req.query);
    try {
      const [master, segment] = await Promise.all([
        resolveImagePricingMatrix(billing, { model, dedicatedKeyFor: ecomMasterResourceKey, fallback: ecomMasterPriceFallback }),
        resolveImagePricingMatrix(billing, { model, dedicatedKeyFor: ecomSegmentResourceKey, fallback: ecomSegmentPriceFallback }),
      ]);
      return { success: true, data: { master, segment, stitch: ECOM_STITCH_FREE_PRICE } };
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
    const bytes = Buffer.from(parsed.data.image.b64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) return reply.code(400).send({ error: "参考图大小需在 10MB 以内" });
    const mime = parsed.data.image.mime?.startsWith("image/") ? parsed.data.image.mime : "image/png";
    const requestId = `ecom-reference:${randomUUID()}`;
    try {
      const stored = await storeWorkflowImage({ image: { kind: "b64", b64: parsed.data.image.b64, mime }, userId, requestId, requestIndex: 0, fetchFn });
      const row = await prisma.imageAsset.create({
        data: {
          userId,
          requestId,
          requestIndex: 0,
          prompt: REFERENCE_PROMPT,
          model: REFERENCE_MODEL,
          size: DEFAULT_SIZE,
          originalUrl: stored.originalUrl,
          thumbnailUrl: stored.thumbnailUrl,
          objectKey: stored.objectKey,
          mime: stored.mime,
          width: stored.width ?? null,
          height: stored.height ?? null,
        },
      });
      return { success: true, data: { asset: serializeAsset(row) } };
    } catch (uploadError) {
      app.log.error(uploadError);
      return reply.code(502).send({ error: "上传参考图失败" });
    }
  });

  app.post("/api/workflow/ecom/master", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply); if (!userId) return;
    const parsed = masterRequestSchema.safeParse(req.body);
    if (!parsed.success || !getEcomPlatform(parsed.data.platformId) || !getEcomTemplate(parsed.data.templateId)) return reply.code(400).send({ error: "参数不合法" });
    const sizeError = ecomModelSizeError(parsed.data.model, ecomSizeForResolution(parsed.data.resolution));
    if (sizeError) return reply.code(400).send({ error: sizeError });
    const referenceAssets = parsed.data.referenceAssetIds.length > 0 ? await prisma.imageAsset.findMany({ where: { userId, id: { in: parsed.data.referenceAssetIds } } }) : [];
    if (referenceAssets.length !== parsed.data.referenceAssetIds.length) return reply.code(400).send({ error: "引用图不存在" });
    try {
      const priceRows = await listPriceRows();
      return await workflowMutationLocker.withLock(workflowCreateMutationKey(userId), async () => {
        const workflow = await prisma.ecomWorkflow.create({ data: { userId, platform: parsed.data.platformId, language: resolveLanguage(parsed.data.platformId), template: parsed.data.templateId, resolution: parsed.data.resolution, model: parsed.data.model ?? null, segmentCount: parsed.data.segmentCount, product: parsed.data.product, referenceAssetIds: parsed.data.referenceAssetIds, masterAssetId: null, segments: [], stitchedAssetId: null, stage: "master_running", error: null, billingOperationIds: [] } });
        try {
          const committed = await generateMaster(workflow, priceRows);
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
    const adoptSizeError = ecomModelSizeError(parsed.data.model, ecomSizeForResolution(parsed.data.resolution));
    if (adoptSizeError) return reply.code(400).send({ error: adoptSizeError });
    const master = await prisma.imageAsset.findFirst({ where: { id: parsed.data.masterAssetId, userId } });
    if (!master) return reply.code(400).send({ error: "所选主图不存在" });
    const referenceAssets = parsed.data.referenceAssetIds.length > 0 ? await prisma.imageAsset.findMany({ where: { userId, id: { in: parsed.data.referenceAssetIds } } }) : [];
    if (referenceAssets.length !== parsed.data.referenceAssetIds.length) return reply.code(400).send({ error: "引用图不存在" });
    try {
      return await workflowMutationLocker.withLock(workflowCreateMutationKey(userId), async () => {
        const workflow = await prisma.ecomWorkflow.create({ data: { userId, platform: parsed.data.platformId, language: resolveLanguage(parsed.data.platformId), template: parsed.data.templateId, resolution: parsed.data.resolution, model: parsed.data.model ?? null, segmentCount: parsed.data.segmentCount, product: parsed.data.product, referenceAssetIds: parsed.data.referenceAssetIds, masterAssetId: parsed.data.masterAssetId, segments: [], stitchedAssetId: null, stage: "master_ready", error: null, billingOperationIds: [] } });
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
      const priceRows = await listPriceRows();
      const committed = await workflowMutationLocker.withLock(workflowMutationKey(workflow.id), async () => generateMaster(await markWorkflowStage(workflow, "master_running"), priceRows));
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
      const priceRows = await listPriceRows();
      workflow = await workflowMutationLocker.withLock(workflowMutationKey(baseWorkflow.id), async () => {
        let currentWorkflow: EcomWorkflowRow = await markWorkflowStage(baseWorkflow, "segments_running");
        const missingIndexes = Array.from({ length: currentWorkflow.segmentCount }, (_, i) => i).filter((index) => !parseSegments(currentWorkflow.segments).find((item) => item.index === index));
        if (missingIndexes.length === 0) {
          return prisma.ecomWorkflow.update({ where: { id: currentWorkflow.id }, data: { stage: "segments_ready", error: null } });
        }
        for (const index of missingIndexes) {
          currentWorkflow = await generateSegment(currentWorkflow, index, priceRows, index === missingIndexes.at(-1) ? "segments_ready" : "segments_running");
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
      const priceRows = await listPriceRows();
      const updated = await workflowMutationLocker.withLock(workflowMutationKey(workflow.id), async () => generateSegment(await markWorkflowStage(workflow, "segments_running"), params.data.index, priceRows));
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
      // 拼接是纯浏览器合成结果的保存，不扣点、不记 billingOperationIds。
      const committed = await workflowMutationLocker.withLock(workflowMutationKey(workflow.id), async () => {
        const requestId = `ecom-stitch:${workflow.id}:${randomUUID()}`;
        const stored = await storeWorkflowImage({ image: { kind: "b64", b64: body.data.image.b64, mime: body.data.image.mime ?? "image/png" }, userId, requestId, requestIndex: 0, fetchFn });
        return commitArtifact({
          prisma,
          workflow,
          operationId: requestId,
          size: ecomSizeForResolution(workflow.resolution),
          prompt: "ecom_stitch",
          model: "ecom_stitch",
          stored,
          updateWorkflow: (assetId) => ({ stitchedAssetId: assetId, stage: "stitched", error: null }),
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
