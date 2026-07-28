import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  ArticleWorkflowImageAsset,
  ArticleWorkflowImageSlot,
  ArticleWorkflowPlatformConfig,
} from "@ai-assistant/article-workflow";
import { callImageGeneration, loadImageGenerationConfig, storeWorkflowImage } from "./image-service.js";
import { imageGenerationResourceKey, imageResolutionFromSize } from "./image-upstream-options.js";
import {
  ARTICLE_IMAGE_BATCH_SIZE,
  type ArticleWorkflowBilling,
  type FetchLike,
} from "./article-workflow-shared.js";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function imageSize(slot: ArticleWorkflowImageSlot, platformConfig: ArticleWorkflowPlatformConfig): string {
  return slot === "cover" ? platformConfig.coverSize : platformConfig.inlineSize;
}

function fallbackAlt(slot: ArticleWorkflowImageSlot, platformConfig: ArticleWorkflowPlatformConfig): string {
  if (platformConfig.outputKind === "caption") return slot === "cover" ? "封面图" : "配图";
  return slot === "cover" ? "公众号头图" : "正文配图";
}

export async function generateArticleWorkflowImageAsset(args: {
  readonly prisma: PrismaClient;
  readonly billing: ArticleWorkflowBilling;
  readonly fetchFn: FetchLike;
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly projectId: string;
  readonly image: ArticleWorkflowImageAsset;
  /** 平台配置，决定封面/内页尺寸与 alt 兜底文案。 */
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  /**
   * 整图成功后上报扣款 operationId，供调用方在「整单后续步骤失败」时回滚。
   * 失败路径下方已自行退款，不上报。
   */
  readonly onCharged?: (operationId: string) => void;
}): Promise<ArticleWorkflowImageAsset> {
  const size = imageSize(args.image.slot, args.platformConfig);
  const operationId = `article-image:${args.projectId}:${args.image.slot}:${randomUUID()}`;
  const requestId = `article:${args.projectId}:${args.image.slot}:${randomUUID()}`;
  await args.billing.chargeResource({
    operationId,
    userId: args.userId,
    resourceKey: imageGenerationResourceKey(imageResolutionFromSize(size)),
    units: 1,
  });
  try {
    const config = loadImageGenerationConfig(args.env);
    const generated = await callImageGeneration({
      config,
      prompt: args.image.prompt,
      size,
      fetchFn: args.fetchFn,
      env: args.env,
    });
    const stored = await storeWorkflowImage({
      image: generated,
      userId: args.userId,
      requestId,
      requestIndex: 0,
      fetchFn: args.fetchFn,
      env: args.env,
    });
    const asset = await args.prisma.imageAsset.create({
      data: {
        userId: args.userId,
        requestId,
        requestIndex: 0,
        prompt: args.image.prompt,
        model: config.model,
        size,
        originalUrl: stored.originalUrl,
        thumbnailUrl: stored.thumbnailUrl,
        objectKey: stored.objectKey,
        mime: stored.mime,
      },
    });
    args.onCharged?.(operationId);
    return {
      ...args.image,
      assetId: asset.id,
      imageUrl: stored.originalUrl,
      thumbnailUrl: stored.thumbnailUrl,
      alt: args.image.alt.trim() || fallbackAlt(args.image.slot, args.platformConfig),
    };
  } catch (error) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw error;
  }
}

export async function populateArticleWorkflowImages(args: {
  readonly prisma: PrismaClient;
  readonly billing: ArticleWorkflowBilling;
  readonly fetchFn: FetchLike;
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly projectId: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  readonly force?: boolean;
  readonly onProgress?: (completed: number, total: number) => Promise<void>;
  /** 逐张上报已扣款 operationId；用回调而非返回值，本函数中途抛错时调用方才拿得到已扣款清单 */
  readonly onCharged?: (operationId: string) => void;
}): Promise<readonly ArticleWorkflowImageAsset[]> {
  const targets = args.force
    ? args.imageManifest
    : args.imageManifest.filter((image) => !image.imageUrl.trim());
  if (targets.length === 0) return args.imageManifest;

  const replacements = new Map<ArticleWorkflowImageSlot, ArticleWorkflowImageAsset>();
  let completed = 0;
  for (const group of chunk(targets, ARTICLE_IMAGE_BATCH_SIZE)) {
    const generated = await Promise.all(group.map((image) =>
      generateArticleWorkflowImageAsset({
        prisma: args.prisma,
        billing: args.billing,
        fetchFn: args.fetchFn,
        env: args.env,
        userId: args.userId,
        projectId: args.projectId,
        image,
        platformConfig: args.platformConfig,
        onCharged: args.onCharged,
      })
    ));
    for (const image of generated) {
      replacements.set(image.slot, image);
      completed += 1;
    }
    await args.onProgress?.(completed, targets.length);
  }

  return args.imageManifest.map((image) => replacements.get(image.slot) ?? image);
}
