import type { FanoutBrief, FanoutCount, FanoutDimensionId, FanoutMode, FanoutVariant } from "../../workflowFanoutApi";

export const FANOUT_MIN_COUNT = 1;
export const FANOUT_MAX_COUNT = 100;

export const FANOUT_COUNT_OPTIONS: readonly { value: FanoutCount; label: string }[] = [
  { value: 10, label: "10 条" }, { value: 30, label: "30 条" },
  { value: 50, label: "50 条" }, { value: 100, label: "100 条" },
];

export type ParseFanoutCountResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

// 自定义条数校验：整数且落在 [FANOUT_MIN_COUNT, FANOUT_MAX_COUNT]（对齐图片模块 parseImageCount）
export function parseFanoutCount(raw: string): ParseFanoutCountResult {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "条数必须是整数" };
  const value = Number.parseInt(trimmed, 10);
  if (value < FANOUT_MIN_COUNT) return { ok: false, error: `条数至少为 ${FANOUT_MIN_COUNT}` };
  if (value > FANOUT_MAX_COUNT) return { ok: false, error: `最多 ${FANOUT_MAX_COUNT} 条` };
  return { ok: true, value };
}

export const MODE_OPTIONS: readonly { value: FanoutMode; label: string; hint: string }[] = [
  { value: "enum", label: "单维度裂变", hint: "沿一个维度展开，如各平台各一条" },
  { value: "matrix", label: "矩阵降重", hint: "多账号差异化，自动降低重复率" },
  { value: "script", label: "视频脚本", hint: "15/30/60秒、口播、剧情、带货" },
];

export const ENUM_DIMENSION_OPTIONS: readonly { value: FanoutDimensionId; label: string }[] = [
  { value: "platform", label: "不同平台" }, { value: "sellingPoint", label: "不同卖点" },
  { value: "audience", label: "不同人群" }, { value: "style", label: "不同风格" },
  { value: "emotion", label: "不同情绪" }, { value: "seo", label: "SEO 关键词" },
];

// 文本框「每行一个」：仅按换行分隔，保留行内标点（卖点常含中文逗号/顿号，
// 若按逗号拆分会把一条卖点炸成多条碎片，越过后端 sellingPoints 上限导致 400）
export function parseSellingPoints(raw: string): string[] {
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}
export function formatSellingPoints(points: readonly string[]): string {
  return points.join("\n");
}

export function dedupAvailable(mode: FanoutMode): boolean {
  return mode === "enum";
}

export function canGenerate(args: { mode: FanoutMode; brief: FanoutBrief; dimension?: FanoutDimensionId }): boolean {
  if (args.brief.product.trim().length === 0) return false;
  if (args.mode === "enum" && !args.dimension) return false;
  return true;
}

export function exportVariantsText(variants: readonly FanoutVariant[]): string {
  return variants.map((v) => `【${v.label}】\n${v.text}`).join("\n\n---\n\n");
}

export function averageSimilarityLabel(avg: number): string {
  return `${Math.round(avg * 100)}%`;
}
