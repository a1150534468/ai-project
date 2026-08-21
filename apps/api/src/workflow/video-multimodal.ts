import type Anthropic from "@anthropic-ai/sdk";
import { loadWorkflowMediaBuffer, type WorkflowMediaSource } from "./_shared/workflow-media-loader.js";

export const M3_MODEL = "MiniMax-M3";
export const M3_TIMEOUT_MS = 120_000;

export interface MediaInput extends WorkflowMediaSource {}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "video"; source: { type: "base64"; media_type: string; data: string } };

async function toBase64(input: MediaInput, fetchFn: typeof fetch): Promise<{ mime: string; data: string }> {
  const loaded = await loadWorkflowMediaBuffer({
    source: input,
    fetchFn,
  });
  return {
    mime: loaded.mime,
    data: loaded.buffer.toString("base64"),
  };
}

/**
 * 把素材统一取成 base64，供 gemini 原生 inline_data 使用。
 * 注意：不要再用下面的 buildBlocks + callMiniMaxMessages 做「视频理解」——
 * M3 听不见音轨，gemini 走 Anthropic video block 会被网关静默丢弃。见 vision-client.ts。
 */
export async function buildVisionMedia(
  media: readonly MediaInput[],
  opts: { fetchFn?: typeof fetch } = {},
): Promise<Array<{ mime: string; base64: string }>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const out: Array<{ mime: string; base64: string }> = [];
  for (const item of media) {
    const { mime, data } = await toBase64(item, fetchFn);
    out.push({ mime, base64: data });
  }
  return out;
}

// 图片→image block，视频→video block（Anthropic 兼容端点专用格式），末尾追加文本。
export async function buildBlocks(
  media: readonly MediaInput[],
  text: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<ContentBlock[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const blocks: ContentBlock[] = [];
  for (const item of media) {
    const kind = item.mime.startsWith("video/") ? "video" : "image";
    const { mime, data } = await toBase64(item, fetchFn);
    blocks.push({ type: kind, source: { type: "base64", media_type: mime, data } } as ContentBlock);
  }
  blocks.push({ type: "text", text });
  return blocks;
}

export async function callMiniMaxMessages(args: {
  readonly client: Anthropic;
  readonly system: string;
  readonly blocks: ContentBlock[];
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const raw = await args.client.messages.create(
    {
      model: M3_MODEL,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: [{ role: "user", content: args.blocks as unknown as Anthropic.MessageParam["content"] }],
    },
    { timeout: M3_TIMEOUT_MS, signal: args.signal },
  );
  const resp = typeof raw === "string"
    ? JSON.parse(raw) as Anthropic.Message
    : raw;
  if (!Array.isArray(resp.content)) {
    throw new Error(`LLM 响应缺少 content 字段：${JSON.stringify(resp).slice(0, 500)}`);
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { text, usage: { inputTokens: resp.usage?.input_tokens ?? 0, outputTokens: resp.usage?.output_tokens ?? 0 } };
}
