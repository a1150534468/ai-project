import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  ArticleWorkflowImageAsset,
  ArticleWorkflowImageSlot,
  ArticleWorkflowPlatformConfig,
} from "@ai-assistant/article-workflow";
import { callImageGeneration, loadImageGenerationConfig, storeWorkflowImage } from "../_shared/image-service.js";
import type { FetchLike } from "./article-workflow-shared.js";
import { ARTICLE_IMAGE_BATCH_SIZE } from "./article-workflow-shared.js";
import { ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS, withArticleWorkflowRetry } from "./article-workflow-retry.js";
import { articleWorkflowStorableImageUrl } from "./article-workflow-image-url.js";

type ImageRunArgs = {
  readonly prisma: PrismaClient;
  readonly fetchFn: FetchLike;
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly projectId: string;
  readonly image: ArticleWorkflowImageAsset;
  readonly platformConfig: ArticleWorkflowPlatformConfig;
};

const sizeFor = (slot: ArticleWorkflowImageSlot, config: ArticleWorkflowPlatformConfig) =>
  slot === "cover" ? config.coverSize : config.inlineSize;

const altFor = (slot: ArticleWorkflowImageSlot, config: ArticleWorkflowPlatformConfig) => {
  const caption = config.outputKind === "caption";
  return slot === "cover" ? (caption ? "封面图" : "公众号头图") : (caption ? "配图" : "正文配图");
};

function batches<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size));
}

export async function generateArticleWorkflowImageAsset(args: ImageRunArgs): Promise<ArticleWorkflowImageAsset> {
  const size = sizeFor(args.image.slot, args.platformConfig);
  const requestId = `article:${args.projectId}:${args.image.slot}:${randomUUID()}`;
  const config = loadImageGenerationConfig(args.env);
  const stored = await withArticleWorkflowRetry({
    env: args.env,
    maxAttempts: ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS,
    work: async () => {
      const generated = await callImageGeneration({
        config,
        prompt: args.image.prompt,
        size,
        fetchFn: args.fetchFn,
        env: args.env,
      });
      return storeWorkflowImage({
        image: generated,
        userId: args.userId,
        requestId,
        requestIndex: 0,
        fetchFn: args.fetchFn,
        env: args.env,
      });
    },
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
  const stableUrl = (url: string) => articleWorkflowStorableImageUrl({
    url,
    assetId: asset.id,
    objectKey: stored.objectKey,
  });
  return {
    ...args.image,
    assetId: asset.id,
    imageUrl: stableUrl(stored.originalUrl),
    thumbnailUrl: stableUrl(stored.thumbnailUrl),
    alt: args.image.alt.trim() || altFor(args.image.slot, args.platformConfig),
  };
}

export async function populateArticleWorkflowImages(args: {
  readonly prisma: PrismaClient;
  readonly fetchFn: FetchLike;
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly projectId: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  readonly force?: boolean;
  readonly onProgress?: (completed: number, total: number) => Promise<void>;
}): Promise<readonly ArticleWorkflowImageAsset[]> {
  const targets = args.force ? args.imageManifest : args.imageManifest.filter((image) => !image.imageUrl.trim());
  if (!targets.length) return args.imageManifest;

  const replacements = new Map<ArticleWorkflowImageSlot, ArticleWorkflowImageAsset>();
  let completed = 0;
  for (const group of batches(targets, ARTICLE_IMAGE_BATCH_SIZE)) {
    const generated = await Promise.all(group.map((image) => generateArticleWorkflowImageAsset({ ...args, image })));
    generated.forEach((image) => replacements.set(image.slot, image));
    completed += generated.length;
    await args.onProgress?.(completed, targets.length);
  }
  return args.imageManifest.map((image) => replacements.get(image.slot) ?? image);
}
