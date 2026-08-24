/**
 * gpt-image 的第三方中继是 nginx，默认 proxy_read_timeout 60s，而非流式出图要等
 * 图片完全就绪才回第一个字节。实测单图耗时 56-100s，于是连接会在 60.6s 处被中继
 * 关掉（UND_ERR_SOCKET / "other side closed"），成败等于掷硬币。
 *
 * 流式下响应头 15s 就到，之后 partial_image 事件持续喂数据，读超时永不触发，
 * 实测跑到 99.8s 仍能正常收尾。因此 openai 协议的出图/改图统一走 stream=true，
 * 再把 SSE 归一化回既有解析器认识的 `{ data: [{ b64_json }] }` 形状。
 */

import { isObjectLike } from "../../runtime/records.js";

const MAX_STREAM_BYTES = 64 * 1024 * 1024;

export const IMAGE_STREAM_PARTIAL_IMAGES = 1;

export interface ImageStreamResult {
  /** 归一化后的 payload，形状与非流式响应一致 */
  readonly payload: unknown;
  /** 收到的 partial_image 事件数，仅用于可观测性 */
  readonly partialCount: number;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** 事件里的 b64；completed 事件把图挂在自身，少数中继会包一层 data[0]。 */
function base64FromEvent(event: Record<string, unknown>): string {
  const direct = stringField(event, "b64_json");
  if (direct) return direct;
  const data = event.data;
  if (Array.isArray(data) && data.length > 0 && isObjectLike(data[0])) return stringField(data[0], "b64_json");
  return "";
}

export function isImageStreamCompletedType(type: string): boolean {
  // image_generation.completed / image_edit.completed
  return type.endsWith(".completed");
}

export function isImageStreamPartialType(type: string): boolean {
  return type.endsWith(".partial_image");
}

/**
 * 读取 SSE 流并返回最后一张完整图。partial_image 只用于保活，不作为结果。
 * 上游在流中报错时抛出，错误信息取 error.message。
 */
export async function readImageStream(response: Response): Promise<ImageStreamResult> {
  const body = response.body;
  if (!body) throw new Error("image stream response has no body");
  const decoder = new TextDecoder();
  let buffered = "";
  let bytes = 0;
  let partialCount = 0;
  let completed: Record<string, unknown> | null = null;
  let lastPartialB64 = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      // 中继偶发心跳/注释行，忽略即可。
      return;
    }
    if (!isObjectLike(event)) return;
    if (isObjectLike(event.error)) {
      const message = stringField(event.error, "message") || "image stream reported an error";
      throw new Error(message.slice(0, 300));
    }
    const type = stringField(event, "type");
    if (isImageStreamPartialType(type)) {
      partialCount += 1;
      const b64 = base64FromEvent(event);
      if (b64) lastPartialB64 = b64;
      return;
    }
    if (isImageStreamCompletedType(type) || base64FromEvent(event)) {
      if (base64FromEvent(event)) completed = event;
    }
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > MAX_STREAM_BYTES) throw new Error("image stream too large");
    buffered += decoder.decode(chunk, { stream: true });
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      consumeLine(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf("\n");
    }
  }
  if (buffered) consumeLine(buffered);

  const b64 = completed ? base64FromEvent(completed) : lastPartialB64;
  if (!b64) throw new Error("image stream ended without a generated image");
  const source: Record<string, unknown> = completed ?? {};
  // 归一化成非流式形状，复用既有 extractGeneratedImage / usage 解析。
  const payload: Record<string, unknown> = { data: [{ b64_json: b64 }] };
  for (const key of ["model", "size", "quality", "usage"]) {
    if (source[key] !== undefined) payload[key] = source[key];
  }
  return { payload, partialCount };
}
