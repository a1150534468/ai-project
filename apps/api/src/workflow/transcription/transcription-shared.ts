/**
 * transcription 域里 routes / runner / reaper 共用的常量。
 *
 * 单独一个文件的唯一原因是破循环导入：transcription-routes 要 import reaper
 * 来起定时器，reaper 又要用这里的状态常量与阈值。让两边都只依赖本文件；
 * 本文件只许依赖「自己谁也不 import」的叶子模块。
 * 形状对齐 image-shared.ts。
 */

export const TRANSCRIPTION_TASK_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type TranscriptionTaskStatus =
  (typeof TRANSCRIPTION_TASK_STATUS)[keyof typeof TRANSCRIPTION_TASK_STATUS];

/** 前端语言选择 → 存库值。 */
export const TRANSCRIPTION_LANGUAGES = ["zh-CN", "yue", "en"] as const;
export type TranscriptionLanguage = (typeof TRANSCRIPTION_LANGUAGES)[number];

export const DEFAULT_TRANSCRIPTION_LANGUAGE: TranscriptionLanguage = "zh-CN";

/**
 * 语言 → 百炼 filetrans language_hints 映射。
 *
 * 注意：language_hints 的取值以官方 API 参考为准；粤语的 hint code 未在公开文档
 * 枚举，模型本身对方言（含粤语）是原生支持的，这里先映射到 "zh" 并依赖模型
 * 自动识别，待拿到真实 key 做 live 验证时再校准。
 */
export const LANGUAGE_HINTS: Record<TranscriptionLanguage, readonly string[]> = {
  "zh-CN": ["zh"],
  yue: ["zh"],
  en: ["en"],
};

export function isTranscriptionLanguage(value: string): value is TranscriptionLanguage {
  return (TRANSCRIPTION_LANGUAGES as readonly string[]).includes(value);
}

/** 上传白名单：扩展名 → MIME。 */
export const TRANSCRIPTION_AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
};

export const TRANSCRIPTION_MODEL = "qwen-audio-3.1-asr-flash-filetrans";

/** v1 单文件上限：60 分钟。filetrans 本身支持到 12 小时，这里先收紧。 */
export const TRANSCRIPTION_MAX_DURATION_SEC = 3600;

const DEFAULT_STALE_TASK_MS = 10 * 60_000;

export function loadTranscriptionStaleTaskMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRANSCRIPTION_STALE_TASK_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_TASK_MS;
}

export interface TranscriptionTaskRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly audioObjectKey: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly audioDurationSec: number | null;
  readonly language: string;
  readonly model: string;
  readonly status: string;
  readonly bailianTaskId: string | null;
  readonly transcriptText: string | null;
  readonly segmentsJson: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
