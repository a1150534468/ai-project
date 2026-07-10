import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import {
  localBusinessPromoBriefSchema,
  localBusinessPromoMaterialsSchema,
  localBusinessPromoSettingsSchema,
  type LocalBusinessPromoSettings,
} from "./local-business-promo-core.js";
import type { enqueueLocalBusinessPromoRun } from "./local-business-promo-queue.js";
import type { GenerateLocalBusinessPromoScriptInput } from "./local-business-promo-script.js";

export type ProjectRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["localBusinessPromoProject"]["findFirst"]>>>;
export type RunRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["localBusinessPromoRun"]["findFirst"]>>>;
export type VideoAssetRow = Awaited<ReturnType<ReturnType<typeof getPrisma>["videoAsset"]["findFirst"]>>;
export type AudioAssetRow = Awaited<ReturnType<ReturnType<typeof getPrisma>["audioAsset"]["findFirst"]>>;
export type AudioTaskRow = Awaited<ReturnType<ReturnType<typeof getPrisma>["audioGenerationTask"]["findFirst"]>>;

export type PromoWorkflowBilling = Pick<ReturnType<typeof createBillingClient>, "reserve" | "settle" | "chargeResource" | "refundResource">;
export type ScriptGenerator = (input: GenerateLocalBusinessPromoScriptInput) => Promise<string>;

export interface LocalBusinessPromoRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: PromoWorkflowBilling;
  readonly fetchFn?: typeof fetch;
  readonly generateScript?: ScriptGenerator;
  readonly enqueueRun?: typeof enqueueLocalBusinessPromoRun;
}

export interface LocalBusinessPromoRouteContext {
  readonly prisma: PrismaClient;
  readonly billing: PromoWorkflowBilling;
  readonly fetchFn: typeof fetch;
  readonly generateScript: ScriptGenerator;
  readonly enqueueRun: typeof enqueueLocalBusinessPromoRun;
}

export const PROJECT_KEEP_LIMIT = 30;
export const RUN_KEEP_LIMIT = 20;
export const AUDIO_KEEP_LIMIT = 20;
export const PROJECT_AUDIO_BLOB_URL_TTL_MS = 15 * 60_000;
export const LOCAL_BUSINESS_PROMO_AUDIO_PREVIEW_TEXT = "您好，欢迎来到这里，今天带您快速了解一下这家店的特色服务。";
export const PRESET_NARRATION_PREVIEW_CACHE_VERSION = "v1";

export const createProjectSchema = z.object({
  title: z.string().trim().max(80).optional().default(""),
});

export const projectParamsSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
});

export const updateProjectSchema = z.object({
  title: z.string().trim().max(80).optional(),
  brief: localBusinessPromoBriefSchema.partial().optional(),
  materials: localBusinessPromoMaterialsSchema.optional(),
  settings: localBusinessPromoSettingsSchema.partial().optional(),
});

export const updateScriptSchema = z.object({
  scriptDraft: z.string().trim().max(10_000),
});

export const updateAudioActiveSchema = z.object({
  narrationAssetId: z.string().trim().max(160).nullable().optional(),
  bgmAssetId: z.string().trim().max(160).nullable().optional(),
});

export const projectAudioBlobQuerySchema = z.object({
  key: z.string().trim().min(1).max(1024),
  mime: z.string().trim().max(120).optional(),
  exp: z.string().trim().regex(/^\d+$/).transform((value) => Number(value)).optional(),
  sig: z.string().trim().max(200).optional(),
}).superRefine((value, ctx) => {
  const hasExp = value.exp !== undefined;
  const hasSig = value.sig !== undefined;
  if (hasExp !== hasSig) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "参数不合法",
    });
  }
});

export type NarrationVoice = LocalBusinessPromoSettings["narrationVoice"];
