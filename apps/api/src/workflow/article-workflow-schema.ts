import { z } from "zod";
import {
  ARTICLE_WORKFLOW_GENERATION_MODES,
  ARTICLE_WORKFLOW_IMAGE_SLOTS,
  ARTICLE_WORKFLOW_PLATFORMS,
  ARTICLE_WORKFLOW_SOURCE_FORMATS,
} from "@ai-assistant/article-workflow";
import { ARTICLE_MAX_SOURCE_LENGTH } from "./article-workflow-shared.js";

const sourceFormatSchema = z.enum(ARTICLE_WORKFLOW_SOURCE_FORMATS);
const generationModeSchema = z.enum(ARTICLE_WORKFLOW_GENERATION_MODES);
const imageSlotSchema = z.enum(ARTICLE_WORKFLOW_IMAGE_SLOTS);
export const articleWorkflowPlatformSchema = z.enum(ARTICLE_WORKFLOW_PLATFORMS);

/** 话题标签：统一去掉前导 #，长度与数量取三平台里最宽的上限，具体裁剪交给平台归一化。 */
export const articleWorkflowTagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(8)
  .default([]);

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

/**
 * caption 计划：字数上限收得比平台硬限制宽，让 LLM 的轻微超标先落地，
 * 再由 normalizeArticleWorkflowCaptionPlan 按平台裁剪——超字数重跑的钱不该由用户出。
 */
export const articleWorkflowCaptionPlanSchema = z.object({
  title: z.string().trim().min(1).max(200),
  captionText: z.string().trim().min(1).max(20_000),
  tags: articleWorkflowTagsSchema,
  images: z.array(articleWorkflowImageManifestItemSchema.omit({
    assetId: true,
    imageUrl: true,
    thumbnailUrl: true,
  })).min(1).max(5),
});

export const createArticleWorkflowProjectSchema = z.object({
  sourceFormat: sourceFormatSchema,
  sourceText: z.string().trim().min(1).max(ARTICLE_MAX_SOURCE_LENGTH),
  /** 期望模式；caption 平台会被 resolveArticleWorkflowMode 降级为 polish-text */
  generationMode: generationModeSchema.optional().default("preserve-text"),
  /** 缺省 ["wechat"] 兼容旧客户端；重复平台按首次出现顺序去重 */
  platforms: z
    .array(articleWorkflowPlatformSchema)
    .min(1)
    // 长度上限只为挡住畸形入参；去重后天然不超过平台总数，重复传同一平台不该报错
    .max(ARTICLE_WORKFLOW_PLATFORMS.length * 4)
    .optional()
    .default(["wechat"])
    .transform((platforms) => [...new Set(platforms)]),
});

export const articleWorkflowProjectParamsSchema = z.object({
  id: z.string().trim().min(1).max(160),
});

export const articleWorkflowBatchParamsSchema = z.object({
  batchId: z.string().trim().min(1).max(160),
});

export const articleWorkflowImageParamsSchema = articleWorkflowProjectParamsSchema.extend({
  slot: imageSlotSchema,
});

export const updateArticleWorkflowProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(300).default(""),
  bodyHtml: z.string().trim().min(1).max(500_000),
});

/** caption 平台的手工保存：标题上限取三平台最宽，具体裁剪由前端按平台提示，后端只兜底长度 */
export const updateArticleWorkflowCaptionProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(300).optional(),
  captionText: z.string().trim().min(1).max(20_000),
  tags: articleWorkflowTagsSchema,
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
export type ArticleWorkflowCaptionPlan = z.infer<typeof articleWorkflowCaptionPlanSchema>;
export type CreateArticleWorkflowProjectInput = z.infer<typeof createArticleWorkflowProjectSchema>;
export type ArticleWorkflowProjectParams = z.infer<typeof articleWorkflowProjectParamsSchema>;
export type ArticleWorkflowImageParams = z.infer<typeof articleWorkflowImageParamsSchema>;
export type UpdateArticleWorkflowProjectInput = z.infer<typeof updateArticleWorkflowProjectSchema>;
export type UpdateArticleWorkflowCaptionProjectInput =
  z.infer<typeof updateArticleWorkflowCaptionProjectSchema>;
export type RewriteArticleWorkflowProjectInput = z.infer<typeof rewriteArticleWorkflowProjectSchema>;
export type RegenerateArticleWorkflowImageInput = z.infer<typeof regenerateArticleWorkflowImageSchema>;
