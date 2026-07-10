export const LOCAL_BUSINESS_PROMO_DIRECTIONS = [
  "store-trust",
  "service-showcase",
  "offer-conversion",
  "city-seeding",
] as const;

export const LOCAL_BUSINESS_PROMO_DURATIONS = [25, 40, 60] as const;
export const LOCAL_BUSINESS_PROMO_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export const LOCAL_BUSINESS_PROMO_SUBTITLE_STYLES = [
  "douyin-outline",
  "xiaohongshu-clean",
  "bottom-clean",
  "none",
] as const;
export const LOCAL_BUSINESS_PROMO_SUBTITLE_PLACEMENTS = [
  "top",
  "bottom",
  "center",
  "none",
] as const;
export const LOCAL_BUSINESS_PROMO_NARRATION_VOICES = [
  "vv-female-natural",
  "vv-female-bright",
  "vv-male-warm",
  "vv-male-steady",
] as const;
export const LOCAL_BUSINESS_PROMO_VOICE_MODES = ["preset", "design", "clone"] as const;
export const LOCAL_BUSINESS_PROMO_VOICE_TEMPLATE_KEYS = ["local-business-guide"] as const;
export const LOCAL_BUSINESS_PROMO_MUSIC_PRESETS = [
  "light-explore",
  "city-lively",
  "warm-healing",
  "premium-clean",
  "no-bgm",
] as const;
export const LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS = ["opening", "process", "environment", "result"] as const;
export const LOCAL_BUSINESS_PROMO_PROJECT_STATUSES = ["draft", "generating", "completed", "failed"] as const;
export const LOCAL_BUSINESS_PROMO_RUN_STATUSES = ["queued", "running", "merging", "completed", "failed"] as const;
export const LOCAL_BUSINESS_PROMO_PROGRESS_STAGES = ["queued", "analyzing", "rendering", "completed", "failed"] as const;

export type LocalBusinessPromoDirection = typeof LOCAL_BUSINESS_PROMO_DIRECTIONS[number];
export type LocalBusinessPromoDuration = typeof LOCAL_BUSINESS_PROMO_DURATIONS[number];
export type LocalBusinessPromoAspectRatio = typeof LOCAL_BUSINESS_PROMO_ASPECT_RATIOS[number];
export type LocalBusinessPromoSubtitleStyle = typeof LOCAL_BUSINESS_PROMO_SUBTITLE_STYLES[number];
export type LocalBusinessPromoSubtitlePlacement = typeof LOCAL_BUSINESS_PROMO_SUBTITLE_PLACEMENTS[number];
export type LocalBusinessPromoNarrationVoice = typeof LOCAL_BUSINESS_PROMO_NARRATION_VOICES[number];
export type LocalBusinessPromoVoiceMode = typeof LOCAL_BUSINESS_PROMO_VOICE_MODES[number];
export type LocalBusinessPromoVoiceTemplateKey = typeof LOCAL_BUSINESS_PROMO_VOICE_TEMPLATE_KEYS[number];
export type LocalBusinessPromoMusicPreset = typeof LOCAL_BUSINESS_PROMO_MUSIC_PRESETS[number];
export type LocalBusinessPromoMaterialGroup = typeof LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS[number];
export type LocalBusinessPromoProjectStatus = typeof LOCAL_BUSINESS_PROMO_PROJECT_STATUSES[number];
export type LocalBusinessPromoRunStatus = typeof LOCAL_BUSINESS_PROMO_RUN_STATUSES[number];
export type LocalBusinessPromoProgressStage = typeof LOCAL_BUSINESS_PROMO_PROGRESS_STAGES[number];

export interface LocalBusinessPromoOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

export interface LocalBusinessPromoNarrationVoiceOption {
  readonly value: LocalBusinessPromoNarrationVoice;
  readonly label: string;
  readonly description: string;
  readonly providerVoiceId: "冰糖" | "茉莉" | "苏打" | "白桦";
}

export interface LocalBusinessPromoVoiceTemplate {
  readonly value: LocalBusinessPromoVoiceTemplateKey;
  readonly label: string;
  readonly description: string;
  readonly voiceDesignPrompt: string;
  readonly voiceStylePrompt: string;
}

export interface LocalBusinessPromoShotTemplate {
  readonly shotId: string;
  readonly label: string;
  readonly durationSec: number;
  readonly materialGroup: LocalBusinessPromoMaterialGroup;
  readonly fallbackGroups: readonly LocalBusinessPromoMaterialGroup[];
}

export interface LocalBusinessPromoNarrationBudgetLine {
  readonly shotId: string;
  readonly label: string;
  readonly durationSec: number;
  readonly minChars: number;
  readonly maxChars: number;
}

export interface LocalBusinessPromoNarrationBudget {
  readonly targetDurationSec: number;
  readonly maxDurationSec: number;
  readonly flexSec: number;
  readonly shotCount: number;
  readonly totalMinChars: number;
  readonly totalMaxChars: number;
  readonly lines: readonly LocalBusinessPromoNarrationBudgetLine[];
}

export interface LocalBusinessPromoDurationWindow {
  readonly targetDurationSec: number;
  readonly maxDurationSec: number;
  readonly flexSec: number;
}

export const LOCAL_BUSINESS_PROMO_DEFAULT_TITLE = "未命名宣传项目";
export const LOCAL_BUSINESS_PROMO_VIDEO_MODEL = "seedance-2" as const;
export const LOCAL_BUSINESS_PROMO_VIDEO_RESOLUTION = "720p" as const;
export const LOCAL_BUSINESS_PROMO_GENERATE_AUDIO = true;
export const LOCAL_BUSINESS_PROMO_RENDER_RESOURCE_KEY_BY_DURATION = {
  25: "local_business_promo_render_25s",
  40: "local_business_promo_render_40s",
  60: "local_business_promo_render_60s",
} as const;

export function localBusinessPromoRenderResourceKey(durationSec: LocalBusinessPromoDuration) {
  return LOCAL_BUSINESS_PROMO_RENDER_RESOURCE_KEY_BY_DURATION[durationSec];
}
