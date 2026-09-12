import { z } from "zod";
import { ARTICLE_WORKFLOW_IMAGE_SLOTS, ARTICLE_WORKFLOW_TOPIC_PRESETS } from "@ai-assistant/article-workflow";

const imageSlot = z.enum(ARTICLE_WORKFLOW_IMAGE_SLOTS);
const plannedImage = z.object({
  slot: imageSlot,
  role: z.enum(["cover", "inline"]),
  assetId: z.string().trim().max(160).nullable().default(null),
  imageUrl: z.string().trim().max(3_000_000).default(""),
  thumbnailUrl: z.string().trim().max(3_000_000).default(""),
  alt: z.string().trim().max(240).default(""),
  caption: z.string().trim().max(400).default(""),
  prompt: z.string().trim().min(1).max(4_000),
});

export const articleWorkflowImageManifestItemSchema = plannedImage;
export const articleWorkflowTagsSchema = z.array(z.string().trim().min(1).max(40)).max(8).default([]);

const topicStyle = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preset"), preset: z.enum(ARTICLE_WORKFLOW_TOPIC_PRESETS) }),
  z.object({ mode: z.literal("custom"), instruction: z.string().trim().min(1).max(2_000) }),
  z.object({ mode: z.literal("imitate"), referenceText: z.string().trim().min(1).max(20_000) }),
]);

export const articleWorkflowCreationConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("source"), generateImages: z.boolean().optional().default(true) }),
  z.object({
    mode: z.literal("topic"),
    generateImages: z.boolean().optional().default(false),
    topic: z.string().trim().min(1).max(200),
    keyPoints: z.string().trim().max(4_000).optional().default(""),
    audience: z.string().trim().max(500).optional().default(""),
    avoid: z.string().trim().max(2_000).optional().default(""),
    style: topicStyle,
  }),
]);

const modelImages = plannedImage.omit({ assetId: true, imageUrl: true, thumbnailUrl: true }).array().min(1).max(5);

export const articleWorkflowPlanSchema = z.object({
  title: z.string().trim().max(120).default(""),
  summary: z.string().trim().max(300).default(""),
  bodyMarkdown: z.string().trim().min(1).max(500_000),
  images: modelImages,
});

export const articleWorkflowCaptionPlanSchema = z.object({
  title: z.string().trim().min(1).max(200),
  captionText: z.string().trim().min(1).max(20_000),
  tags: articleWorkflowTagsSchema,
  images: modelImages,
});
