import { z } from "zod";
import {
  ARTICLE_WORKFLOW_CREATION_MODES,
  ARTICLE_WORKFLOW_GALLERY_MODES,
  ARTICLE_WORKFLOW_GENERATION_MODES,
  ARTICLE_WORKFLOW_IMAGE_SLOTS,
  ARTICLE_WORKFLOW_PLATFORMS,
  ARTICLE_WORKFLOW_SOURCE_FORMATS,
  ARTICLE_WORKFLOW_THEMES,
  ARTICLE_WORKFLOW_TOPIC_PRESETS,
} from "@ai-assistant/article-workflow";
import { ARTICLE_MAX_SOURCE_LENGTH } from "./article-workflow-shared.js";

const sourceFormatSchema = z.enum(ARTICLE_WORKFLOW_SOURCE_FORMATS);
const generationModeSchema = z.enum(ARTICLE_WORKFLOW_GENERATION_MODES);
const creationModeSchema = z.enum(ARTICLE_WORKFLOW_CREATION_MODES);
const imageSlotSchema = z.enum(ARTICLE_WORKFLOW_IMAGE_SLOTS);
export const articleWorkflowPlatformSchema = z.enum(ARTICLE_WORKFLOW_PLATFORMS);
export const articleWorkflowThemeSchema = z.enum(ARTICLE_WORKFLOW_THEMES);
export const articleWorkflowGalleryModeSchema = z.enum(ARTICLE_WORKFLOW_GALLERY_MODES);
/** 主色覆盖：可选 3/6 位 hex，缺省 = 用主题默认主色。前端未选色时传 null，故按 nullish 收。 */
export const articleWorkflowThemeColorSchema = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  .nullish();

/** 话题标签：统一去掉前导 #，长度与数量取三平台里最宽的上限，具体裁剪交给平台归一化。 */
export const articleWorkflowTagsSchema = z.array(z.string().trim().min(1).max(40)).max(8).default([]);

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

const articleWorkflowTopicStyleSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("preset"),
    preset: z.enum(ARTICLE_WORKFLOW_TOPIC_PRESETS),
  }),
  z.object({
    mode: z.literal("custom"),
    instruction: z.string().trim().min(1).max(2_000),
  }),
  z.object({
    mode: z.literal("imitate"),
    referenceText: z.string().trim().min(1).max(20_000),
  }),
]);

export const articleWorkflowCreationConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("source"),
    generateImages: z.boolean().optional().default(true),
  }),
  z.object({
    mode: z.literal("topic"),
    generateImages: z.boolean().optional().default(false),
    topic: z.string().trim().min(1).max(200),
    keyPoints: z.string().trim().max(4_000).optional().default(""),
    audience: z.string().trim().max(500).optional().default(""),
    avoid: z.string().trim().max(2_000).optional().default(""),
    style: articleWorkflowTopicStyleSchema,
  }),
]);

/**
 * html-fragment 计划。
 *
 * title 允许为空串，由 normalizeArticleWorkflowPlan 从正文兜出一个——
 * 正文与配图都齐了却因为缺个标题整单失败，用户要白付一次文本费再重跑，
 * 这与 caption 链路「一律归一化，不抛错」的取舍保持一致。
 */
export const articleWorkflowPlanSchema = z.object({
  title: z.string().trim().max(120).default(""),
  summary: z.string().trim().max(300).default(""),
  bodyMarkdown: z.string().trim().min(1).max(500_000),
  images: z
    .array(
      articleWorkflowImageManifestItemSchema.omit({
        assetId: true,
        imageUrl: true,
        thumbnailUrl: true,
      }),
    )
    .min(1)
    .max(5),
});

/**
 * caption 计划：字数上限收得比平台硬限制宽，让 LLM 的轻微超标先落地，
 * 再由 normalizeArticleWorkflowCaptionPlan 按平台裁剪——超字数重跑的钱不该由用户出。
 */
export const articleWorkflowCaptionPlanSchema = z.object({
  title: z.string().trim().min(1).max(200),
  captionText: z.string().trim().min(1).max(20_000),
  tags: articleWorkflowTagsSchema,
  images: z
    .array(
      articleWorkflowImageManifestItemSchema.omit({
        assetId: true,
        imageUrl: true,
        thumbnailUrl: true,
      }),
    )
    .min(1)
    .max(5),
});

export const createArticleWorkflowProjectSchema = z
  .object({
    creationMode: creationModeSchema.optional().default("source"),
    creationConfig: articleWorkflowCreationConfigSchema.optional(),
    sourceFormat: sourceFormatSchema,
    sourceText: z.string().trim().max(ARTICLE_MAX_SOURCE_LENGTH).optional().default(""),
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
    generateImages: z.boolean().optional().default(true),
    /** 公众号排版主题；caption-only 批次会被静默忽略（仍存 auto） */
    theme: articleWorkflowThemeSchema.optional().default("auto"),
    /** 主色覆盖，仅 theme != auto 时生效 */
    themeColor: articleWorkflowThemeColorSchema,
    /** 配图画廊布局模式，仅 theme != auto 时生效；caption 平台忽略 */
    galleryMode: articleWorkflowGalleryModeSchema.optional().default("collage"),
  })
  .superRefine((value, context) => {
    if (value.creationMode === "source") {
      if (!value.sourceText) {
        context.addIssue({ code: "custom", path: ["sourceText"], message: "原文不能为空" });
      }
      if (value.creationConfig && value.creationConfig.mode !== "source") {
        context.addIssue({ code: "custom", path: ["creationConfig"], message: "创作配置与模式不匹配" });
      }
      return;
    }
    if (!value.creationConfig || value.creationConfig.mode !== "topic") {
      context.addIssue({ code: "custom", path: ["creationConfig"], message: "主题创作配置不能为空" });
    }
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

export const articleWorkflowImageBlobParamsSchema = z.object({
  assetId: z.string().trim().min(1).max(160),
});

/** 取图地址上的短期签名。缺省即视为「没带签名」，回落到会话鉴权。 */
export const articleWorkflowImageBlobQuerySchema = z.object({
  exp: z
    .string()
    .trim()
    .regex(/^\d{1,15}$/)
    .optional(),
  sig: z.string().trim().min(1).max(256).optional(),
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

/** 确定性主题换肤：改主题/主色/画廊模式，后端按 bodyMarkdown 重渲正文。 */
export const updateArticleWorkflowThemeSchema = z.object({
  theme: articleWorkflowThemeSchema,
  themeColor: articleWorkflowThemeColorSchema,
  galleryMode: articleWorkflowGalleryModeSchema.optional().default("collage"),
});

export type ArticleWorkflowPlan = z.infer<typeof articleWorkflowPlanSchema>;
export type ArticleWorkflowCaptionPlan = z.infer<typeof articleWorkflowCaptionPlanSchema>;
export type CreateArticleWorkflowProjectInput = z.infer<typeof createArticleWorkflowProjectSchema>;
export type ArticleWorkflowProjectParams = z.infer<typeof articleWorkflowProjectParamsSchema>;
export type ArticleWorkflowImageParams = z.infer<typeof articleWorkflowImageParamsSchema>;
export type UpdateArticleWorkflowProjectInput = z.infer<typeof updateArticleWorkflowProjectSchema>;
export type UpdateArticleWorkflowCaptionProjectInput = z.infer<typeof updateArticleWorkflowCaptionProjectSchema>;
export type RewriteArticleWorkflowProjectInput = z.infer<typeof rewriteArticleWorkflowProjectSchema>;
export type RegenerateArticleWorkflowImageInput = z.infer<typeof regenerateArticleWorkflowImageSchema>;
export type UpdateArticleWorkflowThemeInput = z.infer<typeof updateArticleWorkflowThemeSchema>;
