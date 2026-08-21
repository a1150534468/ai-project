import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import { buildVisionMedia, type MediaInput } from "./video-multimodal.js";
import { VIDEO_ANALYZE_IMAGE_RESOURCE_KEY, VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY } from "./video-service.js";
import { callVision, loadVisionConfig, type VisionConfig, type VisionMedia } from "./_shared/vision-client.js";
import { compressForVision, VISION_MAX_RAW_BYTES } from "./video-compress.js";

// M3 常在中文字符串里塞未转义引号/多余逗号，导致 JSON.parse 失败。先直解，失败则用 jsonrepair 修复再解。
export function parseLenientJson(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
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

const ANALYZE_MAX_TOKENS = 2600;

const insightSchema = z.object({
  materials: z.array(z.object({ index: z.number(), description: z.string() })).default([]),
  insight: z.object({
    productName: z.string().default(""),
    category: z.string().default(""),
    features: z.array(z.string()).default([]),
    sellingPoints: z.array(z.string()).default([]),
    audience: z.array(z.string()).default([]),
    scenes: z.array(z.string()).default([]),
  }),
});
export type MaterialInsight = z.infer<typeof insightSchema>;

const ANALYZE_SYSTEM = [
  "你是电商短视频的商品拆解专家。用户会上传若干图片/视频素材（按顺序为 素材1、素材2…）。",
  "请：1) 逐条描述每个素材；2) 归纳商品洞察。",
  "描述要求：先点明该素材的【主体对象】再讲画面。视频要概括整段的主体与主要内容（含出现的主角/人物/动物/商品），",
  "不要只写开场镜头或背景环境。例如视频是「一只橘猫在雨夜窗边猫窝里安睡」，就要写出「橘猫」这个主体，而非只写「雨夜窗景」。",
  "只输出严格合法的 JSON，禁止 Markdown 代码块、禁止思考过程、禁止 JSON 以外的任何文字。",
  "字符串值内不要出现未转义的双引号，用中文引号「」或去掉引号。JSON 结构：",
  `{"materials":[{"index":1,"description":"..."}],"insight":{"productName":"","category":"","features":[],"sellingPoints":[],"audience":[],"scenes":[]}}`,
].join("\n");

interface BillingForAnalyze {
  chargeResource: (a: {
    operationId: string;
    userId: string;
    resourceKey: string;
    units: number;
    accountType?: "points" | "video";
  }) => Promise<{ charged: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}

export interface AnalyzeMaterialsInput {
  readonly userId: string;
  readonly requestId: string;
  readonly materials: readonly MediaInput[];
  readonly billing: BillingForAnalyze;
  readonly resolveVideoSeconds: (urls: readonly string[]) => Promise<Map<string, number>>;
  readonly fetchFn?: typeof fetch;
  readonly cfg?: VisionConfig;
  readonly callVisionFn?: typeof callVision;
}

const MAX_JSON_ATTEMPTS = 3;

function parseJson(text: string): MaterialInsight {
  return insightSchema.parse(parseLenientJson(text));
}

// M3 偶发吐坏 JSON：同一份输入重试解析，最多 MAX_JSON_ATTEMPTS 次。不重复扣费（扣费在外层）。
export async function callJsonWithRetry<T>(produce: () => Promise<string>, parse: (text: string) => T): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_JSON_ATTEMPTS; attempt += 1) {
    const text = await produce();
    try {
      return parse(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("结果解析失败");
}

export async function analyzeMaterials(input: AnalyzeMaterialsInput): Promise<MaterialInsight> {
  if (input.materials.length === 0) throw new Error("请先上传素材");
  const images = input.materials.filter((m) => !m.mime.startsWith("video/"));
  const videos = input.materials.filter((m) => m.mime.startsWith("video/"));
  const opImage = `video-analyze-img:${input.requestId}`;
  const opVideo = `video-analyze-vid:${input.requestId}`;

  if (images.length > 0) {
    await input.billing.chargeResource({
      operationId: opImage,
      userId: input.userId,
      resourceKey: VIDEO_ANALYZE_IMAGE_RESOURCE_KEY,
      units: images.length,
      accountType: "points",
    });
  }
  let videoSeconds = 0;
  if (videos.length > 0) {
    const secMap = await input.resolveVideoSeconds(videos.map((v) => v.url));
    videoSeconds = videos.reduce((sum, v) => sum + (secMap.get(v.url) ?? 0), 0);
    if (videoSeconds <= 0) {
      await input.billing.refundResource(opImage).catch(() => undefined);
      throw new Error("无法获取视频素材时长，请通过上传素材接口重新上传");
    }
    await input.billing.chargeResource({
      operationId: opVideo,
      userId: input.userId,
      resourceKey: VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY,
      units: videoSeconds,
      accountType: "points",
    });
  }

  try {
    // 素材只取一次（避免重复拉流）；视频逐个压到 inline_data 限额内，再做聚合体积兜底。
    const raw = await buildVisionMedia(input.materials, { fetchFn: input.fetchFn });
    const media = await compressVisionMedia(raw);
    const call = input.callVisionFn ?? callVision;
    const cfg = input.cfg ?? loadVisionConfig();
    return await callJsonWithRetry(
      () => call({ cfg, system: ANALYZE_SYSTEM, media, text: "请拆解以上素材并输出 JSON。", maxTokens: ANALYZE_MAX_TOKENS }).then((r) => r.text),
      parseJson,
    );
  } catch (err) {
    await input.billing.refundResource(opImage).catch(() => undefined);
    await input.billing.refundResource(opVideo).catch(() => undefined);
    throw err;
  }
}

const REFERENCE_MAX_TOKENS = 3200;
const referenceSchema = z.object({ script: z.string().default(""), highlights: z.array(z.string()).default([]) });
export type ReferenceBreakdown = z.infer<typeof referenceSchema>;

// 参考视频拆解固定 5 维度（用户指定）：逐帧画面构造/剪辑手法/音效与BGM/文案编评/结构逻辑。
const REFERENCE_SYSTEM = [
  "你是短视频拆片专家。用户上传一段「想模仿的参考视频」。请逐帧/逐段拆解，覆盖 5 个维度：",
  "1) 画面构造：逐帧构图、主体、景别、光线、色彩；",
  "2) 剪辑手法：转场、节奏、镜头切换；",
  "3) 音效与 BGM：音效节点、配乐风格与情绪；",
  "4) 文案编评输出：逐句提取口播/字幕文案并点评；",
  "5) 结构逻辑：开场—发展—高潮—结尾的叙事结构与钩子设计。",
  "只输出严格合法的 JSON，禁止 Markdown 包裹、禁止思考过程、禁止 JSON 以外的文字。",
  "字符串值内不要出现未转义的双引号（用中文引号「」或去掉）。结构：",
  `{"script":"按时间顺序的逐段拆解文本（含以上5维度）","highlights":["创意亮点1","创意亮点2"]}`,
].join("\n");

function parseReference(text: string): ReferenceBreakdown {
  return referenceSchema.parse(parseLenientJson(text));
}

export async function analyzeReference(input: {
  readonly userId: string;
  readonly requestId: string;
  readonly videoBuffer: Buffer;
  readonly mime: string;
  readonly durationSec: number;
  readonly billing: BillingForAnalyze;
  readonly cfg?: VisionConfig;
  readonly callVisionFn?: typeof callVision;
  readonly compressFn?: typeof compressForVision;
}): Promise<ReferenceBreakdown> {
  const op = `video-analyze-ref:${input.requestId}`;
  const seconds = input.durationSec > 0 ? Math.ceil(input.durationSec) : 0;
  if (seconds <= 0) throw new Error("无法获取参考视频时长");
  await input.billing.chargeResource({ operationId: op, userId: input.userId, resourceKey: VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY, units: seconds, accountType: "points" });
  try {
    const compress = input.compressFn ?? compressForVision;
    const compressed = await compress(input.videoBuffer);
    const call = input.callVisionFn ?? callVision;
    const cfg = input.cfg ?? loadVisionConfig();
    return await callJsonWithRetry(
      () => call({
        cfg,
        system: REFERENCE_SYSTEM,
        media: [{ mime: input.mime, base64: compressed.toString("base64") }],
        text: "请逐帧/逐段拆解并输出 JSON。",
        maxTokens: REFERENCE_MAX_TOKENS,
      }).then((r) => r.text),
      parseReference,
    );
  } catch (err) {
    await input.billing.refundResource(op).catch(() => undefined);
    throw err;
  }
}


/** 逐个压缩视频素材，并对总 inline 体积兜底（gemini 请求体上限 ~20MB，base64 膨胀 4/3）。 */
async function compressVisionMedia(raw: readonly VisionMedia[]): Promise<VisionMedia[]> {
  const out: VisionMedia[] = [];
  for (const m of raw) {
    if (!m.mime.startsWith("video/")) { out.push(m); continue; }
    const compressed = await compressForVision(Buffer.from(m.base64, "base64"));
    out.push({ mime: m.mime, base64: compressed.toString("base64") });
  }
  const totalRaw = out.reduce((sum, m) => sum + Math.ceil((m.base64.length * 3) / 4), 0);
  if (totalRaw > VISION_MAX_RAW_BYTES) {
    throw new Error("素材总体积过大，请减少素材数量或上传更短的视频");
  }
  return out;
}
