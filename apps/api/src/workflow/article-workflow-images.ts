import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  ArticleWorkflowImageAsset,
  ArticleWorkflowImageSlot,
} from "@yc/article-workflow";
import { callImageGeneration, loadImageGenerationConfig, storeWorkflowImage } from "./image-service.js";
import { imageGenerationResourceKey, imageResolutionFromSize } from "./image-upstream-options.js";
import {
  ARTICLE_COVER_IMAGE_SIZE,
  ARTICLE_IMAGE_BATCH_SIZE,
  ARTICLE_INLINE_IMAGE_SIZE,
  type ArticleWorkflowBilling,
  type FetchLike,
} from "./article-workflow-shared.js";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function imageSize(slot: ArticleWorkflowImageSlot): string {
  return slot === "cover" ? ARTICLE_COVER_IMAGE_SIZE : ARTICLE_INLINE_IMAGE_SIZE;
}

export async function generateArticleWorkflowImageAsset(args: {
  readonly prisma: PrismaClient;
  readonly billing: ArticleWorkflowBilling;
  readonly fetchFn: FetchLike;
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly projectId: string;
  readonly image: ArticleWorkflowImageAsset;
}): Promise<ArticleWorkflowImageAsset> {
  const size = imageSize(args.image.slot);
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
    return {
      ...args.image,
      assetId: asset.id,
      imageUrl: stored.originalUrl,
      thumbnailUrl: stored.thumbnailUrl,
      alt: args.image.alt.trim() || (args.image.slot === "cover" ? "公众号头图" : "正文配图"),
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
  readonly force?: boolean;
  readonly onProgress?: (completed: number, total: number) => Promise<void>;
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
