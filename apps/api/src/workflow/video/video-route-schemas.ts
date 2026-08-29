/**
 * video-routes 拆分后的请求校验层:11 条路由的入参 zod schema 与由此推导的请求类型。
 *
 * `videoRequestSchema` 的 7 条 `superRefine` 是这一层的全部价值 —— 模型 / 分辨率 /
 * 时长 / 角色图的合法组合只在这里判一次,路由拿到 `parsed.data` 之后不再复查。所以
 * 新增机型或分辨率时改的是 `../_shared/video-service.js` 的常量表,不是这里的 if。
 *
 * `VideoGenerationRequest` 是 `z.infer` 出来的,不要手写一份等价 interface:手写的那份
 * 会和 schema 悄悄分叉,而 `normalizeRequest` 正是靠这个类型保证"校验过的形状"。
 *
 * 依赖方向:本文件是叶子(只依赖 zod 与 video-service 常量)。不 import 同域任何文件。
 */

import { z } from "zod";
import {
  AUDIO_REFERENCE_ROLE,
  VIDEO_ASPECT_RATIOS,
  VIDEO_IMAGE_ROLES,
  VIDEO_MODELS,
  VIDEO_REFERENCE_ROLE,
  VIDEO_RESOLUTIONS,
  isDurationSupported,
  isResolutionSupported,
} from "../_shared/video-service.js";

const imageRoleSchema = z.object({
  url: z.string().trim().min(1).max(8000),
  role: z.enum(VIDEO_IMAGE_ROLES),
});

const videoRoleSchema = z.object({
  url: z.string().trim().min(1).max(8000),
  role: z.literal(VIDEO_REFERENCE_ROLE),
});

const audioRoleSchema = z.object({
  url: z.string().trim().min(1).max(8000),
  role: z.literal(AUDIO_REFERENCE_ROLE),
});

export const videoRequestSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  prompt: z.string().trim().min(1).max(2000),
  model: z.enum(VIDEO_MODELS).default("seedance-2"),
  durationSec: z.number().int().gte(-1).lte(15),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).default("9:16"),
  resolution: z.enum(VIDEO_RESOLUTIONS).default("720p"),
  generateAudio: z.boolean().default(true),
  imageWithRoles: z.array(imageRoleSchema).max(9).default([]),
  videoWithRoles: z.array(videoRoleSchema).max(3).default([]),
  audioWithRoles: z.array(audioRoleSchema).max(3).default([]),
  seed: z.number().int().optional(),
}).superRefine((value, ctx) => {
  if (!isResolutionSupported(value.model, value.resolution)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "该模型不支持所选分辨率", path: ["resolution"] });
  }
  if (!isDurationSupported(value.model, value.durationSec)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "该模型不支持所选时长", path: ["durationSec"] });
  }
  if (value.model === "seedance-2-mini" && value.imageWithRoles.some((item) => item.role !== "reference_image")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mini 模型只支持参考图", path: ["imageWithRoles"] });
  }
  const hasFrameMode = value.imageWithRoles.some((item) => item.role === "first_frame" || item.role === "last_frame");
  const hasReferenceMode = value.imageWithRoles.some((item) => item.role === "reference_image") || value.videoWithRoles.length > 0 || value.audioWithRoles.length > 0;
  if (hasFrameMode && hasReferenceMode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "首帧/首尾帧模式不能和参考素材模式混用", path: ["imageWithRoles"] });
  }
  if (value.audioWithRoles.length > 0 && value.imageWithRoles.length === 0 && value.videoWithRoles.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "音频参考不能单独使用", path: ["audioWithRoles"] });
  }
  if (value.imageWithRoles.filter((item) => item.role === "first_frame").length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "首帧图最多 1 张", path: ["imageWithRoles"] });
  }
  if (value.imageWithRoles.filter((item) => item.role === "last_frame").length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "尾帧图最多 1 张", path: ["imageWithRoles"] });
  }
});

export type VideoGenerationRequest = z.infer<typeof videoRequestSchema>;

export const optimizePromptSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  materials: z.object({
    image: z.number().int().min(0).max(9).default(0),
    video: z.number().int().min(0).max(3).default(0),
    audio: z.number().int().min(0).max(3).default(0),
  }).optional(),
});

// —— 帮我写向导 schemas ——
export const analyzeMaterialsSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  materials: z.array(z.object({ url: z.string().trim().min(1).max(8000), mime: z.string().trim().min(1).max(100) })).min(1).max(15),
});
const insightObjSchema = z.object({
  productName: z.string().max(200).default(""),
  category: z.string().max(200).default(""),
  features: z.array(z.string().max(200)).max(20).default([]),
  sellingPoints: z.array(z.string().max(200)).max(20).default([]),
  audience: z.array(z.string().max(200)).max(20).default([]),
  scenes: z.array(z.string().max(200)).max(20).default([]),
});
export const generateScriptSchema = z.object({
  insight: insightObjSchema,
  business: z.string().max(50),
  language: z.string().max(50),
  contentType: z.string().max(50),
  shootType: z.string().max(50),
  note: z.string().max(2000).default(""),
  durationSec: z.number().int().gte(1).lte(15),
  hasNarration: z.boolean().optional(),
  materials: z.object({
    image: z.number().int().min(0).max(9),
    video: z.number().int().min(0).max(3),
    audio: z.number().int().min(0).max(3),
  }).optional(),
  reference: z.object({ script: z.string().max(20000), highlights: z.array(z.string().max(500)).max(20) }).optional(),
});
