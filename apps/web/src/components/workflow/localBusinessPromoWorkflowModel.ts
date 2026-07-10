import type {
  LocalBusinessPromoAspectRatio,
  LocalBusinessPromoAudioState,
  LocalBusinessPromoBrief,
  LocalBusinessPromoDirection,
  LocalBusinessPromoDuration,
  LocalBusinessPromoMaterialGroup,
  LocalBusinessPromoMaterials,
  LocalBusinessPromoMusicPreset,
  LocalBusinessPromoNarrationVoice,
  LocalBusinessPromoNarrationVoiceOption,
  LocalBusinessPromoOption,
  LocalBusinessPromoProject,
  LocalBusinessPromoProjectStatus,
  LocalBusinessPromoProgressStage,
  LocalBusinessPromoRun,
  LocalBusinessPromoRunStatus,
  LocalBusinessPromoSettings,
  LocalBusinessPromoSubtitleStyle,
  LocalBusinessPromoVoiceMode,
  LocalBusinessPromoVoiceTemplate,
} from "../../workflowLocalBusinessPromoApi";

export const LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS = {
  directions: [
    { value: "store-trust", label: "门店信任感", description: "更适合强调专业度、资历、口碑和到店安心感。" },
    { value: "service-showcase", label: "服务展示型", description: "更适合突出服务流程、体验感和具体项目细节。" },
    { value: "offer-conversion", label: "活动转化型", description: "更适合强调优惠、限时利益点和到店转化。" },
    { value: "city-seeding", label: "城市种草型", description: "更适合把门店和城市生活方式场景绑定。" },
  ] as const satisfies readonly LocalBusinessPromoOption<LocalBusinessPromoDirection>[],
  durations: [
    { value: 25, label: "25 秒" },
    { value: 40, label: "40 秒" },
    { value: 60, label: "60 秒" },
  ] as const satisfies readonly LocalBusinessPromoOption<LocalBusinessPromoDuration>[],
  aspectRatios: [
    { value: "9:16", label: "9:16 竖版" },
    { value: "16:9", label: "16:9 横版" },
    { value: "1:1", label: "1:1 方版" },
  ] as const satisfies readonly LocalBusinessPromoOption<LocalBusinessPromoAspectRatio>[],
  subtitleStyles: [
    { value: "douyin-outline", label: "抖音描边" },
    { value: "xiaohongshu-clean", label: "小红书清爽" },
    { value: "bottom-clean", label: "底部简洁" },
    { value: "none", label: "无字幕" },
  ] as const satisfies readonly LocalBusinessPromoOption<LocalBusinessPromoSubtitleStyle>[],
  narrationVoices: [
    { value: "vv-female-natural", label: "VV·女声·自然亲切", description: "MiMo 预置音色：冰糖", providerVoiceId: "冰糖" },
    { value: "vv-female-bright", label: "VV·女声·明亮活力", description: "MiMo 预置音色：茉莉", providerVoiceId: "茉莉" },
    { value: "vv-male-warm", label: "VV·男声·温暖沉稳", description: "MiMo 预置音色：苏打", providerVoiceId: "苏打" },
    { value: "vv-male-steady", label: "VV·男声·稳重可信", description: "MiMo 预置音色：白桦", providerVoiceId: "白桦" },
  ] as const satisfies readonly LocalBusinessPromoNarrationVoiceOption[],
  voiceModes: [
    { value: "preset", label: "预制音色", description: "使用 MiMo 预置音色直接生成口播。" },
    { value: "design", label: "文本定制音色", description: "通过文本描述生成定制化口播音色。" },
    { value: "clone", label: "音频复刻音色", description: "上传音频样本，按目标声音生成口播。" },
  ] as const satisfies readonly LocalBusinessPromoOption<LocalBusinessPromoVoiceMode>[],
  voiceTemplates: [
    {
      value: "local-business-guide",
      label: "本地商家宣传示例",
      description: "像门店主理人或顾问在店里介绍招牌服务，重点突出可信、亲切和到店体验。",
      voiceDesignPrompt: "一位二十八岁左右的年轻女性，普通话自然清晰，音色亲切可信，像熟悉门店服务流程的本地主理人或顾问，在真诚介绍店内特色、服务细节和到店体验。",
      voiceStylePrompt: "语速自然偏稳，口语化、亲切、可信，不端着，像在店里当面给顾客介绍。",
    },
  ] as const satisfies readonly LocalBusinessPromoVoiceTemplate[],
  musicPresets: [
    { value: "light-explore", label: "轻快探索", description: "轻快探索感背景音乐氛围" },
    { value: "city-lively", label: "城市活力", description: "城市生活感、节奏轻盈的背景音乐氛围" },
    { value: "warm-healing", label: "温暖治愈", description: "温暖治愈、松弛亲近的背景音乐氛围" },
    { value: "premium-clean", label: "克制高级", description: "克制高级感背景音乐氛围" },
    { value: "no-bgm", label: "弱化背景乐", description: "弱化背景音乐存在感，以画面与解说为主" },
  ] as const satisfies readonly LocalBusinessPromoOption<LocalBusinessPromoMusicPreset>[],
};

export const LOCAL_BUSINESS_PROMO_MATERIAL_GROUP_META: Record<LocalBusinessPromoMaterialGroup, {
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
}> = {
  opening: { label: "开场素材", hint: "门头、招牌、第一眼氛围", icon: "mdi:storefront-outline" },
  process: { label: "过程素材", hint: "服务动作、操作细节、流程片段", icon: "mdi:play-box-multiple-outline" },
  environment: { label: "环境素材", hint: "空间、座位、陈列、现场氛围", icon: "mdi:sofa-outline" },
  result: { label: "结果素材", hint: "成品、对比、顾客反馈、收尾", icon: "mdi:check-decagram-outline" },
};

export function createEmptyLocalBusinessPromoBrief(): LocalBusinessPromoBrief {
  return {
    storeName: "",
    industry: "",
    cityArea: "",
    targetCustomers: "",
    mainOffer: "",
    sellingPoints: "",
  };
}

export function createEmptyLocalBusinessPromoMaterials(): LocalBusinessPromoMaterials {
  return {
    opening: [],
    process: [],
    environment: [],
    result: [],
  };
}

export function createDefaultLocalBusinessPromoSettings(): LocalBusinessPromoSettings {
  return {
    direction: "store-trust",
    durationSec: 25,
    aspectRatio: "9:16",
    subtitleStyle: "douyin-outline",
    narrationVoice: "vv-female-natural",
    voiceMode: "preset",
    voiceDesignPrompt: "",
    voiceStylePrompt: "",
    musicPreset: "light-explore",
  };
}

export function createEmptyLocalBusinessPromoAudioState(): LocalBusinessPromoAudioState {
  return {
    voiceCloneSample: null,
    activeNarration: null,
    activeBgm: null,
    narrationHistory: [],
    bgmHistory: [],
    tasks: [],
  };
}

export function countProjectMaterials(materials: LocalBusinessPromoMaterials): number {
  return Object.values(materials).reduce((sum, items) => sum + items.length, 0);
}

export function missingBriefLabels(brief: LocalBusinessPromoBrief): readonly string[] {
  const pairs = [
    ["门店/品牌名称", brief.storeName],
    ["行业类型", brief.industry],
    ["城市/商圈", brief.cityArea],
    ["目标客户", brief.targetCustomers],
    ["主推服务/产品", brief.mainOffer],
    ["核心卖点", brief.sellingPoints],
  ] as const;
  return pairs.filter(([, value]) => value.trim().length === 0).map(([label]) => label);
}

export function hasScriptReady(project: Pick<LocalBusinessPromoProject, "scriptDraft"> | null): boolean {
  return Boolean(project?.scriptDraft.trim());
}

export function canGenerateLocalBusinessPromo(project: LocalBusinessPromoProject | null): boolean {
  if (!project) return false;
  return missingBriefLabels(project.brief).length === 0
    && countProjectMaterials(project.materials) > 0
    && project.scriptDraft.trim().length > 0;
}

export function formatLocalBusinessPromoProjectStatus(status: LocalBusinessPromoProjectStatus): string {
  return status === "generating"
    ? "生成中"
    : status === "completed"
      ? "已完成"
      : status === "failed"
        ? "失败"
        : "草稿";
}

export function formatLocalBusinessPromoRunStatus(status: LocalBusinessPromoRunStatus): string {
  return status === "queued"
    ? "排队中"
    : status === "running"
      ? "生成中"
      : status === "merging"
        ? "拼接中"
        : status === "completed"
          ? "已完成"
          : "失败";
}

export function formatLocalBusinessPromoProgressStage(stage: LocalBusinessPromoProgressStage): string {
  return stage === "queued"
    ? "排队中"
    : stage === "analyzing"
      ? "AI 分析素材"
      : stage === "rendering"
        ? "ffmpeg 渲染"
        : stage === "completed"
          ? "已完成"
          : "失败";
}

export function formatLocalBusinessPromoShotTaskStatus(status: LocalBusinessPromoRun["shotPlan"][number]["taskStatus"]): string {
  return status === "completed"
    ? "完成"
    : status === "failed"
      ? "失败"
      : status === "running"
        ? "处理中"
        : "待处理";
}

export function formatLocalBusinessPromoTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function latestPreviewUrl(run: LocalBusinessPromoRun | null): string | null {
  return run?.mergedAsset?.originalUrl ?? run?.shotPlan.find((shot) => shot.assetUrl)?.assetUrl ?? null;
}

export function isLocalBusinessPromoBusy(status: LocalBusinessPromoProjectStatus | LocalBusinessPromoRunStatus | null | undefined): boolean {
  return status === "generating" || status === "queued" || status === "running" || status === "merging";
}
