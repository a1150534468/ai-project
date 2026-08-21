import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  storeWorkflowImage,
  type GeneratedImage,
  type ImageGenerationConfig,
  type StoredImage,
} from "./_shared/image-service.js";

export type FetchLike = typeof fetch;

export const projectParamsSchema = z.object({ projectId: z.string().min(1) });
export const episodeParamsSchema = z.object({ episodeId: z.string().min(1) });
export const assetParamsSchema = z.object({ assetId: z.string().min(1) });
export const shotParamsSchema = z.object({ shotId: z.string().min(1) });

export const createAssetSchema = z.object({
  type: z.enum(["character", "scene", "prop", "style"]),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(""),
  prompt: z.string().trim().max(3000).default(""),
  imageAssetId: z.string().trim().min(1).optional(),
});

export const updateAssetSchema = createAssetSchema.partial();

export const generateImageSchema = z.object({
  prompt: z.string().trim().max(3000).optional(),
  size: z.string().trim().max(24).default("1024x1024"),
});

export const createShotSchema = z.object({
  title: z.string().trim().max(80).default(""),
  description: z.string().trim().min(1).max(3000),
  dialogue: z.string().trim().max(2000).default(""),
  camera: z.string().trim().max(600).default(""),
  durationSec: z.number().int().min(1).max(30).default(5),
  assetIds: z.array(z.string().trim().min(1)).max(8).default([]),
});

export const updateShotSchema = createShotSchema.partial();

export const generateShotListSchema = z.object({
  replaceExisting: z.boolean().default(true),
});

export const generateVideoSchema = z.object({
  modelId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().max(3000).optional(),
  durationSec: z.number().int().min(3).max(10).optional(),
  resolution: z.string().trim().max(24).optional(),
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

interface ImageAssetRef {
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
}

interface AssetSerializable {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly imageAssetId: string | null;
  readonly source: string;
  readonly updatedAt: Date;
  readonly imageAsset?: ImageAssetRef | null;
}

interface ShotSerializable {
  readonly id: string;
  readonly episodeId: string;
  readonly shotNo: number;
  readonly title: string;
  readonly description: string;
  readonly dialogue: string;
  readonly camera: string;
  readonly durationSec: number;
  readonly assetIds: readonly string[];
  readonly imageAssetId: string | null;
  readonly videoUrl: string | null;
  readonly videoStatus: string;
  readonly videoTaskId: string | null;
  readonly updatedAt: Date;
  readonly imageAsset?: ImageAssetRef | null;
}

export function serializeAsset(row: AssetSerializable | null) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    imageAssetId: row.imageAssetId,
    imageUrl: row.imageAsset?.originalUrl ?? null,
    thumbnailUrl: row.imageAsset?.thumbnailUrl ?? null,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeShot(row: ShotSerializable | null) {
  if (!row) return null;
  return {
    id: row.id,
    episodeId: row.episodeId,
    shotNo: row.shotNo,
    title: row.title,
    description: row.description,
    dialogue: row.dialogue,
    camera: row.camera,
    durationSec: row.durationSec,
    assetIds: row.assetIds,
    imageAssetId: row.imageAssetId,
    imageUrl: row.imageAsset?.originalUrl ?? null,
    thumbnailUrl: row.imageAsset?.thumbnailUrl ?? null,
    videoUrl: row.videoUrl,
    videoStatus: row.videoStatus,
    videoTaskId: row.videoTaskId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function persistGeneratedImage(args: {
  readonly prisma: PrismaClient;
  readonly fetchFn: FetchLike;
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly prompt: string;
  readonly size: string;
  readonly config: ImageGenerationConfig;
  readonly image: GeneratedImage;
}): Promise<string> {
  const requestId = `comic:${randomUUID()}`;
  const stored: StoredImage = await storeWorkflowImage({
    image: args.image,
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
      prompt: args.prompt,
      model: args.config.model,
      size: args.size,
      originalUrl: stored.originalUrl,
      thumbnailUrl: stored.thumbnailUrl,
      objectKey: stored.objectKey,
      mime: stored.mime,
    },
  });
  return asset.id;
}

export function shotChunks(scriptText: string): readonly string[] {
  const chunks = scriptText.split(/\n\s*\n/u).map((chunk) => chunk.trim()).filter(Boolean);
  if (chunks.length > 0) return chunks.slice(0, 40);
  return scriptText.split(/[。！？.!?]\s*/u).map((chunk) => chunk.trim()).filter(Boolean).slice(0, 40);
}
