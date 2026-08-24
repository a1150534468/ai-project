import type { FastifyInstance, FastifyReply } from "fastify";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { buildEcomMainImagePrompt } from "./ecom-main-prompts.js";
import { ecomMainImageResourceKey, ecomMainImageSize, normalizeEcomMainResolution, ECOM_MAIN_RESOLUTIONS, type EcomMainRatio, type EcomMainResolution, type EcomMainStyleId } from "./ecom-main.js";
import { ecomModelSizeError } from "./ecom-resolution.js";
import { deliveredImageResolution, pixelsFromSize } from "../_shared/image-delivered-tier.js";
import { authUserId } from "../_shared/route-auth.js";
import { loadOwnedReferenceImages } from "../_shared/reference-image.js";
import {
  appendBillingOperationId,
  readBillingClientEnv,
  resolveLanguage,
  RefundCompensationError,
  safeErrorMessage,
} from "./ecom-route-helpers.js";
import { createRedisWorkflowMutationLocker, WorkflowMutationConflictError } from "./ecom-route-mutation.js";
import { mainImageParamsSchema, mainImageRequestSchema } from "./ecom-main-route-types.js";
import { parsePricingModelQuery } from "./ecom-route-types.js";
import { ecomMainImagePriceFallback, resolveImageChargeRow, resolveImagePricingMatrix, type WorkflowResourcePriceRow } from "../_shared/workflow-pricing.js";
import {
  callImageEdit as callImageEditService,
  callImageGeneration as callImageGenerationService,
  loadImageGenerationConfig as loadImageGenerationConfigService,
  loadImageGenerationConfigForModel as loadImageGenerationConfigForModelService,
  retryUntilSuccess as retryUntilSuccessService,
  storeWorkflowImage as storeWorkflowImageService,
  type GeneratedImage,
  type ImageGenerationConfig,
  type StoredImage,
} from "../_shared/image-service.js";
import { getEcomPlatform } from "./ecom-prompts.js";

const LEGACY_ECOM_MAIN_MODEL = "ecom_main_image";
type Prisma = ReturnType<typeof getPrisma>;
type MainJobRow = NonNullable<Awaited<ReturnType<Prisma["ecomMainImageJob"]["findFirst"]>>>;
type MainImageRecord = {
  index: number;
  assetId: string | null;
  theme: string;
  sceneRequirement: string;
  copyRequirement: string;
  originalUrl: string | null;
  thumbnailUrl: string | null;
  status: "pending" | "ready" | "failed";
};
type MainProduct = { name: string; category: string; sellingPoints: string[]; extra: string };

export type EcomMainRouteDeps = {
  readonly prisma?: Prisma;
  readonly billing?: ReturnType<typeof createBillingClient>;
  readonly redis?: Parameters<typeof createRedisWorkflowMutationLocker>[0];
  readonly fetchFn?: typeof fetch;
  readonly callImageGeneration?: (args: {
    config: ImageGenerationConfig;
    prompt: string;
    size: string;
    fetchFn: typeof fetch;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }) => Promise<GeneratedImage>;
  readonly callImageEdit?: (args: {
    config: ImageGenerationConfig;
    prompt: string;
    referenceImages: readonly { mime: string; b64: string }[];
    fetchFn: typeof fetch;
    size?: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }) => Promise<GeneratedImage>;
  readonly retryUntilSuccess?: <T>(
    fn: () => Promise<T>,
    options: { retryDelayMs: number; maxAttempts?: number; onRetry?: (error: unknown, attempt: number) => Promise<void>; shouldStop?: (error: unknown) => boolean },
  ) => Promise<T>;
  readonly storeWorkflowImage?: (args: {
    image: GeneratedImage;
    userId: string;
    requestId: string;
    requestIndex: number;
    fetchFn: typeof fetch;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }) => Promise<StoredImage>;
  readonly loadImageGenerationConfig?: (env?: NodeJS.ProcessEnv) => ImageGenerationConfig;
  readonly loadImageGenerationConfigForModel?: (model: string, env?: NodeJS.ProcessEnv) => ImageGenerationConfig;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
};

const mainJobLockKey = (jobId: string) => `main-image:${jobId}`;
const mainCreateLockKey = (userId: string) => `main-image-create:${userId}`;

function parseImages(value: unknown): MainImageRecord[] {
  return Array.isArray(value) ? (value as MainImageRecord[]) : [];
}

function serializeJob(job: MainJobRow) {
  return {
    id: job.id,
    platform: job.platform,
    language: job.language,
    ratio: job.ratio,
    resolution: job.resolution,
    model: job.model ?? null,
    style: job.style,
    customStyle: job.customStyle,
    withText: job.withText,
    count: job.count,
    stage: job.stage,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    images: parseImages(job.images),
  };
}

export async function ecomMainImageRoutes(app: FastifyInstance, deps: EcomMainRouteDeps = {}) {
  const prisma = (deps.prisma ?? getPrisma()) as Prisma;
  const billing = deps.billing ?? createBillingClient(readBillingClientEnv());
  const fetchFn = deps.fetchFn ?? fetch;
  const callImageGeneration = deps.callImageGeneration ?? callImageGenerationService;
  const callImageEdit = deps.callImageEdit ?? callImageEditService;
  const retryUntilSuccess = deps.retryUntilSuccess ?? retryUntilSuccessService;
  const storeWorkflowImage = deps.storeWorkflowImage ?? storeWorkflowImageService;
  const loadImageGenerationConfig = deps.loadImageGenerationConfig ?? loadImageGenerationConfigService;
  const loadImageGenerationConfigForModel = deps.loadImageGenerationConfigForModel ?? loadImageGenerationConfigForModelService;
  // 任务落库了 model 后，整组主图（含重绘）都锁定在同一模型上。
  const loadConfigForJob = (model: string | null | undefined) =>
    model ? loadImageGenerationConfigForModel(model) : loadImageGenerationConfig();
  // 拉不到管理台费率时回落通用 key，但必须留痕，否则扣费 key 悄悄降级无从排查。
  const listPriceRows = async (): Promise<readonly WorkflowResourcePriceRow[]> => {
    if (!billing.listResourcePrices) return [];
    try {
      return (await billing.listResourcePrices()).data ?? [];
    } catch (error) {
      app.log.warn({ error: safeErrorMessage(error) }, "ecom main listResourcePrices failed, falling back to generic image pricing keys");
      return [];
    }
  };
  const locker = createRedisWorkflowMutationLocker(deps.redis ?? getRedis());
  const retryDelayMs = deps.retryDelayMs ?? 1_000;
  const maxAttempts = deps.maxAttempts ?? 2;

  /**
   * 按实际交付像素定结算档位；只会往下降，请求 1K 上游多给不会反过来多收。
   * 交付像素测不出来（url 直存等）时按请求档结算。
   */
  const settleKeyForDelivered = (args: {
    readonly job: MainJobRow;
    readonly stored: { readonly width?: number | null; readonly height?: number | null };
    readonly priceRows: readonly WorkflowResourcePriceRow[];
    readonly requestedKey: string;
  }): string => {
    const requested = normalizeEcomMainResolution(args.job.resolution);
    const ratio = args.job.ratio as EcomMainRatio;
    const settled = deliveredImageResolution({
      requested,
      deliveredPixels: pixelsFromSize(`${args.stored.width ?? 0}x${args.stored.height ?? 0}`),
      pixelsForResolution: (resolution) => pixelsFromSize(ecomMainImageSize(ratio, resolution as EcomMainResolution)),
    });
    if (settled === requested) return args.requestedKey;
    const row = resolveImageChargeRow(args.priceRows, {
      resolution: settled,
      model: args.job.model ?? undefined,
      dedicatedKey: ecomMainImageResourceKey(settled),
      fallback: ecomMainImagePriceFallback,
    });
    app.log.info(
      { jobId: args.job.id, requested, settled, resourceKey: row.resourceKey },
      "ecom main settling at delivered resolution tier",
    );
    return row.resourceKey;
  };

  const replyBillingFailure = (reply: FastifyReply, error: unknown, fallback: string) =>
    error instanceof InsufficientBalanceError
      ? reply.code(402).send({ error: "积分不足，请充值" })
      : error instanceof RefundCompensationError
        ? reply.code(502).send({ error: safeErrorMessage(error) })
        : reply.code(502).send({ error: fallback });

  async function commitMainImage(args: {
    readonly job: MainJobRow;
    readonly operationId: string;
    readonly index: number;
    readonly record: Pick<MainImageRecord, "index" | "theme" | "sceneRequirement" | "copyRequirement">;
    readonly stored: {
      originalUrl: string;
      thumbnailUrl: string;
      objectKey: string | null;
      mime: string;
      width?: number | null;
      height?: number | null;
    };
    readonly prompt: string;
    readonly size: string;
    readonly model: string;
  }): Promise<MainJobRow> {
    return prisma.$transaction(async (tx) => {
      const asset = await tx.imageAsset.create({
        data: {
          userId: args.job.userId,
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
      const images = parseImages(args.job.images).map((image) =>
        image.index === args.index
          ? { ...args.record, index: args.index, assetId: asset.id, originalUrl: args.stored.originalUrl, thumbnailUrl: args.stored.thumbnailUrl, status: "ready" as const }
          : image,
      );
      const updated = await tx.ecomMainImageJob.updateMany({
        where: { id: args.job.id, userId: args.job.userId, updatedAt: args.job.updatedAt },
        data: { images, error: null },
      });
      if (updated.count !== 1) throw new WorkflowMutationConflictError();
      const next = await tx.ecomMainImageJob.findFirst({ where: { id: args.job.id, userId: args.job.userId } });
      if (!next) throw new Error("job not found");
      return next;
    });
  }

  async function generateOneImage(job: MainJobRow, index: number, priceRows: readonly WorkflowResourcePriceRow[]): Promise<MainJobRow> {
    const product = job.product as MainProduct;
    const built = buildEcomMainImagePrompt({
      platformId: job.platform,
      language: job.language,
      ratio: job.ratio as EcomMainRatio,
      style: job.style as EcomMainStyleId,
      customStyle: job.customStyle,
      withText: job.withText,
      product,
      index,
    });
    const size = ecomMainImageSize(job.ratio as EcomMainRatio, job.resolution as never);
    // 确定性 operationId（第 N 次尝试为 a{N-1}）：以 updatedAt 做 CAS push 原子落库后才扣费，避免并发派生同一个 N。
    const { operationId, row: chargedJob } = await appendBillingOperationId<MainJobRow>({
      row: job,
      prefix: `ecom-main:${job.id}:${index}:a`,
      updateMany: ({ updatedAt, operationId: id }) => prisma.ecomMainImageJob.updateMany({
        where: { id: job.id, userId: job.userId, updatedAt },
        data: { billingOperationIds: { push: id } },
      }),
      reload: () => prisma.ecomMainImageJob.findFirst({ where: { id: job.id, userId: job.userId } }) as Promise<MainJobRow | null>,
    });
    const chargeRow = resolveImageChargeRow(priceRows, {
      resolution: normalizeEcomMainResolution(chargedJob.resolution),
      model: chargedJob.model ?? undefined,
      dedicatedKey: ecomMainImageResourceKey(chargedJob.resolution),
      fallback: ecomMainImagePriceFallback,
    });
    // 请求档预留、交付档结算：中转上游常只认宽高比、忽略绝对像素，
    // 请求 2K 实际只交付 1K 时按请求档收就是多收一倍，差额由计费服务在 settle 时退回。
    await billing.reserveResource({
      operationId,
      userId: chargedJob.userId,
      resourceKey: chargeRow.resourceKey,
      units: 1,
    });
    try {
      const referenceImages = chargedJob.referenceAssetIds.length > 0 ? await loadOwnedReferenceImages(prisma, chargedJob.userId, chargedJob.referenceAssetIds, fetchFn) : null;
      const config = loadConfigForJob(chargedJob.model);
      const image = await retryUntilSuccess(
        () =>
          referenceImages
            ? callImageEdit({ config, prompt: built.prompt, referenceImages: referenceImages as readonly { mime: string; b64: string }[], fetchFn, size })
            : callImageGeneration({ config, prompt: built.prompt, size, fetchFn }),
        { retryDelayMs, maxAttempts },
      );
      const stored = await storeWorkflowImage({ image, userId: chargedJob.userId, requestId: operationId, requestIndex: 0, fetchFn });
      const committed = await commitMainImage({
        job: chargedJob,
        operationId,
        index,
        size,
        prompt: built.prompt,
        model: config.model || LEGACY_ECOM_MAIN_MODEL,
        record: { index, theme: built.theme, sceneRequirement: built.sceneRequirement, copyRequirement: built.copyRequirement },
        stored,
      });
      // 图已交付，结算失败不能退款白送——留痕交对账兜底。
      try {
        await billing.settleResource({
          operationId,
          resourceKey: settleKeyForDelivered({ job: chargedJob, stored, priceRows, requestedKey: chargeRow.resourceKey }),
          units: 1,
        });
      } catch (settleError) {
        app.log.error(
          { error: safeErrorMessage(settleError), operationId },
          "ecom main settleResource failed; reservation left for reconciliation",
        );
      }
      return committed;
    } catch (error) {
      try {
        await billing.refundResource(operationId);
      } catch (refundError) {
        throw new RefundCompensationError(operationId, `${safeErrorMessage(error)}；退款失败：${safeErrorMessage(refundError)}`);
      }
      throw error;
    }
  }

  app.get("/api/workflow/ecom/main/pricing", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const model = parsePricingModelQuery(req.query);
    try {
      return {
        success: true,
        data: await resolveImagePricingMatrix(billing, { model, dedicatedKeyFor: ecomMainImageResourceKey, fallback: ecomMainImagePriceFallback }),
      };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "获取电商主图计价失败" });
    }
  });

  app.get("/api/workflow/ecom/main/current", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const job = await prisma.ecomMainImageJob.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
    return { success: true, data: { job: job ? serializeJob(job) : null } };
  });

  app.get("/api/workflow/ecom/main/history", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const jobs = await prisma.ecomMainImageJob.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 });
    return { success: true, data: { jobs: jobs.map(serializeJob) } };
  });

  app.post("/api/workflow/ecom/main", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = mainImageRequestSchema.safeParse(req.body);
    if (!parsed.success || !getEcomPlatform(parsed.data.platformId))
      return reply.code(400).send({ error: "参数不合法" });
    if (parsed.data.style === "custom" && parsed.data.customStyle.trim().length === 0) return reply.code(400).send({ error: "请填写自定义风格描述" });
    const requestedSize = ecomMainImageSize(parsed.data.ratio, parsed.data.resolution);
    const supportedResolutions = ECOM_MAIN_RESOLUTIONS.filter((res) => !ecomModelSizeError(parsed.data.model, ecomMainImageSize(parsed.data.ratio, res)));
    const sizeError = ecomModelSizeError(
      parsed.data.model,
      requestedSize,
      supportedResolutions.length > 0 ? `该比例可选清晰度：${supportedResolutions.join("/")}` : undefined,
    );
    if (sizeError) return reply.code(400).send({ error: sizeError });
    const referenceAssets = parsed.data.referenceAssetIds.length > 0
      ? await prisma.imageAsset.findMany({ where: { userId, id: { in: parsed.data.referenceAssetIds } } })
      : [];
    if (referenceAssets.length !== parsed.data.referenceAssetIds.length) return reply.code(400).send({ error: "引用图不存在" });
    try {
      const priceRows = await listPriceRows();
      return await locker.withLock(mainCreateLockKey(userId), async () => {
        const language = resolveLanguage(parsed.data.platformId);
        const pendingImages: MainImageRecord[] = Array.from({ length: parsed.data.count }, (_, index) => {
          const built = buildEcomMainImagePrompt({
            platformId: parsed.data.platformId,
            language,
            ratio: parsed.data.ratio,
            style: parsed.data.style,
            customStyle: parsed.data.customStyle,
            withText: parsed.data.withText,
            product: parsed.data.product,
            index,
          });
          return {
            index,
            assetId: null,
            theme: built.theme,
            sceneRequirement: built.sceneRequirement,
            copyRequirement: built.copyRequirement,
            originalUrl: null,
            thumbnailUrl: null,
            status: "pending",
          };
        });
        let job = await prisma.ecomMainImageJob.create({
          data: {
            userId,
            platform: parsed.data.platformId,
            language,
            ratio: parsed.data.ratio,
            resolution: parsed.data.resolution,
            model: parsed.data.model ?? null,
            style: parsed.data.style,
            customStyle: parsed.data.customStyle,
            withText: parsed.data.withText,
            product: parsed.data.product,
            referenceAssetIds: parsed.data.referenceAssetIds,
            count: parsed.data.count,
            images: pendingImages,
            stage: "running",
            error: null,
            billingOperationIds: [],
          },
        });
        let anyFailed = false;
        for (let index = 0; index < parsed.data.count; index += 1) {
          try {
            job = await generateOneImage(job, index, priceRows);
          } catch (error) {
            const fatalError = error instanceof InsufficientBalanceError
              || error instanceof RefundCompensationError
              || error instanceof WorkflowMutationConflictError;
            anyFailed = true;
            const images = parseImages(job.images).map((image) =>
              image.index === index || (fatalError && image.status === "pending")
                ? { ...image, status: "failed" as const }
                : image,
            );
            const hasReadyImage = images.some((image) => image.status === "ready");
            const updated = await prisma.ecomMainImageJob.update({
              where: { id: job.id },
              data: {
                images,
                error: safeErrorMessage(error),
                ...(fatalError ? { stage: hasReadyImage ? "partial" : "failed" } : {}),
              },
            });
            job = updated as MainJobRow;
            if (fatalError) throw error;
          }
        }
        const finalStage = anyFailed ? "partial" : "ready";
        const finalized = await prisma.ecomMainImageJob.update({ where: { id: job.id }, data: { stage: finalStage } });
        job = finalized as MainJobRow;
        return { success: true, data: { job: serializeJob(job) } };
      });
    } catch (error) {
      if (error instanceof WorkflowMutationConflictError) return reply.code(409).send({ error: safeErrorMessage(error) });
      return replyBillingFailure(reply, error, "主图生成失败");
    }
  });

  app.post("/api/workflow/ecom/main/:jobId/images/:index/redraw", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = mainImageParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const job = await prisma.ecomMainImageJob.findFirst({ where: { id: params.data.jobId, userId } });
    if (!job) return reply.code(404).send({ error: "主图任务不存在" });
    if (params.data.index >= job.count) return reply.code(400).send({ error: "序号越界" });
    try {
      const priceRows = await listPriceRows();
      const updated = await locker.withLock(mainJobLockKey(job.id), async () => {
        const runningData = await prisma.ecomMainImageJob.update({ where: { id: job.id }, data: { stage: "running", error: null } });
        const running = runningData as MainJobRow;
        const next = await generateOneImage(running, params.data.index, priceRows);
        const stillFailed = parseImages(next.images).some((image) => image.status === "failed");
        const finalData = await prisma.ecomMainImageJob.update({ where: { id: next.id }, data: { stage: stillFailed ? "partial" : "ready" } });
        return finalData as MainJobRow;
      });
      return { success: true, data: { job: serializeJob(updated) } };
    } catch (error) {
      if (error instanceof WorkflowMutationConflictError) return reply.code(409).send({ error: safeErrorMessage(error) });
      await prisma.ecomMainImageJob.update({ where: { id: job.id }, data: { stage: "partial", error: safeErrorMessage(error) } });
      return replyBillingFailure(reply, error, "主图重绘失败");
    }
  });
}
