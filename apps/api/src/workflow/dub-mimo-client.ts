import { z } from "zod";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface MimoConfig { readonly apiKey: string; readonly baseUrl: string }
export interface TtsMessage { readonly role: "user" | "assistant"; readonly content: string }
export interface TtsAudioOpts { readonly format: "wav" | "mp3"; readonly voice?: string; readonly optimize_text_preview?: boolean }

export class MimoError extends Error {
  readonly name = "MimoError";
  constructor(message: string) { super(message); }
}

export function loadMimoConfig(env: NodeJS.ProcessEnv = process.env): MimoConfig {
  const apiKey = env.MIMO_API_KEY?.trim();
  if (!apiKey) throw new Error("MIMO_API_KEY required");
  const baseUrl = (env.MIMO_BASE_URL?.trim() || "https://api.xiaomimimo.com/v1").replace(/\/+$/u, "");
  return { apiKey, baseUrl };
}

const respSchema = z.object({
  choices: z.array(z.object({ message: z.object({ audio: z.object({ data: z.string() }).optional() }) })).min(1),
});

export async function synthesizeTts(
  cfg: MimoConfig,
  fetchFn: FetchLike,
  req: { model: string; messages: TtsMessage[]; audio: TtsAudioOpts },
): Promise<{ data: string; format: string }> {
  const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "api-key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ model: req.model, messages: req.messages, audio: req.audio }),
  });
  if (!res.ok) throw new MimoError(`mimo tts http ${res.status}`);
  const parsed = respSchema.parse(await res.json());
  const data = parsed.choices[0]?.message.audio?.data;
  if (!data) throw new MimoError("mimo tts 响应缺少音频数据");
  return { data, format: req.audio.format };
}
