import { z } from "zod";
import {
  LOCAL_BUSINESS_PROMO_ASPECT_RATIOS,
  LOCAL_BUSINESS_PROMO_DIRECTIONS,
  LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS,
  LOCAL_BUSINESS_PROMO_MUSIC_PRESETS,
  LOCAL_BUSINESS_PROMO_NARRATION_VOICES,
  LOCAL_BUSINESS_PROMO_PROGRESS_STAGES,
  LOCAL_BUSINESS_PROMO_PROJECT_STATUSES,
  LOCAL_BUSINESS_PROMO_RUN_STATUSES,
  LOCAL_BUSINESS_PROMO_SUBTITLE_PLACEMENTS,
  LOCAL_BUSINESS_PROMO_SUBTITLE_STYLES,
  LOCAL_BUSINESS_PROMO_VOICE_MODES,
  type LocalBusinessPromoProgressStage,
  type LocalBusinessPromoProjectStatus,
  type LocalBusinessPromoRunStatus,
} from "./local-business-promo-core-types.js";

const LOCAL_BUSINESS_PROMO_DURATION_SCHEMA = z.union([z.literal(25), z.literal(40), z.literal(60)]);

export const localBusinessPromoBriefSchema = z.object({
  storeName: z.string().trim().max(120).default(""),
  industry: z.string().trim().max(80).default(""),
  cityArea: z.string().trim().max(120).default(""),
  targetCustomers: z.string().trim().max(300).default(""),
  mainOffer: z.string().trim().max(300).default(""),
  sellingPoints: z.string().trim().max(600).default(""),
});

export const localBusinessPromoMaterialSchema = z.object({
  url: z.string().trim().min(1).max(8000),
  mime: z.string().trim().min(1).max(120).refine((value) => value.startsWith("image/") || value.startsWith("video/"), "仅支持图片和视频"),
  name: z.string().trim().max(200).default(""),
  durationSec: z.number().int().min(0).max(1800).default(0),
  objectKey: z.string().trim().max(800).nullable().optional(),
  groupHint: z.enum(LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS).optional(),
});

export const localBusinessPromoMaterialsSchema = z.object({
  opening: z.array(localBusinessPromoMaterialSchema).max(12).default([]),
  process: z.array(localBusinessPromoMaterialSchema).max(12).default([]),
  environment: z.array(localBusinessPromoMaterialSchema).max(12).default([]),
  result: z.array(localBusinessPromoMaterialSchema).max(12).default([]),
});

export const localBusinessPromoSettingsSchema = z.object({
  direction: z.enum(LOCAL_BUSINESS_PROMO_DIRECTIONS).default("store-trust"),
  durationSec: LOCAL_BUSINESS_PROMO_DURATION_SCHEMA.default(25),
  aspectRatio: z.enum(LOCAL_BUSINESS_PROMO_ASPECT_RATIOS).default("9:16"),
  subtitleStyle: z.enum(LOCAL_BUSINESS_PROMO_SUBTITLE_STYLES).default("douyin-outline"),
  narrationVoice: z.enum(LOCAL_BUSINESS_PROMO_NARRATION_VOICES).default("vv-female-natural"),
  voiceMode: z.enum(LOCAL_BUSINESS_PROMO_VOICE_MODES).default("preset"),
  voiceDesignPrompt: z.string().trim().max(1200).default(""),
  voiceStylePrompt: z.string().trim().max(1200).default(""),
  musicPreset: z.enum(LOCAL_BUSINESS_PROMO_MUSIC_PRESETS).default("light-explore"),
});

export const localBusinessPromoShotPlanEntrySchema = z.object({
  shotId: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  durationSec: z.number().int().min(4).max(15),
  materialGroup: z.enum(LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS),
  fallbackGroups: z.array(z.enum(LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS)).max(4).default([]),
  scriptLine: z.string().trim().max(1200).default(""),
  subtitlePlacement: z.enum(LOCAL_BUSINESS_PROMO_SUBTITLE_PLACEMENTS).default("bottom"),
  prompt: z.string().trim().max(4000).default(""),
  materials: z.array(localBusinessPromoMaterialSchema).max(12).default([]),
  requestId: z.string().trim().max(160).optional(),
  taskId: z.string().trim().max(160).nullable().optional(),
  taskStatus: z.enum(["queued", "running", "completed", "failed"]).default("queued"),
  selectedMaterialUrl: z.string().trim().max(8000).nullable().optional(),
  selectedMaterialName: z.string().trim().max(200).nullable().optional(),
  selectedMaterialMime: z.string().trim().max(120).nullable().optional(),
  sourceStartSec: z.number().min(0).max(1800).nullable().optional(),
  sourceEndSec: z.number().min(0).max(1800).nullable().optional(),
  renderMode: z.enum(["video-cut", "image-pan"]).nullable().optional(),
  assetId: z.string().trim().max(160).nullable().optional(),
  assetUrl: z.string().trim().max(8000).nullable().optional(),
  error: z.string().trim().max(1000).nullable().optional(),
});

export type LocalBusinessPromoBrief = z.infer<typeof localBusinessPromoBriefSchema>;
export type LocalBusinessPromoMaterial = z.infer<typeof localBusinessPromoMaterialSchema>;
export type LocalBusinessPromoMaterials = z.infer<typeof localBusinessPromoMaterialsSchema>;
export type LocalBusinessPromoSettings = z.infer<typeof localBusinessPromoSettingsSchema>;
export type LocalBusinessPromoShotPlanEntry = z.infer<typeof localBusinessPromoShotPlanEntrySchema>;

export function createEmptyBrief(): LocalBusinessPromoBrief {
  return localBusinessPromoBriefSchema.parse({});
}

export function createEmptyMaterials(): LocalBusinessPromoMaterials {
  return localBusinessPromoMaterialsSchema.parse({});
}

export function createDefaultSettings(): LocalBusinessPromoSettings {
  return localBusinessPromoSettingsSchema.parse({
    narrationVoice: "vv-female-natural",
    voiceMode: "preset",
    voiceDesignPrompt: "",
    voiceStylePrompt: "",
  });
}

export function normalizeBrief(value: unknown): LocalBusinessPromoBrief {
  return localBusinessPromoBriefSchema.safeParse(value).success
    ? localBusinessPromoBriefSchema.parse(value)
    : createEmptyBrief();
}

export function normalizeMaterials(value: unknown): LocalBusinessPromoMaterials {
  return localBusinessPromoMaterialsSchema.safeParse(value).success
    ? localBusinessPromoMaterialsSchema.parse(value)
    : createEmptyMaterials();
}

export function normalizeSettings(value: unknown): LocalBusinessPromoSettings {
  if (typeof value !== "object" || value === null) return createDefaultSettings();
  const record = value as Record<string, unknown>;
  const legacyPreset = typeof record.voicePreset === "string" ? record.voicePreset : null;
  const legacyNarrationVoice = legacyPreset === "male-warm"
    ? "vv-male-warm"
    : legacyPreset === "female-bright"
      ? "vv-female-bright"
      : legacyPreset === "male-steady"
        ? "vv-male-steady"
        : "vv-female-natural";
  const parsed = localBusinessPromoSettingsSchema.safeParse({
    ...createDefaultSettings(),
    ...record,
    voiceMode: typeof record.voiceMode === "string" && (LOCAL_BUSINESS_PROMO_VOICE_MODES as readonly string[]).includes(record.voiceMode)
      ? record.voiceMode
      : "preset",
    ...(legacyPreset && !record.narrationVoice ? { narrationVoice: legacyNarrationVoice } : {}),
  });
  return parsed.success ? parsed.data : createDefaultSettings();
}

export function normalizeShotPlan(value: unknown): LocalBusinessPromoShotPlanEntry[] {
  const parsed = z.array(localBusinessPromoShotPlanEntrySchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function isProjectStatus(value: string): value is LocalBusinessPromoProjectStatus {
  return (LOCAL_BUSINESS_PROMO_PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isRunStatus(value: string): value is LocalBusinessPromoRunStatus {
  return (LOCAL_BUSINESS_PROMO_RUN_STATUSES as readonly string[]).includes(value);
}

export function isProgressStage(value: string): value is LocalBusinessPromoProgressStage {
  return (LOCAL_BUSINESS_PROMO_PROGRESS_STAGES as readonly string[]).includes(value);
}
