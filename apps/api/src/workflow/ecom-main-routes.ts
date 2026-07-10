import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getPrisma, getRedis } from "@yc/db";
import { createBillingClient, InsufficientBalanceError } from "@yc/billing";
import { buildEcomMainImagePrompt } from "./ecom-main-prompts.js";
import { ecomMainImageResourceKey, ecomMainImageSize, type EcomMainRatio, type EcomMainStyleId } from "./ecom-main.js";
import {
  authUserId,
  loadOwnedReferenceImages,
  readBillingClientEnv,
  resolveLanguage,
  RefundCompensationError,
  safeErrorMessage,
} from "./ecom-route-helpers.js";
import { createRedisWorkflowMutationLocker, WorkflowMutationConflictError } from "./ecom-route-mutation.js";
import { mainImageParamsSchema, mainImageRequestSchema } from "./ecom-main-route-types.js";
import { resolveEcomMainImagePricing } from "./workflow-pricing.js";
import {
  callImageEdit as callImageEditService,
  callImageGeneration as callImageGenerationService,
  loadImageGenerationConfig as loadImageGenerationConfigService,
  retryUntilSuccess as retryUntilSuccessService,
  storeWorkflowImage as storeWorkflowImageService,
  type GeneratedImage,
  type ImageGenerationConfig,
  type StoredImage,
} from "./image-service.js";
import { getEcomPlatform } from "./ecom-prompts.js";

const REFERENCE_MODEL = "ecom_main_image";
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
  const locker = createRedisWorkflowMutationLocker(deps.redis ?? getRedis());
  const retryDelayMs = deps.retryDelayMs ?? 1_000;
  const maxAttempts = deps.maxAttempts ?? 2;

  const replyBillingFailure = (reply: FastifyReply, error: unknown, fallback: string) =>
    error instanceof InsufficientBalanceError
      ? reply.code(402).send({ error: "积分不足，请充值" })
      : error instanceof RefundCompensationError
        ? reply.code(502).send({ error: safeErrorMessage(error) })
        : reply.code(502).send({ error: fallback });

  async function commitMainImage(args: {
    readonly job: MainJobRow;
    readonly index: number;
    readonly record: Pick<MainImageRecord, "index" | "theme" | "sceneRequirement" | "copyRequirement">;
    readonly stored: { originalUrl: string; thumbnailUrl: string; objectKey: string | null; mime: string };
    readonly prompt: string;
    readonly size: string;
  }): Promise<MainJobRow> {
    const operationId = `ecom-main:${args.job.id}:${args.index}:${randomUUID()}`;
    await billing.chargeResource({ operationId, userId: args.job.userId, resourceKey: ecomMainImageResourceKey(args.job.resolution), units: 1 });
    try {
      return await prisma.$transaction(async (tx) => {
        const asset = await tx.imageAsset.create({
          data: {
            userId: args.job.userId,
            requestId: operationId,
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
        const images = parseImages(args.job.images).map((image) =>
          image.index === args.index
            ? { ...args.record, index: args.index, assetId: asset.id, originalUrl: args.stored.originalUrl, thumbnailUrl: args.stored.thumbnailUrl, status: "ready" as const }
            : image,
        );
        const updated = await tx.ecomMainImageJob.updateMany({
          where: { id: args.job.id, userId: args.job.userId, updatedAt: args.job.updatedAt },
          data: { images, billingOperationIds: [...args.job.billingOperationIds, operationId], error: null },
        });
        if (updated.count !== 1) throw new WorkflowMutationConflictError();
        const next = await tx.ecomMainImageJob.findFirst({ where: { id: args.job.id, userId: args.job.userId } });
        if (!next) throw new Error("job not found");
        return next;
      });
    } catch (error) {
      try {
        await billing.refundResource(operationId);
      } catch (refundError) {
        throw new RefundCompensationError(operationId, `${safeErrorMessage(error)}；退款失败：${safeErrorMessage(refundError)}`);
      }
      throw error;
    }
  }

  async function generateOneImage(job: MainJobRow, index: number): Promise<MainJobRow> {
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
    const referenceImages = job.referenceAssetIds.length > 0 ? await loadOwnedReferenceImages(prisma, job.userId, job.referenceAssetIds, fetchFn) : null;
    const config = loadImageGenerationConfig();
    const image = await retryUntilSuccess(
      () =>
        referenceImages
          ? callImageEdit({ config, prompt: built.prompt, referenceImages: referenceImages as readonly { mime: string; b64: string }[], fetchFn, size })
          : callImageGeneration({ config, prompt: built.prompt, size, fetchFn }),
      { retryDelayMs, maxAttempts },
    );
    const stored = await storeWorkflowImage({ image, userId: job.userId, requestId: `ecom-main:${job.id}:${index}:${randomUUID()}`, requestIndex: 0, fetchFn });
    return commitMainImage({
      job,
      index,
      size,
      prompt: built.prompt,
      record: { index, theme: built.theme, sceneRequirement: built.sceneRequirement, copyRequirement: built.copyRequirement },
      stored,
    });
  }

  app.get("/api/workflow/ecom/main/pricing", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    try {
      return { success: true, data: await resolveEcomMainImagePricing(billing) };
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
    const referenceAssets = parsed.data.referenceAssetIds.length > 0
      ? await prisma.imageAsset.findMany({ where: { userId, id: { in: parsed.data.referenceAssetIds } } })
      : [];
    if (referenceAssets.length !== parsed.data.referenceAssetIds.length) return reply.code(400).send({ error: "引用图不存在" });
    try {
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
            job = await generateOneImage(job, index);
          } catch (error) {
            if (error instanceof InsufficientBalanceError || error instanceof RefundCompensationError) throw error;
            anyFailed = true;
            const images = parseImages(job.images).map((image) => (image.index === index ? { ...image, status: "failed" as const } : image));
            const updated = await prisma.ecomMainImageJob.update({ where: { id: job.id }, data: { images, error: safeErrorMessage(error) } });
            job = updated as MainJobRow;
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
      const updated = await locker.withLock(mainJobLockKey(job.id), async () => {
        const runningData = await prisma.ecomMainImageJob.update({ where: { id: job.id }, data: { stage: "running", error: null } });
        const running = runningData as MainJobRow;
        const next = await generateOneImage(running, params.data.index);
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
