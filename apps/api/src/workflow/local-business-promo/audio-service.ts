import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadS3Config, makeS3, putObject, type S3Config } from "../../storage/s3.js";
import { trimTrailingSlash } from "../../runtime/url.js";
import { probeAudioDurationSec } from "./audio-probe.js";
import type { LocalBusinessPromoMusicPreset } from "./local-business-promo-core.js";

const DEFAULT_AUDIO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_VOICE_SAMPLE_MAX_BASE64_BYTES = 10 * 1024 * 1024;
const BGM_ASSET_DIR = fileURLToPath(new URL("../../../assets/workflow/local-business-promo-bgm/", import.meta.url));

export const MIMO_TTS_PRESET_MODEL = "mimo-v2.5-tts" as const;
export const MIMO_TTS_VOICE_DESIGN_MODEL = "mimo-v2.5-tts-voicedesign" as const;
export const MIMO_TTS_VOICE_CLONE_MODEL = "mimo-v2.5-tts-voiceclone" as const;
export const LOCAL_BUSINESS_PROMO_AUDIO_KINDS = ["voice-sample", "narration", "bgm"] as const;
export const LOCAL_BUSINESS_PROMO_AUDIO_SOURCES = ["upload", "mimo-tts", "local-bgm"] as const;

export type LocalBusinessPromoAudioKind = typeof LOCAL_BUSINESS_PROMO_AUDIO_KINDS[number];

export interface WorkflowAudioBinary {
  readonly buffer: Buffer;
  readonly mime: string;
  readonly format: string;
  readonly durationSec: number;
}

export interface StoredWorkflowAudio {
  readonly url: string;
  readonly objectKey: string | null;
  readonly mime: string;
  readonly format: string;
  readonly durationSec: number;
}

export interface MimoSpeechConfig {
  readonly endpoint: string;
  readonly apiKey: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const LOCAL_BUSINESS_PROMO_BGM_PRESET_FILES: Record<Exclude<LocalBusinessPromoMusicPreset, "no-bgm">, {
  readonly filename: string;
  readonly label: string;
}> = {
  "light-explore": { filename: "light-explore.mp3", label: "轻快探索" },
  "city-lively": { filename: "city-lively.mp3", label: "城市活力" },
  "warm-healing": { filename: "warm-healing.mp3", label: "温暖治愈" },
  "premium-clean": { filename: "premium-clean.mp3", label: "克制高级" },
};

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl.trim() || DEFAULT_AUDIO_BASE_URL);
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function loadMimoSpeechConfig(env: NodeJS.ProcessEnv = process.env): MimoSpeechConfig {
  const apiKey = (env.MIMO_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("MIMO_API_KEY required");
  return {
    endpoint: `${normalizeBaseUrl(env.MIMO_BASE_URL ?? DEFAULT_AUDIO_BASE_URL)}/chat/completions`,
    apiKey,
  };
}

function safeMime(value: string): string {
  return value.trim() || "application/octet-stream";
}

function extensionFromFilename(filename: string, mime: string): string {
  const ext = extname(filename).replace(/^\./, "").trim().toLowerCase();
  if (ext && /^[a-z0-9]{2,8}$/.test(ext)) return ext;
  if (mime.startsWith("audio/mpeg") || mime.startsWith("audio/mp3")) return "mp3";
  if (mime.startsWith("audio/wav")) return "wav";
  if (mime.startsWith("audio/")) return "wav";
  return "bin";
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function publicObjectUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv): string {
  const configuredBase = (env.VIDEO_S3_PUBLIC_BASE_URL ?? env.S3_PUBLIC_BASE_URL ?? "").trim();
  const encodedKey = encodeObjectKey(key);
  if (configuredBase) return `${trimTrailingSlash(configuredBase)}/${encodedKey}`;
  const endpoint = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) return `${trimTrailingSlash(cfg.endpoint)}/${encodeURIComponent(cfg.bucket)}/${encodedKey}`;
  return `${endpoint.protocol}//${cfg.bucket}.${endpoint.host}/${encodedKey}`;
}

function tryLoadS3(env: NodeJS.ProcessEnv): { readonly cfg: S3Config; readonly s3: ReturnType<typeof makeS3> } | null {
  try {
    const cfg = loadS3Config(env);
    return { cfg, s3: makeS3(cfg) };
  } catch {
    return null;
  }
}

export function buildDataUrl(buffer: Buffer, mime: string): string {
  return `data:${safeMime(mime)};base64,${buffer.toString("base64")}`;
}

function buildVoiceDesignInstruction(voiceDesignPrompt: string, voiceStylePrompt: string): string {
  const parts = [
    voiceDesignPrompt.trim(),
    voiceStylePrompt.trim() ? `播报风格：${voiceStylePrompt.trim()}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

export function buildMimoSpeechRequest(args: {
  readonly model: typeof MIMO_TTS_PRESET_MODEL | typeof MIMO_TTS_VOICE_DESIGN_MODEL | typeof MIMO_TTS_VOICE_CLONE_MODEL;
  readonly text: string;
  readonly presetVoiceId?: string;
  readonly voiceDesignPrompt?: string;
  readonly voiceStylePrompt?: string;
  readonly voiceSampleDataUrl?: string;
}): Record<string, unknown> {
  const text = args.text.trim();
  if (!text) throw new Error("missing narration text");
  if (args.model === MIMO_TTS_PRESET_MODEL) {
    if (!args.presetVoiceId?.trim()) throw new Error("missing preset voice id");
    return {
      model: args.model,
      messages: [{ role: "assistant", content: text }],
      audio: {
        format: "wav",
        voice: args.presetVoiceId.trim(),
      },
    };
  }
  if (args.model === MIMO_TTS_VOICE_DESIGN_MODEL) {
    const userContent = buildVoiceDesignInstruction(args.voiceDesignPrompt ?? "", args.voiceStylePrompt ?? "");
    if (!userContent.trim()) throw new Error("missing voice design prompt");
    return {
      model: args.model,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: text },
      ],
      audio: { format: "wav" },
    };
  }
  if (!args.voiceSampleDataUrl?.trim()) throw new Error("missing voice clone sample");
  const messages = [
    ...(args.voiceStylePrompt?.trim() ? [{ role: "user", content: args.voiceStylePrompt.trim() }] : []),
    { role: "assistant", content: text },
  ];
  return {
    model: args.model,
    messages,
    audio: {
      format: "wav",
      voice: args.voiceSampleDataUrl.trim(),
    },
  };
}

export async function synthesizeMimoSpeech(args: {
  readonly fetchFn: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly model: typeof MIMO_TTS_PRESET_MODEL | typeof MIMO_TTS_VOICE_DESIGN_MODEL | typeof MIMO_TTS_VOICE_CLONE_MODEL;
  readonly text: string;
  readonly presetVoiceId?: string;
  readonly voiceDesignPrompt?: string;
  readonly voiceStylePrompt?: string;
  readonly voiceSampleDataUrl?: string;
}): Promise<WorkflowAudioBinary> {
  const env = args.env ?? process.env;
  const cfg = loadMimoSpeechConfig(env);
  const payload = buildMimoSpeechRequest({
    model: args.model,
    text: args.text,
    presetVoiceId: args.presetVoiceId,
    voiceDesignPrompt: args.voiceDesignPrompt,
    voiceStylePrompt: args.voiceStylePrompt,
    voiceSampleDataUrl: args.voiceSampleDataUrl,
  });
  const response = await args.fetchFn(cfg.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": cfg.apiKey,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`mimo speech ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`);
  }
  const body = await response.json() as {
    readonly choices?: ReadonlyArray<{
      readonly message?: {
        readonly audio?: {
          readonly data?: string;
        };
      };
    }>;
  };
  const encoded = body.choices?.[0]?.message?.audio?.data?.trim();
  if (!encoded) throw new Error("mimo speech result missing audio data");
  const buffer = Buffer.from(encoded, "base64");
  const durationSec = await probeAudioDurationSec(buffer);
  return {
    buffer,
    mime: "audio/wav",
    format: "wav",
    durationSec,
  };
}

export async function storeWorkflowAudio(args: {
  readonly userId: string;
  readonly filename: string;
  readonly mime: string;
  readonly buffer: Buffer;
  readonly env?: NodeJS.ProcessEnv;
  readonly folder?: string;
}): Promise<StoredWorkflowAudio> {
  const env = args.env ?? process.env;
  const loaded = tryLoadS3(env);
  const maxBytes = Number(env.AUDIO_MAX_BYTES) || DEFAULT_AUDIO_MAX_BYTES;
  if (args.buffer.byteLength > maxBytes) throw new Error("audio too large");
  const mime = safeMime(args.mime);
  const durationSec = mime.startsWith("audio/") ? await probeAudioDurationSec(args.buffer) : 0;
  if (!loaded) {
    return {
      url: buildDataUrl(args.buffer, mime),
      objectKey: null,
      mime,
      format: extensionFromFilename(args.filename, mime),
      durationSec,
    };
  }
  const folder = args.folder?.trim().replace(/^\/+|\/+$/g, "") || `workflow/audio/${args.userId}`;
  const ext = extensionFromFilename(args.filename, mime);
  const key = `${folder}/${randomUUID()}.${ext}`;
  await putObject(loaded.s3, key, args.buffer, mime, { acl: "public-read" });
  return {
    url: publicObjectUrl(loaded.cfg, key, env),
    objectKey: key,
    mime,
    format: ext,
    durationSec,
  };
}

export function encodeVoiceCloneSample(args: {
  readonly buffer: Buffer;
  readonly mime: string;
}): string {
  const mime = safeMime(args.mime);
  const normalizedMime = mime === "audio/mp3"
    ? "audio/mpeg"
    : mime === "audio/x-m4a" || mime === "audio/m4a"
      ? "audio/mp4"
      : mime;
  if (!(normalizedMime === "audio/mpeg" || normalizedMime === "audio/wav" || normalizedMime === "audio/mp4")) {
    throw new Error("仅支持 mp3/wav/m4a 音色样本");
  }
  const encoded = args.buffer.toString("base64");
  if (Buffer.byteLength(encoded, "utf8") > DEFAULT_VOICE_SAMPLE_MAX_BASE64_BYTES) {
    throw new Error("音色样本 Base64 编码后不能超过 10MB");
  }
  return `data:${normalizedMime};base64,${encoded}`;
}

export async function validateVoiceCloneSampleFile(args: {
  readonly filename: string;
  readonly mime: string;
  readonly buffer: Buffer;
}): Promise<{ readonly mime: string; readonly durationSec: number }> {
  const mime = safeMime(args.mime);
  const ext = extensionFromFilename(args.filename, mime);
  const normalizedMime = ext === "m4a" || mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a"
    ? "audio/mp4"
    : mime === "audio/mp3"
      ? "audio/mpeg"
      : mime;
  if (!["mp3", "wav", "m4a"].includes(ext) && !["audio/mpeg", "audio/mp3", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/m4a"].includes(mime)) {
    throw new Error("仅支持 mp3/wav/m4a 音色样本");
  }
  encodeVoiceCloneSample({ buffer: args.buffer, mime: normalizedMime });
  return {
    mime: normalizedMime,
    durationSec: await probeAudioDurationSec(args.buffer),
  };
}

export async function validateUploadedBgmFile(args: {
  readonly filename: string;
  readonly mime: string;
  readonly buffer: Buffer;
}): Promise<{ readonly mime: string; readonly durationSec: number }> {
  const mime = safeMime(args.mime);
  const ext = extensionFromFilename(args.filename, mime);
  if (!["mp3", "wav"].includes(ext) && !["audio/mpeg", "audio/mp3", "audio/wav"].includes(mime)) {
    throw new Error("仅支持上传 mp3/wav 格式的 BGM");
  }
  return {
    mime: mime === "audio/mp3" ? "audio/mpeg" : mime,
    durationSec: await probeAudioDurationSec(args.buffer),
  };
}

export function localBusinessPromoBgmPresetFile(preset: LocalBusinessPromoMusicPreset): {
  readonly filename: string;
  readonly path: string;
  readonly label: string;
  readonly mime: string;
} | null {
  if (preset === "no-bgm") return null;
  const item = LOCAL_BUSINESS_PROMO_BGM_PRESET_FILES[preset];
  return {
    filename: item.filename,
    path: join(BGM_ASSET_DIR, item.filename),
    label: item.label,
    mime: "audio/mpeg",
  };
}

export async function ensureLocalBusinessPromoBgmLibrary(): Promise<void> {
  await Promise.all(Object.values(LOCAL_BUSINESS_PROMO_BGM_PRESET_FILES).map(async ({ filename }) => {
    const path = join(BGM_ASSET_DIR, filename);
    await access(path);
  }));
}

export async function loadLocalBusinessPromoBgmBinary(preset: LocalBusinessPromoMusicPreset): Promise<WorkflowAudioBinary | null> {
  const file = localBusinessPromoBgmPresetFile(preset);
  if (!file) return null;
  const buffer = await readFile(file.path);
  return {
    buffer,
    mime: file.mime,
    format: extensionFromFilename(file.filename, file.mime),
    durationSec: await probeAudioDurationSec(buffer),
  };
}
