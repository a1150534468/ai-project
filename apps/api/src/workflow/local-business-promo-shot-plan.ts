import {
  directionLabel,
  musicPresetDescription,
  subtitleStyleLabel,
  voiceSettingsDescription,
} from "./local-business-promo-core-options.js";
import type {
  LocalBusinessPromoBrief,
  LocalBusinessPromoMaterial,
  LocalBusinessPromoMaterials,
  LocalBusinessPromoSettings,
  LocalBusinessPromoShotPlanEntry,
} from "./local-business-promo-core-schemas.js";
import type {
  LocalBusinessPromoDuration,
  LocalBusinessPromoDurationWindow,
  LocalBusinessPromoMaterialGroup,
  LocalBusinessPromoNarrationBudget,
  LocalBusinessPromoShotTemplate,
} from "./local-business-promo-core-types.js";

const SHOT_PLAN_TEMPLATES: Record<LocalBusinessPromoDuration, readonly LocalBusinessPromoShotTemplate[]> = {
  25: [
    { shotId: "opening-1", label: "开场", durationSec: 8, materialGroup: "opening", fallbackGroups: ["environment", "process", "result"] },
    { shotId: "process-1", label: "服务过程", durationSec: 8, materialGroup: "process", fallbackGroups: ["environment", "opening", "result"] },
    { shotId: "result-1", label: "结果收尾", durationSec: 8, materialGroup: "result", fallbackGroups: ["environment", "process", "opening"] },
  ],
  40: [
    { shotId: "trust-1", label: "门店信任", durationSec: 10, materialGroup: "opening", fallbackGroups: ["environment", "process", "result"] },
    { shotId: "environment-1", label: "环境氛围", durationSec: 10, materialGroup: "environment", fallbackGroups: ["opening", "process", "result"] },
    { shotId: "process-1", label: "服务过程", durationSec: 10, materialGroup: "process", fallbackGroups: ["environment", "opening", "result"] },
    { shotId: "result-1", label: "结果转化", durationSec: 10, materialGroup: "result", fallbackGroups: ["process", "environment", "opening"] },
  ],
  60: [
    { shotId: "opening-1", label: "开场", durationSec: 10, materialGroup: "opening", fallbackGroups: ["environment", "process", "result"] },
    { shotId: "storefront-1", label: "门店外观", durationSec: 10, materialGroup: "opening", fallbackGroups: ["environment", "process", "result"] },
    { shotId: "environment-1", label: "环境展示", durationSec: 10, materialGroup: "environment", fallbackGroups: ["opening", "process", "result"] },
    { shotId: "process-1", label: "服务过程", durationSec: 10, materialGroup: "process", fallbackGroups: ["environment", "opening", "result"] },
    { shotId: "result-1", label: "结果展示", durationSec: 10, materialGroup: "result", fallbackGroups: ["process", "environment", "opening"] },
    { shotId: "cta-1", label: "CTA 收尾", durationSec: 10, materialGroup: "result", fallbackGroups: ["opening", "environment", "process"] },
  ],
};

const LOCAL_BUSINESS_PROMO_NARRATION_MIN_CHARS_PER_SEC = 2.1;
const LOCAL_BUSINESS_PROMO_NARRATION_MAX_CHARS_PER_SEC = 2.6;
const SHOT_MATERIAL_CANDIDATE_LIMIT = 8;
const SHOT_GROUP_KEYWORDS: Record<LocalBusinessPromoMaterialGroup, readonly string[]> = {
  opening: ["门头", "门店", "招牌", "外观", "进店", "前台", "品牌", "logo"],
  process: ["制作", "操作", "服务", "出餐", "过程", "手法", "施工", "流程", "备餐"],
  environment: ["环境", "空间", "氛围", "店内", "内景", "座位", "装修", "场景"],
  result: ["成品", "效果", "展示", "产品", "作品", "顾客", "反馈", "前后", "成果"],
};

export function shotCountForDuration(durationSec: LocalBusinessPromoDuration): number {
  return SHOT_PLAN_TEMPLATES[durationSec].length;
}

export function getShotPlanTemplate(durationSec: LocalBusinessPromoDuration): readonly LocalBusinessPromoShotTemplate[] {
  return SHOT_PLAN_TEMPLATES[durationSec];
}

export function localBusinessPromoDurationWindow(durationSec: LocalBusinessPromoDuration): LocalBusinessPromoDurationWindow {
  const flexSec = Math.min(5, Math.max(3, Math.round(durationSec * 0.1)));
  return {
    targetDurationSec: durationSec,
    maxDurationSec: durationSec + flexSec,
    flexSec,
  };
}

export function resolveLocalBusinessPromoFinalDuration(
  durationSec: LocalBusinessPromoDuration,
  narrationDurationSec?: number | null,
): number {
  const window = localBusinessPromoDurationWindow(durationSec);
  if (!Number.isFinite(narrationDurationSec ?? NaN) || !narrationDurationSec || narrationDurationSec <= 0) {
    return window.targetDurationSec;
  }
  return Number(Math.min(window.maxDurationSec, Math.max(window.targetDurationSec, narrationDurationSec)).toFixed(2));
}

export function countLocalBusinessPromoSpeechChars(text: string): number {
  return Array.from(text).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
}

export function localBusinessPromoNarrationBudget(durationSec: LocalBusinessPromoDuration): LocalBusinessPromoNarrationBudget {
  const window = localBusinessPromoDurationWindow(durationSec);
  const template = getShotPlanTemplate(durationSec);
  const templateDurationSec = template.reduce((sum, shot) => sum + shot.durationSec, 0);
  const maxDurationScale = templateDurationSec > 0 ? window.maxDurationSec / templateDurationSec : 1;
  const lines = template.map((shot) => ({
    shotId: shot.shotId,
    label: shot.label,
    durationSec: shot.durationSec,
    minChars: Math.max(8, Math.round(shot.durationSec * LOCAL_BUSINESS_PROMO_NARRATION_MIN_CHARS_PER_SEC)),
    maxChars: Math.max(12, Math.round((shot.durationSec * maxDurationScale) * LOCAL_BUSINESS_PROMO_NARRATION_MAX_CHARS_PER_SEC)),
  }));
  return {
    targetDurationSec: window.targetDurationSec,
    maxDurationSec: window.maxDurationSec,
    flexSec: window.flexSec,
    shotCount: lines.length,
    totalMinChars: lines.reduce((sum, line) => sum + line.minChars, 0),
    totalMaxChars: lines.reduce((sum, line) => sum + line.maxChars, 0),
    lines,
  };
}

function summarizeMaterial(material: LocalBusinessPromoMaterial): string {
  const kind = material.mime.startsWith("video/") ? "视频" : "图片";
  const group = material.groupHint ? `（${material.groupHint}）` : "";
  return material.name.trim() ? `${kind}素材「${material.name.trim()}」${group}` : `${kind}${group}`;
}

function normalizeKeywordPool(parts: readonly string[]): string[] {
  return parts
    .flatMap((part) => part.split(/[、，,。；;|/\\\s]+/u))
    .map((part) => part.trim())
    .filter((part, index, list) => part.length >= 2 && list.indexOf(part) === index);
}

function flattenMaterialsWithGroups(materials: LocalBusinessPromoMaterials): LocalBusinessPromoMaterial[] {
  return Object.entries(materials).flatMap(([group, groupMaterials]) =>
    groupMaterials.map((material) => ({
      ...material,
      groupHint: material.groupHint ?? group as LocalBusinessPromoMaterialGroup,
    })));
}

function keywordHitScore(text: string, keywords: readonly string[]): number {
  const source = text.trim().toLowerCase();
  if (!source) return 0;
  return keywords.reduce((score, keyword) => score + (source.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

function scoreMaterialForShot(args: {
  readonly material: LocalBusinessPromoMaterial;
  readonly shot: LocalBusinessPromoShotTemplate;
  readonly scriptLine: string;
  readonly brief: LocalBusinessPromoBrief;
  readonly hasAnyVideo: boolean;
}): number {
  const groupHint = args.material.groupHint ?? args.shot.materialGroup;
  const orderedGroups = [args.shot.materialGroup, ...args.shot.fallbackGroups];
  const orderedIndex = orderedGroups.indexOf(groupHint);
  const name = args.material.name.trim();
  const keywordPool = normalizeKeywordPool([
    args.scriptLine,
    args.brief.storeName,
    args.brief.industry,
    args.brief.mainOffer,
    args.brief.sellingPoints,
  ]);
  const groupScore = orderedIndex >= 0 ? 18 - (orderedIndex * 4) : 6;
  const intentScore = keywordHitScore(name, SHOT_GROUP_KEYWORDS[args.shot.materialGroup]) * 4;
  const textScore = keywordHitScore(name, keywordPool) * 2;
  const isVideo = args.material.mime.startsWith("video/");
  const durationScore = isVideo
    ? ((args.material.durationSec || 0) >= args.shot.durationSec ? 4 : (args.material.durationSec || 0) > 0 ? 2 : 0)
    : (args.hasAnyVideo ? 1 : 3);
  return groupScore + intentScore + textScore + durationScore + (isVideo ? 7 : 4);
}

export function selectMaterialsForShot(args: {
  readonly materials: LocalBusinessPromoMaterials;
  readonly shot: LocalBusinessPromoShotTemplate;
  readonly scriptLine: string;
  readonly brief: LocalBusinessPromoBrief;
}): readonly LocalBusinessPromoMaterial[] {
  const flattened = flattenMaterialsWithGroups(args.materials);
  if (flattened.length === 0) return [];
  const seen = new Set<string>();
  const deduped = flattened.filter((material) => {
    const key = `${material.url}::${material.mime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const hasAnyVideo = deduped.some((material) => material.mime.startsWith("video/"));
  return deduped
    .map((material, index) => ({
      material,
      score: scoreMaterialForShot({
        material,
        shot: args.shot,
        scriptLine: args.scriptLine,
        brief: args.brief,
        hasAnyVideo,
      }),
      order: index,
    }))
    .sort((left, right) =>
      right.score - left.score
      || (right.material.durationSec || 0) - (left.material.durationSec || 0)
      || left.order - right.order)
    .slice(0, SHOT_MATERIAL_CANDIDATE_LIMIT)
    .map((entry) => entry.material);
}

function splitByPunctuation(script: string): string[] {
  return script
    .split(/[\n\r]+|(?<=[。！？!?；;])/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function splitScriptIntoShotLines(script: string, expectedCount: number): readonly string[] {
  const normalized = script.trim();
  if (!normalized) return Array.from({ length: expectedCount }, () => "");
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(\d+[.)、:：-]|\-\s*)/, "").trim())
    .filter(Boolean);
  const base = lines.length >= expectedCount ? lines.slice(0, expectedCount) : splitByPunctuation(normalized);
  if (base.length >= expectedCount) return base.slice(0, expectedCount);
  const merged = [...base];
  while (merged.length < expectedCount) {
    merged.push(base.at(-1) ?? normalized);
  }
  return merged.slice(0, expectedCount);
}

function buildClipPrompt(args: {
  readonly brief: LocalBusinessPromoBrief;
  readonly settings: LocalBusinessPromoSettings;
  readonly shot: LocalBusinessPromoShotTemplate;
  readonly scriptLine: string;
  readonly materials: readonly LocalBusinessPromoMaterial[];
}): string {
  const materialSummary = args.materials.length > 0
    ? args.materials.map(summarizeMaterial).join("、")
    : "无可用素材";
  const subtitle = args.settings.subtitleStyle === "none"
    ? "画面不强调字幕存在感。"
    : `字幕风格参考：${subtitleStyleLabel(args.settings.subtitleStyle)}。`;
  return [
    "请生成一段适合本地商家宣传短片的单段视频镜头。",
    `门店/品牌名称：${args.brief.storeName || "未填写"}`,
    `行业类型：${args.brief.industry || "未填写"}`,
    `城市/商圈：${args.brief.cityArea || "未填写"}`,
    `目标客户：${args.brief.targetCustomers || "未填写"}`,
    `主推服务/产品：${args.brief.mainOffer || "未填写"}`,
    `核心卖点：${args.brief.sellingPoints || "未填写"}`,
    `文案方向：${directionLabel(args.settings.direction)}`,
    `镜头阶段：${args.shot.label}`,
    `目标时长：${args.shot.durationSec} 秒`,
    `目标画幅：${args.settings.aspectRatio}`,
    subtitle,
    `声音提示：${voiceSettingsDescription(args.settings)}。`,
    `音乐提示：${musicPresetDescription(args.settings.musicPreset)}。`,
    `本段口播文案：${args.scriptLine || "请根据商家资料补足自然口播。"}。`,
    `优先结合以下候选素材完成混剪（候选集已从全部上传素材里挑选）：${materialSummary}。`,
    "画面要求贴近真实商家场景，突出到店信任感、环境质感、服务动作和结果呈现，不要出现夸张特效或明显 AI 海报感。",
  ].join("\n");
}

export function buildLocalBusinessPromoShotPlan(args: {
  readonly brief: LocalBusinessPromoBrief;
  readonly materials: LocalBusinessPromoMaterials;
  readonly settings: LocalBusinessPromoSettings;
  readonly scriptDraft: string;
}): LocalBusinessPromoShotPlanEntry[] {
  const template = getShotPlanTemplate(args.settings.durationSec);
  const scriptLines = splitScriptIntoShotLines(args.scriptDraft, template.length);
  return template.map((shot, index) => {
    const scriptLine = scriptLines[index] ?? "";
    const selectedMaterials = selectMaterialsForShot({
      materials: args.materials,
      shot,
      scriptLine,
      brief: args.brief,
    });
    return {
      shotId: shot.shotId,
      label: shot.label,
      durationSec: shot.durationSec,
      materialGroup: shot.materialGroup,
      fallbackGroups: [...shot.fallbackGroups],
      scriptLine,
      subtitlePlacement: "bottom",
      prompt: buildClipPrompt({
        brief: args.brief,
        settings: args.settings,
        shot,
        scriptLine,
        materials: selectedMaterials,
      }),
      materials: [...selectedMaterials],
      taskStatus: "queued",
    };
  });
}
