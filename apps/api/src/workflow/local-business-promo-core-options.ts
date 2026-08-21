import type { LocalBusinessPromoSettings } from "./local-business-promo-core-schemas.js";
import {
  type LocalBusinessPromoDirection,
  type LocalBusinessPromoMusicPreset,
  type LocalBusinessPromoNarrationVoice,
  type LocalBusinessPromoNarrationVoiceOption,
  type LocalBusinessPromoOption,
  type LocalBusinessPromoSubtitleStyle,
  type LocalBusinessPromoVoiceMode,
  type LocalBusinessPromoVoiceTemplate,
  type LocalBusinessPromoVoiceTemplateKey,
  LOCAL_BUSINESS_PROMO_ASPECT_RATIOS,
  LOCAL_BUSINESS_PROMO_DURATIONS,
} from "./local-business-promo-core-types.js";

export const LOCAL_BUSINESS_PROMO_DIRECTION_OPTIONS: readonly LocalBusinessPromoOption<LocalBusinessPromoDirection>[] = [
  { value: "store-trust", label: "门店信任感", description: "更适合强调专业度、资历、口碑和到店安心感。" },
  { value: "service-showcase", label: "服务展示型", description: "更适合突出服务流程、体验感和具体项目细节。" },
  { value: "offer-conversion", label: "活动转化型", description: "更适合强调优惠、限时利益点和到店转化。" },
  { value: "city-seeding", label: "城市种草型", description: "更适合把门店和城市生活方式场景绑定。" },
] as const;

export const LOCAL_BUSINESS_PROMO_DURATION_OPTIONS: readonly LocalBusinessPromoOption<(typeof LOCAL_BUSINESS_PROMO_DURATIONS)[number]>[] = [
  { value: 25, label: "25 秒" },
  { value: 40, label: "40 秒" },
  { value: 60, label: "60 秒" },
] as const;

export const LOCAL_BUSINESS_PROMO_ASPECT_RATIO_OPTIONS: readonly LocalBusinessPromoOption<(typeof LOCAL_BUSINESS_PROMO_ASPECT_RATIOS)[number]>[] = [
  { value: "9:16", label: "9:16 竖版" },
  { value: "16:9", label: "16:9 横版" },
  { value: "1:1", label: "1:1 方版" },
] as const;

export const LOCAL_BUSINESS_PROMO_SUBTITLE_OPTIONS: readonly LocalBusinessPromoOption<LocalBusinessPromoSubtitleStyle>[] = [
  { value: "douyin-outline", label: "抖音描边" },
  { value: "xiaohongshu-clean", label: "小红书清爽" },
  { value: "bottom-clean", label: "底部简洁" },
  { value: "none", label: "无字幕" },
] as const;

export const LOCAL_BUSINESS_PROMO_NARRATION_VOICE_OPTIONS: readonly LocalBusinessPromoNarrationVoiceOption[] = [
  { value: "vv-female-natural", label: "VV·女声·自然亲切", description: "MiMo 预置音色：冰糖", providerVoiceId: "冰糖" },
  { value: "vv-female-bright", label: "VV·女声·明亮活力", description: "MiMo 预置音色：茉莉", providerVoiceId: "茉莉" },
  { value: "vv-male-warm", label: "VV·男声·温暖沉稳", description: "MiMo 预置音色：苏打", providerVoiceId: "苏打" },
  { value: "vv-male-steady", label: "VV·男声·稳重可信", description: "MiMo 预置音色：白桦", providerVoiceId: "白桦" },
] as const;

export const LOCAL_BUSINESS_PROMO_VOICE_MODE_OPTIONS: readonly LocalBusinessPromoOption<LocalBusinessPromoVoiceMode>[] = [
  { value: "preset", label: "预制音色", description: "使用 MiMo 预置音色直接生成口播。" },
  { value: "design", label: "文本定制音色", description: "通过文本描述生成定制化口播音色。" },
  { value: "clone", label: "音频复刻音色", description: "上传音频样本，按目标声音生成口播。" },
] as const;

export const LOCAL_BUSINESS_PROMO_VOICE_TEMPLATES: readonly LocalBusinessPromoVoiceTemplate[] = [
  {
    value: "local-business-guide",
    label: "本地商家宣传示例",
    description: "像门店主理人或顾问在店里介绍招牌服务，重点突出可信、亲切和到店体验。",
    voiceDesignPrompt: "一位二十八岁左右的年轻女性，普通话自然清晰，音色亲切可信，像熟悉门店服务流程的本地主理人或顾问，在真诚介绍店内特色、服务细节和到店体验。",
    voiceStylePrompt: "语速自然偏稳，口语化、亲切、可信，不端着，像在店里当面给顾客介绍。",
  },
] as const;

export const LOCAL_BUSINESS_PROMO_MUSIC_OPTIONS: readonly LocalBusinessPromoOption<LocalBusinessPromoMusicPreset>[] = [
  { value: "light-explore", label: "轻快探索", description: "轻快探索感背景音乐氛围" },
  { value: "city-lively", label: "城市活力", description: "城市生活感、节奏轻盈的背景音乐氛围" },
  { value: "warm-healing", label: "温暖治愈", description: "温暖治愈、松弛亲近的背景音乐氛围" },
  { value: "premium-clean", label: "克制高级", description: "克制高级感背景音乐氛围" },
  { value: "no-bgm", label: "弱化背景乐", description: "弱化背景音乐存在感，以画面与解说为主" },
] as const;

function voiceTemplateByKey(value: LocalBusinessPromoVoiceTemplateKey): LocalBusinessPromoVoiceTemplate {
  return LOCAL_BUSINESS_PROMO_VOICE_TEMPLATES.find((item) => item.value === value) ?? LOCAL_BUSINESS_PROMO_VOICE_TEMPLATES[0];
}

function narrationVoiceByValue(value: LocalBusinessPromoNarrationVoice): LocalBusinessPromoNarrationVoiceOption {
  return LOCAL_BUSINESS_PROMO_NARRATION_VOICE_OPTIONS.find((item) => item.value === value) ?? LOCAL_BUSINESS_PROMO_NARRATION_VOICE_OPTIONS[0];
}

function labelOf<T extends string | number>(options: readonly LocalBusinessPromoOption<T>[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

function descriptionOf<T extends string | number>(options: readonly LocalBusinessPromoOption<T>[], value: T): string {
  return options.find((option) => option.value === value)?.description ?? labelOf(options, value);
}

export function directionLabel(value: LocalBusinessPromoDirection): string {
  return labelOf(LOCAL_BUSINESS_PROMO_DIRECTION_OPTIONS, value);
}

export function subtitleStyleLabel(value: LocalBusinessPromoSubtitleStyle): string {
  return labelOf(LOCAL_BUSINESS_PROMO_SUBTITLE_OPTIONS, value);
}

export function narrationVoiceLabel(value: LocalBusinessPromoNarrationVoice): string {
  return narrationVoiceByValue(value).label;
}

export function narrationVoiceProviderId(value: LocalBusinessPromoNarrationVoice): string {
  return narrationVoiceByValue(value).providerVoiceId;
}

export function voiceModeLabel(value: LocalBusinessPromoVoiceMode): string {
  return labelOf(LOCAL_BUSINESS_PROMO_VOICE_MODE_OPTIONS, value);
}

export function voiceTemplateDescription(value: LocalBusinessPromoVoiceTemplateKey): string {
  return voiceTemplateByKey(value).description;
}

export function voiceSettingsDescription(
  settings: Pick<LocalBusinessPromoSettings, "voiceMode" | "narrationVoice" | "voiceDesignPrompt" | "voiceStylePrompt">,
): string {
  const stylePrompt = settings.voiceStylePrompt.trim();
  if (settings.voiceMode === "preset") {
    const voice = narrationVoiceByValue(settings.narrationVoice);
    return [
      `旁白音色：${voice.label}`,
      voice.description,
    ].filter(Boolean).join("；");
  }
  if (settings.voiceMode === "design") {
    return [
      "旁白音色：文本定制音色",
      settings.voiceDesignPrompt.trim() ? `音色描述：${settings.voiceDesignPrompt.trim()}` : "",
      stylePrompt ? `风格补充：${stylePrompt}` : "",
    ].filter(Boolean).join("；");
  }
  return "旁白音色：音频复刻音色";
}

export function musicPresetDescription(value: LocalBusinessPromoMusicPreset): string {
  return descriptionOf(LOCAL_BUSINESS_PROMO_MUSIC_OPTIONS, value);
}

export function buildOptionsPayload() {
  return {
    directions: LOCAL_BUSINESS_PROMO_DIRECTION_OPTIONS,
    durations: LOCAL_BUSINESS_PROMO_DURATION_OPTIONS,
    aspectRatios: LOCAL_BUSINESS_PROMO_ASPECT_RATIO_OPTIONS,
    subtitleStyles: LOCAL_BUSINESS_PROMO_SUBTITLE_OPTIONS,
    voiceModes: LOCAL_BUSINESS_PROMO_VOICE_MODE_OPTIONS,
    voiceTemplates: LOCAL_BUSINESS_PROMO_VOICE_TEMPLATES,
    narrationVoices: LOCAL_BUSINESS_PROMO_NARRATION_VOICE_OPTIONS,
    musicPresets: LOCAL_BUSINESS_PROMO_MUSIC_OPTIONS,
  };
}
