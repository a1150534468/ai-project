import { useEffect, useState } from "react";
import * as api from "../api.js";
import { errMsg, Field, Pill } from "../ui.js";

export const IMAGE_RESOURCE_KEY = "image_generation";
export const NOVEL_TEXT_RESOURCE_KEY = "novel_text_output";
export const NOVEL_COVER_RESOURCE_KEY = "novel_cover_generation";
export const ECOM_MASTER_RESOURCE_KEY = "ecom_master_generation";
export const ECOM_SEGMENT_RESOURCE_KEY = "ecom_segment_generation";
export const ECOM_STITCH_RESOURCE_KEY = "ecom_stitch";
export const VIDEO_POINT_RATIO = 100;

export interface EcomResourcePricingConfig {
  readonly resourceKey: string;
  readonly title: string;
  readonly description: string;
  readonly displayName: string;
  readonly pricingType: api.ResourcePriceRow["pricingType"];
  readonly defaultRate: number;
  readonly rateLabel: string;
}

const IMAGE_RESOLUTION_PRICING_CONFIGS = [
  { resourceKey: "image_generation_1k", label: "1K", displayName: "图片生成 1K", defaultRate: 10 },
  { resourceKey: "image_generation_2k", label: "2K", displayName: "图片生成 2K", defaultRate: 20 },
  { resourceKey: "image_generation_4k", label: "4K", displayName: "图片生成 4K", defaultRate: 40 },
] as const;

export const VIDEO_GENERATION_PRICING_CONFIGS = [
  { resourceKey: "video_seedance_2_480p_text", displayName: "Seedance-2.0 480p 无输入视频", model: "seedance-2", resolution: "480p", hasInputVideo: false },
  { resourceKey: "video_seedance_2_480p_with_video", displayName: "Seedance-2.0 480p 有输入视频", model: "seedance-2", resolution: "480p", hasInputVideo: true },
  { resourceKey: "video_seedance_2_720p_text", displayName: "Seedance-2.0 720p 无输入视频", model: "seedance-2", resolution: "720p", hasInputVideo: false },
  { resourceKey: "video_seedance_2_720p_with_video", displayName: "Seedance-2.0 720p 有输入视频", model: "seedance-2", resolution: "720p", hasInputVideo: true },
  { resourceKey: "video_seedance_2_1080p_text", displayName: "Seedance-2.0 1080p 无输入视频", model: "seedance-2", resolution: "1080p", hasInputVideo: false },
  { resourceKey: "video_seedance_2_1080p_with_video", displayName: "Seedance-2.0 1080p 有输入视频", model: "seedance-2", resolution: "1080p", hasInputVideo: true },
  { resourceKey: "video_seedance_2_4k_text", displayName: "Seedance-2.0 4k 无输入视频", model: "seedance-2", resolution: "4k", hasInputVideo: false },
  { resourceKey: "video_seedance_2_4k_with_video", displayName: "Seedance-2.0 4k 有输入视频", model: "seedance-2", resolution: "4k", hasInputVideo: true },
  { resourceKey: "video_seedance_2_fast_480p_text", displayName: "Seedance-2.0 Fast 480p 无输入视频", model: "seedance-2-fast", resolution: "480p", hasInputVideo: false },
  { resourceKey: "video_seedance_2_fast_480p_with_video", displayName: "Seedance-2.0 Fast 480p 有输入视频", model: "seedance-2-fast", resolution: "480p", hasInputVideo: true },
  { resourceKey: "video_seedance_2_fast_720p_text", displayName: "Seedance-2.0 Fast 720p 无输入视频", model: "seedance-2-fast", resolution: "720p", hasInputVideo: false },
  { resourceKey: "video_seedance_2_fast_720p_with_video", displayName: "Seedance-2.0 Fast 720p 有输入视频", model: "seedance-2-fast", resolution: "720p", hasInputVideo: true },
  { resourceKey: "video_seedance_2_mini_480p_text", displayName: "Seedance-2.0 Mini 480p 无输入视频", model: "seedance-2-mini", resolution: "480p", hasInputVideo: false },
  { resourceKey: "video_seedance_2_mini_480p_with_video", displayName: "Seedance-2.0 Mini 480p 有输入视频", model: "seedance-2-mini", resolution: "480p", hasInputVideo: true },
  { resourceKey: "video_seedance_2_mini_720p_text", displayName: "Seedance-2.0 Mini 720p 无输入视频", model: "seedance-2-mini", resolution: "720p", hasInputVideo: false },
  { resourceKey: "video_seedance_2_mini_720p_with_video", displayName: "Seedance-2.0 Mini 720p 有输入视频", model: "seedance-2-mini", resolution: "720p", hasInputVideo: true },
] as const;

export const ECOM_RESOURCE_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    resourceKey: "ecom_master_generation_1k",
    title: "电商长图母版 1K 价格",
    description: "启用后母版按此价独立计费；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商长图母版 1K",
    pricingType: "PER_UNIT",
    defaultRate: 10,
    rateLabel: "每次母版扣点",
  },
  {
    resourceKey: "ecom_master_generation_2k",
    title: "电商长图母版 2K 价格",
    description: "启用后母版按此价独立计费；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商长图母版 2K",
    pricingType: "PER_UNIT",
    defaultRate: 20,
    rateLabel: "每次母版扣点",
  },
  {
    resourceKey: "ecom_master_generation_4k",
    title: "电商长图母版 4K 价格",
    description: "启用后母版按此价独立计费；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商长图母版 4K",
    pricingType: "PER_UNIT",
    defaultRate: 40,
    rateLabel: "每次母版扣点",
  },
  {
    resourceKey: "ecom_segment_generation_1k",
    title: "电商长图分段 1K 价格",
    description: "启用后分段按此价独立计费；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商长图分段 1K",
    pricingType: "PER_UNIT",
    defaultRate: 10,
    rateLabel: "每段扣点",
  },
  {
    resourceKey: "ecom_segment_generation_2k",
    title: "电商长图分段 2K 价格",
    description: "启用后分段按此价独立计费；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商长图分段 2K",
    pricingType: "PER_UNIT",
    defaultRate: 20,
    rateLabel: "每段扣点",
  },
  {
    resourceKey: "ecom_segment_generation_4k",
    title: "电商长图分段 4K 价格",
    description: "启用后分段按此价独立计费；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商长图分段 4K",
    pricingType: "PER_UNIT",
    defaultRate: 40,
    rateLabel: "每段扣点",
  },
  {
    resourceKey: ECOM_STITCH_RESOURCE_KEY,
    title: "电商长图拼接价格",
    description: "拼接保存已免费（纯浏览器合成，无 AI 调用），此配置不再参与扣费，仅保留历史记录。",
    displayName: "电商长图拼接",
    pricingType: "PER_CALL",
    defaultRate: 0,
    rateLabel: "每次拼接扣点",
  },
];

// 帮我写「拆解」计费：图片按张、视频按秒，均扣视频点。复用 Ecom 面板渲染。
export const VIDEO_ANALYZE_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    resourceKey: "video_analyze_image",
    title: "帮我写-图片拆解价格",
    description: "帮我写向导分析素材时，图片按张扣算力点（非视频点）。",
    displayName: "帮我写-图片拆解(按张)",
    pricingType: "PER_UNIT",
    defaultRate: 1,
    rateLabel: "每张图片扣算力点",
  },
  {
    resourceKey: "video_analyze_video_sec",
    title: "帮我写-视频拆解价格",
    description: "帮我写向导分析素材/参考视频时，视频按秒扣算力点（非视频点）。",
    displayName: "帮我写-视频拆解(按秒)",
    pricingType: "PER_UNIT",
    defaultRate: 1,
    rateLabel: "每秒视频扣算力点",
  },
];

export const DUB_RESOURCE_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    resourceKey: "dub_parse_video",
    title: "数字人-链接解析价格",
    description: "数字人口播：粘贴分享链接解析无水印视频并转存，按次扣算力点（拆解按秒另计）。未配价则前端解析按钮置灰。",
    displayName: "数字人-链接解析(按次·算力点)",
    pricingType: "PER_CALL",
    defaultRate: 100,
    rateLabel: "每次解析扣算力点",
  },
  {
    resourceKey: "dub_avatar_clone",
    title: "数字人-建形象价格",
    description: "数字人口播：上传场景视频克隆数字人形象，按次扣视频点。",
    displayName: "数字人-建形象(按次·视频点)",
    pricingType: "PER_CALL",
    defaultRate: 100,
    rateLabel: "每次建形象扣视频点",
  },
  {
    resourceKey: "dub_video_sec",
    title: "数字人-成片价格",
    description: "数字人口播：音频驱动对口型成片，按输出秒数扣视频点。",
    displayName: "数字人-成片(按秒·视频点)",
    pricingType: "PER_UNIT",
    defaultRate: 2,
    rateLabel: "每秒成片扣视频点",
  },
  {
    resourceKey: "dub_tts_char",
    title: "数字人-配音价格",
    description: "数字人口播：MiMo TTS 按输入字符扣算力点。",
    displayName: "数字人-配音(按字·算力点)",
    pricingType: "PER_UNIT",
    defaultRate: 1,
    rateLabel: "每字配音扣算力点",
  },
];

export const ECOM_MAIN_IMAGE_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    resourceKey: "ecom_main_image_generation_1k",
    title: "电商主图 1K 价格",
    description: "启用后主图按此价独立计费（按张）；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商主图 1K",
    pricingType: "PER_UNIT",
    defaultRate: 10,
    rateLabel: "每张主图扣点",
  },
  {
    resourceKey: "ecom_main_image_generation_2k",
    title: "电商主图 2K 价格",
    description: "启用后主图按此价独立计费（按张）；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商主图 2K",
    pricingType: "PER_UNIT",
    defaultRate: 20,
    rateLabel: "每张主图扣点",
  },
  {
    resourceKey: "ecom_main_image_generation_4k",
    title: "电商主图 4K 价格",
    description: "启用后主图按此价独立计费（按张）；未配置或停用时回落「图片生成」对应清晰度价格。",
    displayName: "电商主图 4K",
    pricingType: "PER_UNIT",
    defaultRate: 40,
    rateLabel: "每张主图扣点",
  },
];

export const LOCAL_BUSINESS_PROMO_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    resourceKey: "local_business_promo_render_25s",
    title: "本地商家宣传剪辑 25 秒价格",
    description: "用户选择 25 秒成片时，启动生成按次预扣视频点。",
    displayName: "本地商家宣传成片生成 25 秒",
    pricingType: "PER_CALL",
    defaultRate: 25,
    rateLabel: "每次生成扣视频点",
  },
  {
    resourceKey: "local_business_promo_render_40s",
    title: "本地商家宣传剪辑 40 秒价格",
    description: "用户选择 40 秒成片时，启动生成按次预扣视频点。",
    displayName: "本地商家宣传成片生成 40 秒",
    pricingType: "PER_CALL",
    defaultRate: 40,
    rateLabel: "每次生成扣视频点",
  },
  {
    resourceKey: "local_business_promo_render_60s",
    title: "本地商家宣传剪辑 60 秒价格",
    description: "用户选择 60 秒成片时，启动生成按次预扣视频点。",
    displayName: "本地商家宣传成片生成 60 秒",
    pricingType: "PER_CALL",
    defaultRate: 60,
    rateLabel: "每次生成扣视频点",
  },
];

export const CODEX_PET_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    resourceKey: "codex_pet_v2_package",
    title: "Codex 桌宠 v2 套餐价格",
    description: "按规划图片调用逐次计费：启动预扣 14 次规划调用，按实际发出的调用数结算。注意：启动接口要求 PER_UNIT 且计费单位为 1，配置为其他值会导致启动失败。",
    displayName: "Codex 桌宠 v2 套餐",
    pricingType: "PER_UNIT",
    defaultRate: 200,
    rateLabel: "每次规划调用扣点",
  },
];

// 与 apps/api/src/workflow/image-upstream-options.ts imageModelResourceKey 的 slug 规则保持一致。
export const IMAGE_MODEL_PRICING_CONFIGS = [
  { model: "Qwen Image 2.0 Pro", slug: "qwen_image_2_0_pro_2026_04_22" },
  { model: "GPT Image 2", slug: "gpt_image_2" },
  { model: "豆包 Seedream 4.5", slug: "doubao_seedream_4_5_251128" },
  { model: "豆包 Seedream 5.0（形象照）", slug: "doubao_seedream_5_0_260128" },
].flatMap((entry) =>
  (["1k", "2k", "4k"] as const).map((resolution) => ({
    resourceKey: `image_generation_${entry.slug}_${resolution}`,
    model: entry.model,
    resolution: resolution.toUpperCase(),
    displayName: `图片生成 ${entry.model} ${resolution.toUpperCase()}`,
  })),
);

const DEFAULT_IMAGE_PRICE: api.ResourcePriceRow = {
  resourceKey: "image_generation_1k",
  displayName: "图片生成 1K",
  pricingType: "PER_UNIT",
  rate: 10,
  perUnits: 1,
  enabled: true,
};

const DEFAULT_NOVEL_TEXT_PRICE: api.ResourcePriceRow = {
  resourceKey: NOVEL_TEXT_RESOURCE_KEY,
  displayName: "小说文字生成",
  pricingType: "PER_UNIT",
  rate: 1,
  perUnits: 1000,
  enabled: true,
};

const DEFAULT_NOVEL_COVER_PRICE: api.ResourcePriceRow = {
  resourceKey: NOVEL_COVER_RESOURCE_KEY,
  displayName: "小说封面生成",
  pricingType: "PER_CALL",
  rate: 10,
  perUnits: 1,
  enabled: true,
};

type PricingPanelCallbacks = {
  readonly onDone: () => void;
  readonly onErr: (message: string) => void;
};

type ResourcePricingPanelProps = PricingPanelCallbacks & {
  readonly row?: api.ResourcePriceRow;
};

type ImageGenerationPricingPanelProps = PricingPanelCallbacks & {
  readonly rows?: readonly api.ResourcePriceRow[];
};

type VideoGenerationPricingPanelProps = PricingPanelCallbacks & {
  readonly rows?: readonly api.ResourcePriceRow[];
};

function imagePriceDraft(config: typeof IMAGE_RESOLUTION_PRICING_CONFIGS[number], row?: api.ResourcePriceRow): api.ResourcePriceRow {
  return {
    ...DEFAULT_IMAGE_PRICE,
    ...row,
    resourceKey: config.resourceKey,
    displayName: row?.displayName?.trim() || config.displayName,
    pricingType: "PER_UNIT",
    rate: row?.rate ?? config.defaultRate,
    perUnits: row?.perUnits && row.perUnits > 0 ? row.perUnits : 1,
    enabled: row?.enabled ?? true,
  };
}

function novelTextPriceDraft(row?: api.ResourcePriceRow): api.ResourcePriceRow {
  return {
    ...DEFAULT_NOVEL_TEXT_PRICE,
    ...row,
    resourceKey: NOVEL_TEXT_RESOURCE_KEY,
    displayName: DEFAULT_NOVEL_TEXT_PRICE.displayName,
    pricingType: "PER_UNIT",
    perUnits: DEFAULT_NOVEL_TEXT_PRICE.perUnits,
  };
}

function novelCoverPriceDraft(row?: api.ResourcePriceRow): api.ResourcePriceRow {
  return {
    ...DEFAULT_NOVEL_COVER_PRICE,
    ...row,
    resourceKey: NOVEL_COVER_RESOURCE_KEY,
    displayName: DEFAULT_NOVEL_COVER_PRICE.displayName,
    pricingType: "PER_CALL",
    perUnits: 1,
  };
}

function ecomResourcePriceDraft(config: EcomResourcePricingConfig, row?: api.ResourcePriceRow): api.ResourcePriceRow {
  return {
    ...row,
    resourceKey: config.resourceKey,
    displayName: row?.displayName?.trim() || config.displayName,
    pricingType: config.pricingType,
    rate: row?.rate ?? config.defaultRate,
    perUnits: row?.perUnits && row.perUnits > 0 ? row.perUnits : 1,
    enabled: row?.enabled ?? true,
  };
}

function videoPriceDraft(config: typeof VIDEO_GENERATION_PRICING_CONFIGS[number], row?: api.ResourcePriceRow): api.ResourcePriceRow {
  return {
    resourceKey: config.resourceKey,
    displayName: row?.displayName?.trim() || config.displayName,
    // 有输入视频用复合计价 VIDEO_IO（rate=输入单价/秒，outputRate=输出单价/秒）；无输入视频保持 PER_UNIT。
    pricingType: config.hasInputVideo ? "VIDEO_IO" : "PER_UNIT",
    rate: row?.rate ?? 0,
    outputRate: config.hasInputVideo ? (row?.outputRate ?? 0) : 0,
    perUnits: 1,
    enabled: row?.enabled ?? false,
  };
}

function pointsToRmbPerSecond(rate: number): number {
  return Number((rate / VIDEO_POINT_RATIO).toFixed(4));
}

function rmbPerSecondToPoints(value: number): number {
  return Math.round(value * VIDEO_POINT_RATIO * 10000) / 10000;
}

export function ImageGenerationPricingPanel({ rows = [], onDone, onErr }: ImageGenerationPricingPanelProps) {
  const [drafts, setDrafts] = useState<api.ResourcePriceRow[]>(() => IMAGE_RESOLUTION_PRICING_CONFIGS.map((config) => imagePriceDraft(config, rows.find((row) => row.resourceKey === config.resourceKey))));
  useEffect(() => {
    setDrafts(IMAGE_RESOLUTION_PRICING_CONFIGS.map((config) => imagePriceDraft(config, rows.find((row) => row.resourceKey === config.resourceKey))));
  }, [rows]);

  const save = async () => {
    if (drafts.some((draft) => !Number.isFinite(draft.rate) || draft.rate < 0)) {
      onErr("图片生成价格不能为负数");
      return;
    }
    if (drafts.some((draft) => !Number.isInteger(draft.perUnits) || draft.perUnits <= 0)) {
      onErr("计费单位须为正整数");
      return;
    }
    try {
      await Promise.all(drafts.map((draft) => api.upsertResourcePrice(draft)));
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };
  const updateDraft = (resourceKey: string, patch: Partial<api.ResourcePriceRow>) => {
    setDrafts((current) => current.map((draft) => draft.resourceKey === resourceKey ? { ...draft, ...patch } : draft));
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>图片生成分辨率价格</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            用户端已支持 1K / 2K / 4K，后端会按所选清晰度分别扣费。
          </p>
        </div>
      </div>
      {drafts.map((draft) => (
        <div key={draft.resourceKey} className="row" style={{ marginTop: 12, alignItems: "end" }}>
          <Field label="清晰度">
            <input value={IMAGE_RESOLUTION_PRICING_CONFIGS.find((config) => config.resourceKey === draft.resourceKey)?.label ?? draft.resourceKey} readOnly />
          </Field>
          <Field label="显示名">
            <input value={draft.displayName} onChange={(e) => updateDraft(draft.resourceKey, { displayName: e.target.value })} />
          </Field>
          <Field label="每张扣点">
            <input type="number" step="0.0001" min="0" value={draft.rate} onChange={(e) => updateDraft(draft.resourceKey, { rate: Number(e.target.value) })} />
          </Field>
          <Field label="计费单位">
            <input type="number" min="1" value={draft.perUnits} onChange={(e) => updateDraft(draft.resourceKey, { perUnits: Number(e.target.value) })} />
          </Field>
          <Field label="启用">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => updateDraft(draft.resourceKey, { enabled: e.target.checked })} />
          </Field>
          <Pill kind={draft.enabled ? "g" : "n"}>{draft.enabled ? "启用" : "停用"}</Pill>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save}>
          保存图片分辨率价格
        </button>
      </div>
    </div>
  );
}

function imageModelPriceDraft(config: typeof IMAGE_MODEL_PRICING_CONFIGS[number], row?: api.ResourcePriceRow): api.ResourcePriceRow {
  return {
    resourceKey: config.resourceKey,
    displayName: row?.displayName?.trim() || config.displayName,
    pricingType: "PER_UNIT",
    rate: row?.rate ?? 0,
    perUnits: 1,
    enabled: row?.enabled ?? false,
  };
}

export function ImageModelPricingPanel({ rows = [], onDone, onErr }: ImageGenerationPricingPanelProps) {
  const [drafts, setDrafts] = useState<api.ResourcePriceRow[]>(() =>
    IMAGE_MODEL_PRICING_CONFIGS.map((config) => imageModelPriceDraft(config, rows.find((row) => row.resourceKey === config.resourceKey))),
  );
  useEffect(() => {
    setDrafts(IMAGE_MODEL_PRICING_CONFIGS.map((config) => imageModelPriceDraft(config, rows.find((row) => row.resourceKey === config.resourceKey))));
  }, [rows]);

  const updateDraft = (resourceKey: string, patch: Partial<api.ResourcePriceRow>) => {
    setDrafts((current) => current.map((draft) => (draft.resourceKey === resourceKey ? { ...draft, ...patch } : draft)));
  };

  const save = async () => {
    if (drafts.some((draft) => !Number.isFinite(draft.rate) || draft.rate < 0)) {
      onErr("模型价格不能为负数");
      return;
    }
    // 未启用且从未配置过的行不落库，避免批量生成无效价格行。
    const toSave = drafts.filter((draft) => draft.enabled || rows.some((row) => row.resourceKey === draft.resourceKey));
    try {
      await Promise.all(toSave.map((draft) => api.upsertResourcePrice(draft)));
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>图片生成模型差异化价格（可选）</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            启用后对应模型按此价扣费；未启用时回落上方「图片生成分辨率价格」。通用生图、形象照、电商生图共用此回落规则（电商专属价优先级更高）。
          </p>
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>模型</th>
            <th>清晰度</th>
            <th>每张扣点</th>
            <th>启用</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((draft) => {
            const config = IMAGE_MODEL_PRICING_CONFIGS.find((item) => item.resourceKey === draft.resourceKey);
            return (
              <tr key={draft.resourceKey}>
                <td>{config?.model ?? draft.resourceKey}</td>
                <td>{config?.resolution ?? "-"}</td>
                <td>
                  <input
                    aria-label={`${draft.displayName} 每张扣点`}
                    type="number"
                    min="0"
                    step="0.0001"
                    value={draft.rate}
                    onChange={(e) => updateDraft(draft.resourceKey, { rate: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => updateDraft(draft.resourceKey, { enabled: e.target.checked })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save}>
          保存模型差异化价格
        </button>
      </div>
    </div>
  );
}

export function VideoGenerationPricingPanel({ rows = [], onDone, onErr }: VideoGenerationPricingPanelProps) {
  const [drafts, setDrafts] = useState<api.ResourcePriceRow[]>(() =>
    VIDEO_GENERATION_PRICING_CONFIGS.map((config) => videoPriceDraft(config, rows.find((row) => row.resourceKey === config.resourceKey)))
  );
  useEffect(() => {
    setDrafts(VIDEO_GENERATION_PRICING_CONFIGS.map((config) => videoPriceDraft(config, rows.find((row) => row.resourceKey === config.resourceKey))));
  }, [rows]);

  const updateDraft = (resourceKey: string, patch: Partial<api.ResourcePriceRow>) => {
    setDrafts((current) => current.map((draft) => draft.resourceKey === resourceKey ? { ...draft, ...patch } : draft));
  };

  const save = async () => {
    if (drafts.some((draft) => !Number.isFinite(draft.rate) || draft.rate < 0)) {
      onErr("视频生成价格不能为负数");
      return;
    }
    if (drafts.some((draft) => !Number.isFinite(draft.outputRate ?? 0) || (draft.outputRate ?? 0) < 0)) {
      onErr("视频输出价格不能为负数");
      return;
    }
    try {
      await Promise.all(drafts.map((draft) => api.upsertResourcePrice(videoPriceDraft(
        VIDEO_GENERATION_PRICING_CONFIGS.find((config) => config.resourceKey === draft.resourceKey) ?? VIDEO_GENERATION_PRICING_CONFIGS[0],
        draft,
      ))));
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>AI 视频生成价格</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            固定汇率：1 元 = 100 视频点。无输入视频按「输出秒数 × 输出单价」；有输入视频按「输入视频秒数 × 输入单价 + 输出秒数 × 输出单价」。
          </p>
        </div>
        <Pill kind="n">不可新增模型</Pill>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>模型</th>
            <th>清晰度</th>
            <th>计费场景</th>
            <th>输入 人民币/秒</th>
            <th>输出 人民币/秒</th>
            <th>启用</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((draft) => {
            const config = VIDEO_GENERATION_PRICING_CONFIGS.find((item) => item.resourceKey === draft.resourceKey);
            return (
              <tr key={draft.resourceKey}>
                <td>{config?.model ?? draft.resourceKey}</td>
                <td>{config?.resolution ?? "-"}</td>
                <td>{config?.hasInputVideo ? "有输入视频" : "无输入视频"}</td>
                <td>
                  {config?.hasInputVideo ? (
                    <input
                      aria-label={`${draft.displayName} 输入视频人民币每秒`}
                      type="number"
                      min="0"
                      step="0.0001"
                      value={pointsToRmbPerSecond(draft.rate)}
                      onChange={(e) => updateDraft(draft.resourceKey, { rate: rmbPerSecondToPoints(Number(e.target.value)) })}
                    />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <input
                    aria-label={`${draft.displayName} 输出视频人民币每秒`}
                    type="number"
                    min="0"
                    step="0.0001"
                    value={config?.hasInputVideo ? pointsToRmbPerSecond(draft.outputRate ?? 0) : pointsToRmbPerSecond(draft.rate)}
                    onChange={(e) => {
                      const points = rmbPerSecondToPoints(Number(e.target.value));
                      updateDraft(draft.resourceKey, config?.hasInputVideo ? { outputRate: points } : { rate: points });
                    }}
                  />
                </td>
                <td>
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => updateDraft(draft.resourceKey, { enabled: e.target.checked })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save}>
          保存视频价格
        </button>
      </div>
    </div>
  );
}

export function NovelTextPricingPanel({ row, onDone, onErr }: ResourcePricingPanelProps) {
  const [draft, setDraft] = useState<api.ResourcePriceRow>(() => novelTextPriceDraft(row));
  useEffect(() => {
    setDraft(novelTextPriceDraft(row));
  }, [row]);

  const save = async () => {
    if (!Number.isFinite(draft.rate) || draft.rate < 0) {
      onErr("小说文字生成价格不能为负数");
      return;
    }
    try {
      await api.upsertResourcePrice(novelTextPriceDraft(draft));
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>小说文字生成价格</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            资源 Key：<code>{NOVEL_TEXT_RESOURCE_KEY}</code>，按 1000 字扣点，结构化 JSON 的键名和格式不计费。
          </p>
          <p style={{ margin: "6px 0 0", color: "var(--ink)", fontWeight: 700 }}>
            当前规则：每 1000 字扣 {Number(draft.rate).toLocaleString()} 算力点
          </p>
        </div>
        <Pill kind={draft.enabled ? "g" : "n"}>{draft.enabled ? "启用" : "停用"}</Pill>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="每千字扣点">
          <input type="number" step="0.0001" min="0" value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: Number(e.target.value) })} />
        </Field>
        <Field label="启用">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        </Field>
        <button className="btn" onClick={save}>
          保存小说价格
        </button>
      </div>
    </div>
  );
}

export function NovelCoverPricingPanel({ row, onDone, onErr }: ResourcePricingPanelProps) {
  const [draft, setDraft] = useState<api.ResourcePriceRow>(() => novelCoverPriceDraft(row));
  useEffect(() => {
    setDraft(novelCoverPriceDraft(row));
  }, [row]);

  const save = async () => {
    if (!Number.isFinite(draft.rate) || draft.rate < 0) {
      onErr("小说封面生成价格不能为负数");
      return;
    }
    try {
      await api.upsertResourcePrice(novelCoverPriceDraft(draft));
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>小说封面生成价格</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            资源 Key：<code>{NOVEL_COVER_RESOURCE_KEY}</code>，用于小说模块的 AI 生成封面按钮，按次扣点。
          </p>
          <p style={{ margin: "6px 0 0", color: "var(--ink)", fontWeight: 700 }}>
            当前规则：每次扣 {Number(draft.rate).toLocaleString()} 算力点
          </p>
        </div>
        <Pill kind={draft.enabled ? "g" : "n"}>{draft.enabled ? "启用" : "停用"}</Pill>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="每次扣点">
          <input type="number" step="0.0001" min="0" value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: Number(e.target.value) })} />
        </Field>
        <Field label="启用">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        </Field>
        <button className="btn" onClick={save}>
          保存封面价格
        </button>
      </div>
    </div>
  );
}

export function EcomResourcePricingPanel({
  config,
  row,
  onDone,
  onErr,
}: ResourcePricingPanelProps & {
  readonly config: EcomResourcePricingConfig;
}) {
  const [draft, setDraft] = useState<api.ResourcePriceRow>(() => ecomResourcePriceDraft(config, row));
  useEffect(() => {
    setDraft(ecomResourcePriceDraft(config, row));
  }, [config, row]);

  const save = async () => {
    if (!Number.isFinite(draft.rate) || draft.rate < 0) {
      onErr(`${config.displayName}价格不能为负数`);
      return;
    }
    if (!Number.isInteger(draft.perUnits) || draft.perUnits <= 0) {
      onErr("计费单位须为正整数");
      return;
    }
    try {
      await api.upsertResourcePrice(ecomResourcePriceDraft(config, draft));
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>{config.title}</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            资源 Key：<code>{config.resourceKey}</code>，{config.description}
          </p>
          <p style={{ margin: "6px 0 0", color: "var(--ink)", fontWeight: 700 }}>
            当前规则：{config.pricingType === "PER_CALL" ? "每次" : "每单位"}扣 {Number(draft.rate).toLocaleString()} 算力点
          </p>
        </div>
        <Pill kind={draft.enabled ? "g" : "n"}>{draft.enabled ? "启用" : "停用"}</Pill>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="显示名">
          <input value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
        </Field>
        <Field label={config.rateLabel}>
          <input type="number" step="0.0001" min="0" value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: Number(e.target.value) })} />
        </Field>
        <Field label="计费单位">
          <input type="number" min="1" value={draft.perUnits} onChange={(e) => setDraft({ ...draft, perUnits: Number(e.target.value) })} />
        </Field>
        <Field label="启用">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        </Field>
        <button className="btn" onClick={save}>
          保存资源价格
        </button>
      </div>
    </div>
  );
}
