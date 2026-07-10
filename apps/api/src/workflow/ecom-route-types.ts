import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ECOM_MAX_SEGMENTS, ECOM_MIN_SEGMENTS } from "./ecom-prompts.js";
import type { ImageGenerationConfig, GeneratedImage, StoredImage } from "./image-service.js";
import type { WorkflowMutationLocker } from "./ecom-route-mutation.js";
import type { WorkflowResourcePriceRow } from "./workflow-pricing.js";

export const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(200).default(""),
  sellingPoints: z.array(z.string().trim().max(200)).max(12).default([]),
  extra: z.string().trim().max(2_000).default(""),
});

export const inlineImageSchema = z.object({
  b64: z.string().trim().min(1),
  mime: z.string().trim().regex(/^image\/[A-Za-z0-9.+-]+$/).optional(),
});

export const masterRequestSchema = z.object({
  platformId: z.string().trim().min(1).max(64),
  templateId: z.string().trim().min(1).max(64),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  segmentCount: z.coerce.number().int().min(ECOM_MIN_SEGMENTS).max(ECOM_MAX_SEGMENTS).default(3),
  product: productSchema,
  referenceAssetIds: z.array(z.string().trim().min(1).max(128)).max(8).default([]),
});

// adopt-master 复用已生成的主图作为母版：母版图已选定，商品名称可留空（分段对空产品信息有兜底），
// 因此放宽 product.name 为可选，避免"选主图当母版时因表单商品名为空而 400"。
export const adoptMasterRequestSchema = masterRequestSchema.extend({
  product: productSchema.extend({ name: z.string().trim().max(200).default("") }),
  masterAssetId: z.string().trim().min(1).max(128),
});
export type AdoptMasterRequest = z.infer<typeof adoptMasterRequestSchema>;

export const workflowParamsSchema = z.object({
  workflowId: z.string().trim().min(1).max(128),
});

export const segmentParamsSchema = workflowParamsSchema.extend({
  index: z.coerce.number().int().min(0).max(ECOM_MAX_SEGMENTS - 1),
});

export const imageBodySchema = z.object({
  image: inlineImageSchema,
});

export const segmentRecordSchema = z.object({
  index: z.number().int().min(0).max(ECOM_MAX_SEGMENTS - 1),
  assetId: z.string().trim().min(1),
  originalUrl: z.string().trim().min(1),
  thumbnailUrl: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
});

export type ProductInput = z.infer<typeof productSchema>;
export type InlineImageInput = z.infer<typeof inlineImageSchema>;
export type MasterRequest = z.infer<typeof masterRequestSchema>;
export type SegmentRecord = z.infer<typeof segmentRecordSchema>;

export type BillingForEcom = {
  readonly chargeResource: (args: { operationId: string; userId: string; resourceKey: string; units: number }) => Promise<{ charged: number }>;
  readonly refundResource: (operationId: string) => Promise<{ success: boolean }>;
  readonly listResourcePrices?: () => Promise<{ data: WorkflowResourcePriceRow[] }>;
};

export type EcomRouteDeps = {
  readonly prisma?: PrismaClient;
  readonly billing?: BillingForEcom;
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
    referenceImages: readonly InlineImageInput[];
    fetchFn: typeof fetch;
    size?: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }) => Promise<GeneratedImage>;
  readonly retryUntilSuccess?: <T>(fn: () => Promise<T>, options: {
    retryDelayMs: number;
    maxAttempts?: number;
    onRetry?: (error: unknown, attempt: number) => Promise<void>;
    shouldStop?: (error: unknown) => boolean;
  }) => Promise<T>;
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
  readonly workflowMutationLocker?: WorkflowMutationLocker;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
};
