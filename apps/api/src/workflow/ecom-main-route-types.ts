import { z } from "zod";
import { ecomImageModelSchema, productSchema } from "./ecom-route-types.js";
import { ECOM_MAIN_MAX_COUNT, ECOM_MAIN_MIN_COUNT, ECOM_MAIN_RATIOS, ECOM_MAIN_STYLE_IDS } from "./ecom-main.js";
import { IMAGE_MAX_REFERENCE_COUNT } from "./image-service.js";

export const mainImageRequestSchema = z.object({
  platformId: z.string().trim().min(1).max(64),
  ratio: z.enum(ECOM_MAIN_RATIOS),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  model: ecomImageModelSchema.optional(),
  style: z.enum(ECOM_MAIN_STYLE_IDS),
  customStyle: z.string().trim().max(500).default(""),
  withText: z.boolean().default(true),
  count: z.coerce.number().int().min(ECOM_MAIN_MIN_COUNT).max(ECOM_MAIN_MAX_COUNT),
  product: productSchema,
  referenceAssetIds: z.array(z.string().trim().min(1).max(128)).max(IMAGE_MAX_REFERENCE_COUNT).default([]),
});

export const mainJobParamsSchema = z.object({ jobId: z.string().trim().min(1).max(128) });
export const mainImageParamsSchema = mainJobParamsSchema.extend({
  index: z.coerce.number().int().min(0).max(ECOM_MAIN_MAX_COUNT - 1),
});

export type MainImageRequest = z.infer<typeof mainImageRequestSchema>;
