import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import type Anthropic from "@anthropic-ai/sdk";
import {
  LOCAL_BUSINESS_PROMO_SUBTITLE_PLACEMENTS,
  type LocalBusinessPromoBrief,
  type LocalBusinessPromoMaterial,
  type LocalBusinessPromoSettings,
  type LocalBusinessPromoShotPlanEntry,
} from "./local-business-promo-core.js";

const shotAnalysisSchema = z.object({
  materialNotes: z.array(z.object({
    index: z.number().int().min(1),
    description: z.string().trim().min(1).max(600),
  })).default([]),
  selectedIndex: z.number().int().min(1),
  sourceStartSec: z.number().min(0).default(0),
  sourceEndSec: z.number().min(0).default(0),
  renderMode: z.enum(["video-cut", "image-pan"]),
  subtitlePlacement: z.enum(LOCAL_BUSINESS_PROMO_SUBTITLE_PLACEMENTS).default("bottom"),
  rationale: z.string().trim().max(800).default(""),
});

export type LocalBusinessPromoShotAnalysis = z.infer<typeof shotAnalysisSchema>;

export interface LocalBusinessPromoEditPlanSnapshot {
  readonly shots: ReadonlyArray<{
    readonly shotId: string;
    readonly rationale: string;
    readonly materialNotes: ReadonlyArray<{
      readonly index: number;
      readonly description: string;
    }>;
  }>;
}

export interface AnalyzeLocalBusinessPromoShotInput {
  readonly brief: LocalBusinessPromoBrief;
  readonly settings: LocalBusinessPromoSettings;
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly priorSelections?: readonly LocalBusinessPromoShotPlanEntry[];
  readonly client: Anthropic;
  readonly fetchFn?: typeof fetch;
}

function parseLenientJson(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("结果中未找到 JSON");
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return JSON.parse(jsonrepair(slice));
  }
}

function materialLabel(material: LocalBusinessPromoMaterial, index: number): string {
  const name = material.name.trim() || `素材${index}`;
  const kind = material.mime.startsWith("video/") ? "视频" : "图片";
  const duration = material.mime.startsWith("video/") ? `，时长 ${material.durationSec || 0} 秒` : "";
  return `${index}. ${kind}「${name}」${duration}`;
}

export function analysisSystemPrompt(input: AnalyzeLocalBusinessPromoShotInput): string {
  const priorSelections = (input.priorSelections ?? [])
    .filter((selection) => selection.selectedMaterialUrl && selection.selectedMaterialMime)
    .map((selection, index) => {
      const materialName = selection.selectedMaterialName || `素材${index + 1}`;
      if (selection.renderMode === "video-cut") {
        return `${index + 1}. ${materialName}，已使用 ${selection.sourceStartSec ?? 0}s-${selection.sourceEndSec ?? 0}s`;
      }
      return `${index + 1}. ${materialName}，已整图使用`;
    });
  return [
    "你是一名本地商家短视频剪辑导演，任务是从候选素材里选出最适合当前镜头的一条素材，并给出剪辑建议。",
    "规则：",
    "1. 必须只返回严格合法的 JSON，不要 Markdown，不要解释。",
    "2. selectedIndex 必须是候选素材的编号之一。",
    "3. 如果选中视频，renderMode 必须是 video-cut，并给出 sourceStartSec/sourceEndSec。",
    "4. 如果选中图片，renderMode 必须是 image-pan，sourceStartSec/sourceEndSec 都返回 0。",
    "5. 对视频素材，优先选最能承接当前口播文案的片段；若看到的是按时间顺序抽取的预览帧，请据此估算最合理的起止秒。",
    "6. materialNotes 需要描述每个候选素材的主体和画面内容，避免只写环境。",
    "7. 尽量不要重复已经用过的素材；若必须复用同一条视频，也要避开已经用过的时间段。",
    "8. 请同时判断字幕更适合放在 top、bottom、center 还是 none，尽量避开人物脸部、产品主体、手部操作和门店招牌等关键区域。",
    "",
    `门店/品牌名称：${input.brief.storeName || "未填写"}`,
    `行业类型：${input.brief.industry || "未填写"}`,
    `城市/商圈：${input.brief.cityArea || "未填写"}`,
    `目标客户：${input.brief.targetCustomers || "未填写"}`,
    `主推服务/产品：${input.brief.mainOffer || "未填写"}`,
    `核心卖点：${input.brief.sellingPoints || "未填写"}`,
    `视频方向：${input.settings.direction}`,
    `目标画幅：${input.settings.aspectRatio}`,
    `镜头名称：${input.shot.label}`,
    `镜头时长：${input.shot.durationSec} 秒`,
    `镜头文案：${input.shot.scriptLine || "请根据商家资料自然承接"}`,
    `候选素材：${input.shot.materials.map((material, index) => materialLabel(material, index + 1)).join("；")}`,
    priorSelections.length > 0 ? `已使用素材：${priorSelections.join("；")}` : "已使用素材：暂无",
    "",
    '返回结构：{"materialNotes":[{"index":1,"description":"..."}],"selectedIndex":1,"sourceStartSec":0,"sourceEndSec":8,"renderMode":"video-cut","subtitlePlacement":"bottom","rationale":"..."}',
  ].join("\n");
}

export function parseShotAnalysis(raw: string): LocalBusinessPromoShotAnalysis {
  return shotAnalysisSchema.parse(parseLenientJson(raw));
}

export function clampSelectedVideoRange(
  material: LocalBusinessPromoMaterial,
  shotDurationSec: number,
  analysis: LocalBusinessPromoShotAnalysis,
) {
  const durationSec = Math.max(0, material.durationSec || 0);
  if (durationSec <= 0) {
    return {
      sourceStartSec: 0,
      sourceEndSec: 0,
    };
  }
  const start = Math.max(0, Math.min(durationSec, analysis.sourceStartSec));
  const minEnd = Math.max(start + 0.5, Math.min(durationSec, start + Math.max(1, Math.min(shotDurationSec, durationSec))));
  const end = Math.max(minEnd, Math.min(durationSec, analysis.sourceEndSec || minEnd));
  return {
    sourceStartSec: Number(start.toFixed(2)),
    sourceEndSec: Number(Math.max(start + 0.5, end).toFixed(2)),
  };
}
