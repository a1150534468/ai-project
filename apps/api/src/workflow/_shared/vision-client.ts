/**
 * 视频/图片理解统一入口：走 gemini 原生 `/v1beta/models/{model}:generateContent` + inline_data。
 *
 * ⚠️ 为什么不用 Anthropic 的 `video` block（`callMiniMaxMessages`）：
 *  - MiniMax-M3 能 ingest 视频但【只看画面、听不见音轨】（实测：让它转写台词 → 回答「无法听到」）。
 *  - gemini 走 NewAPI 的 Anthropic 兼容端点时，video block 会被【静默丢弃】：HTTP 200、
 *    promptTokenCount 只有几十，模型凭空编一段台词。比报错更危险。
 *  - 实测唯一正确姿势 = gemini 原生端点 + inline_data（promptTokenCount 从 6 → 1795，逐字转写正确）。
 *
 * 因此本模块内置一道防线：带媒体却 promptTokenCount 过低 → 直接抛错，绝不把幻觉当结果返回。
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface VisionConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface VisionMedia {
  readonly mime: string;
  readonly base64: string;
}

export class VisionError extends Error {
  readonly name = "VisionError";
  constructor(message: string, readonly status?: number) { super(message); }
}

/** 带媒体时，promptTokenCount 低于此值即判定媒体未被上游接收（被网关丢弃）。 */
export const MIN_MEDIA_PROMPT_TOKENS = 200;
export const DEFAULT_VISION_MODEL = "gemini-2.5-flash";
export const VISION_TIMEOUT_MS = 180_000;

export function loadVisionConfig(env: NodeJS.ProcessEnv = process.env): VisionConfig {
  const baseUrl = (env.VISION_BASE_URL ?? env.LLM_BASE_URL ?? "").trim().replace(/\/+$/u, "");
  const apiKey = (env.VISION_API_KEY ?? env.LLM_API_KEY ?? "").trim();
  if (!baseUrl) throw new Error("VISION_BASE_URL 或 LLM_BASE_URL required");
  if (!apiKey) throw new Error("VISION_API_KEY 或 LLM_API_KEY required");
  const model = env.VIDEO_ANALYZE_MODEL?.trim() || DEFAULT_VISION_MODEL;
  return { baseUrl, apiKey, model };
}

export interface CallVisionArgs {
  readonly cfg: VisionConfig;
  readonly system: string;
  readonly media: readonly VisionMedia[];
  readonly text: string;
  readonly maxTokens: number;
  readonly fetchFn?: FetchLike;
  readonly timeoutMs?: number;
}

export async function callVision(args: CallVisionArgs): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const fetchFn = args.fetchFn ?? fetch;
  const parts: Array<Record<string, unknown>> = args.media.map((m) => ({ inline_data: { mime_type: m.mime, data: m.base64 } }));
  parts.push({ text: args.text });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? VISION_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(`${args.cfg.baseUrl}/v1beta/models/${args.cfg.model}:generateContent`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": args.cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: args.maxTokens },
      }),
    });
  } catch (e) {
    throw new VisionError(`视频理解请求失败：${(e as Error).name}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new VisionError(`视频理解上游 HTTP ${res.status}`, res.status);

  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const inputTokens = body.usageMetadata?.promptTokenCount ?? 0;
  // 核心防线：带了媒体却几乎没有 prompt token → 媒体被上游/网关丢弃，此时模型输出必是幻觉。
  if (args.media.length > 0 && inputTokens < MIN_MEDIA_PROMPT_TOKENS) {
    throw new VisionError(`媒体未被模型接收（promptTokenCount=${inputTokens}），疑似被网关丢弃，拒绝返回可能是幻觉的结果`);
  }

  const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  if (!text) throw new VisionError("视频理解结果为空");

  return { text, usage: { inputTokens, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0 } };
}
