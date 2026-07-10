import { randomUUID } from "node:crypto";
import type { MimoConfig, FetchLike, TtsMessage, TtsAudioOpts } from "./dub-mimo-client.js";
import * as mimo from "./dub-mimo-client.js";
import { DUB_TTS_CHAR_KEY, DUB_TTS_MODEL_BY_MODE, type DubTtsMode } from "./dub-constants.js";

export interface BuildTtsInput {
  mode: DubTtsMode; text: string; format: "wav" | "mp3";
  voice?: string; // preset 音色 id
  description?: string; // design 音色描述
  style?: string; // preset/clone 可选自然语言风格
  refAudioDataUri?: string; // clone 参考音频 data URI
}

export function buildTtsRequest(input: BuildTtsInput): { model: string; messages: TtsMessage[]; audio: TtsAudioOpts } {
  const model = DUB_TTS_MODEL_BY_MODE[input.mode];
  const messages: TtsMessage[] = [];
  let voice: string | undefined;
  if (input.mode === "design") {
    messages.push({ role: "user", content: input.description ?? "" });
    messages.push({ role: "assistant", content: input.text });
  } else {
    if (input.style) messages.push({ role: "user", content: input.style });
    messages.push({ role: "assistant", content: input.text });
    if (input.mode === "preset" && input.voice) voice = input.voice;
    if (input.mode === "clone" && input.refAudioDataUri) voice = input.refAudioDataUri;
  }
  const audio: TtsAudioOpts = { format: input.format, ...(voice ? { voice } : {}) };
  return { model, messages, audio };
}

export interface TtsBilling {
  chargeResource: (a: { operationId: string; userId: string; resourceKey: string; units: number; accountType: "points" }) => Promise<{ charged: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}

export interface GenerateTtsArgs extends BuildTtsInput {
  cfg: MimoConfig; fetchFn: FetchLike; billing: TtsBilling; userId: string;
  synth?: typeof mimo.synthesizeTts;
  storeAudio: (a: { userId: string; buffer: Buffer; mime: string; ext: string }) => Promise<{ url: string; objectKey: string }>;
  probeDurationSec: (buf: Buffer) => Promise<number>;
}

export async function generateTts(args: GenerateTtsArgs): Promise<{ audioUrl: string; objectKey: string; durationSec: number; chargedPoints: number }> {
  const text = args.text?.trim() ?? "";
  if (!text) throw new Error("文案不能为空");
  const synth = args.synth ?? mimo.synthesizeTts;
  const operationId = `dub-tts:${randomUUID()}`;
  const charged = await args.billing.chargeResource({ operationId, userId: args.userId, resourceKey: DUB_TTS_CHAR_KEY, units: text.length, accountType: "points" });
  try {
    const req = buildTtsRequest({ ...args, text });
    const out = await synth(args.cfg, args.fetchFn, req);
    const buffer = Buffer.from(out.data, "base64");
    const ext = out.format === "mp3" ? "mp3" : "wav";
    const mime = ext === "mp3" ? "audio/mpeg" : "audio/wav";
    const stored = await args.storeAudio({ userId: args.userId, buffer, mime, ext });
    const durationSec = Math.max(0, Math.round(await args.probeDurationSec(buffer)));
    return { audioUrl: stored.url, objectKey: stored.objectKey, durationSec, chargedPoints: charged.charged };
  } catch (e) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw e;
  }
}
