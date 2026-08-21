import { z } from "zod";
import { parseLenientJson, callJsonWithRetry } from "./_shared/video-analyze-service.js";
import { VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY } from "./_shared/video-service.js";
import { DUB_ANALYZE_MAX_TOKENS } from "./dub-constants.js";
import { callVision, loadVisionConfig, type VisionConfig } from "./_shared/vision-client.js";
import { compressForVision } from "./_shared/video-compress.js";

const analysisSchema = z.object({
  spokenScript: z.string().default(""),
  shotScript: z.string().default(""),
  structure: z.string().default(""),
  highlights: z.array(z.string()).default([]),
});
export type DubAnalysis = z.infer<typeof analysisSchema>;

export function parseDubAnalysis(text: string): DubAnalysis {
  return analysisSchema.parse(parseLenientJson(text));
}

// gemini 能同时看画面 + 听音轨，所以 spokenScript 要求「逐字转写」，而不是像 M3 时代那样「据画面推断」。
const ANALYZE_SYSTEM = [
  "你是短视频口播拆解专家。用户上传一段参考视频，你能看到画面，也能听到声音。请拆解为 4 个板块：",
  "1) spokenScript：把视频里人物说出口的话【逐字转写】成完整口播文稿（只要台词，不要画面描述、不要旁白说明）。",
  "   若视频确实没有任何人声，才根据画面写一段等长的口播文案。绝不要留空。",
  "2) shotScript：分镜脚本，逐镜写「画面 / 台词 / 时长」。",
  "3) structure：结构拆解（开头钩子 / 正文展开 / 结尾 CTA / 整体节奏）。",
  "4) highlights：亮点卖点数组，至少 3 条，覆盖卖点、目标受众、使用场景。绝不要返回空数组。",
  "只输出严格合法的 JSON，禁止 Markdown 代码块、禁止思考过程、禁止 JSON 以外的任何文字。",
  "字符串值内不要出现未转义的双引号，用中文引号「」或去掉引号。JSON 结构：",
  `{"spokenScript":"","shotScript":"","structure":"","highlights":[]}`,
].join("\n");

export interface AnalyzeBilling {
  chargeResource: (a: { operationId: string; userId: string; resourceKey: string; units: number; accountType: "points" | "video" }) => Promise<{ charged: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}

export type CallVisionFn = typeof callVision;
export type CompressFn = typeof compressForVision;

export async function analyzeDubVideo(input: {
  userId: string; requestId: string; videoBuffer: Buffer; mime: string; durationSec: number;
  billing: AnalyzeBilling;
  cfg?: VisionConfig;
  callVisionFn?: CallVisionFn;
  compressFn?: CompressFn;
}): Promise<DubAnalysis> {
  const seconds = input.durationSec > 0 ? Math.ceil(input.durationSec) : 0;
  if (seconds <= 0) throw new Error("无法获取参考视频时长");
  const call = input.callVisionFn ?? callVision;
  const compress = input.compressFn ?? compressForVision;
  const operationId = `dub-analyze:${input.requestId}`;
  await input.billing.chargeResource({ operationId, userId: input.userId, resourceKey: VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY, units: seconds, accountType: "points" });
  try {
    // gemini inline_data 有体积上限，超限先用 ffmpeg 压（必须保留音轨，口播转写靠它）
    const compressed = await compress(input.videoBuffer);
    const cfg = input.cfg ?? loadVisionConfig();
    const media = [{ mime: input.mime, base64: compressed.toString("base64") }];
    return await callJsonWithRetry(
      () => call({ cfg, system: ANALYZE_SYSTEM, media, text: "请按 4 个板块拆解并输出 JSON。", maxTokens: DUB_ANALYZE_MAX_TOKENS }).then((r) => r.text),
      parseDubAnalysis,
    );
  } catch (err) {
    await input.billing.refundResource(operationId).catch(() => undefined);
    throw err;
  }
}
