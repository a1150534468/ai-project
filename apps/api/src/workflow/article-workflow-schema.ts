import { z } from "zod";
import {
  ARTICLE_WORKFLOW_GENERATION_MODES,
  ARTICLE_WORKFLOW_IMAGE_SLOTS,
  ARTICLE_WORKFLOW_SOURCE_FORMATS,
} from "@ai-assistant/article-workflow";
import { ARTICLE_MAX_SOURCE_LENGTH } from "./article-workflow-shared.js";

const sourceFormatSchema = z.enum(ARTICLE_WORKFLOW_SOURCE_FORMATS);
const generationModeSchema = z.enum(ARTICLE_WORKFLOW_GENERATION_MODES);
const imageSlotSchema = z.enum(ARTICLE_WORKFLOW_IMAGE_SLOTS);

export const articleWorkflowImageManifestItemSchema = z.object({
  slot: imageSlotSchema,
  role: z.enum(["cover", "inline"]),
  assetId: z.string().trim().max(160).nullable().default(null),
  imageUrl: z.string().trim().max(3_000_000).default(""),
  thumbnailUrl: z.string().trim().max(3_000_000).default(""),
  alt: z.string().trim().max(240).default(""),
  caption: z.string().trim().max(400).default(""),
  prompt: z.string().trim().min(1).max(4000),
});

export const articleWorkflowPlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(300).default(""),
  bodyMarkdown: z.string().trim().min(1).max(500_000),
  images: z.array(articleWorkflowImageManifestItemSchema.omit({
    assetId: true,
    imageUrl: true,
    thumbnailUrl: true,
  })).min(1).max(5),
});

export const createArticleWorkflowProjectSchema = z.object({
  sourceFormat: sourceFormatSchema,
  sourceText: z.string().trim().min(1).max(ARTICLE_MAX_SOURCE_LENGTH),
  generationMode: generationModeSchema.optional().default("preserve-text"),
});

export const articleWorkflowProjectParamsSchema = z.object({
  id: z.string().trim().min(1).max(160),
});

export const articleWorkflowImageParamsSchema = articleWorkflowProjectParamsSchema.extend({
  slot: imageSlotSchema,
});

export const updateArticleWorkflowProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(300).default(""),
  bodyHtml: z.string().trim().min(1).max(500_000),
});

export const rewriteArticleWorkflowProjectSchema = z.object({
  instruction: z.string().trim().min(1).max(3000),
  generationMode: generationModeSchema.optional(),
  regenerateImages: z.boolean().optional().default(false),
});

export const regenerateArticleWorkflowImageSchema = z.object({
  promptOverride: z.string().trim().min(1).max(4000).optional(),
});

export type ArticleWorkflowPlan = z.infer<typeof articleWorkflowPlanSchema>;
export type CreateArticleWorkflowProjectInput = z.infer<typeof createArticleWorkflowProjectSchema>;
export type ArticleWorkflowProjectParams = z.infer<typeof articleWorkflowProjectParamsSchema>;
export type ArticleWorkflowImageParams = z.infer<typeof articleWorkflowImageParamsSchema>;
export type UpdateArticleWorkflowProjectInput = z.infer<typeof updateArticleWorkflowProjectSchema>;
export type RewriteArticleWorkflowProjectInput = z.infer<typeof rewriteArticleWorkflowProjectSchema>;
export type RegenerateArticleWorkflowImageInput = z.infer<typeof regenerateArticleWorkflowImageSchema>;
