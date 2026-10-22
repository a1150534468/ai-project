import { z } from "zod";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import {
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  isTranscriptionLanguage,
  TRANSCRIPTION_AUDIO_MIME_TYPES,
  TRANSCRIPTION_LANGUAGES,
  type TranscriptionTaskRow,
} from "./transcription-shared.js";

export const transcriptionCreateSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  language: z.enum(TRANSCRIPTION_LANGUAGES).default(DEFAULT_TRANSCRIPTION_LANGUAGE),
});

export const transcriptionTaskParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

export const transcriptionTranscriptSchema = z.object({
  transcriptText: z.string().trim().min(1).max(500_000),
});

export type TranscriptionCreateRequest = z.infer<typeof transcriptionCreateSchema>;

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export function loadTranscriptionMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRANSCRIPTION_MAX_BYTES?.trim() || env.AUDIO_MAX_BYTES?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_BYTES;
}

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "audio";
  return base.replace(/[^A-Za-z0-9._\-()\u4e00-\u9fa5]/g, "_").slice(0, 128) || "audio";
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

/** 校验扩展名白名单；返回归一化后的 mime。 */
export function resolveAudioMime(filename: string, declaredMime: string): string | null {
  const expected = TRANSCRIPTION_AUDIO_MIME_TYPES[extensionOf(filename)];
  if (!expected) return null;
  if (!declaredMime || declaredMime === "application/octet-stream") return expected;
  const normalized = declaredMime.split(";")[0].trim().toLowerCase();
  if (normalized === expected) return expected;
  // 浏览器对 m4a/aac 的 mime 上报不统一，扩展名白名单通过即放行
  if (normalized.startsWith("audio/")) return expected;
  return null;
}

// 走共享实现，不用 `String(error)`：后者会把任意值（含上游返回的裸对象）原样泄进响应体。
// 迁移前这里就是那个被 `errorMessageOrFallback` 注释明令禁止的写法。
export function safeErrorMessage(error: unknown): string {
  return errorMessageOrFallback(error, "转写任务处理失败");
}

export interface SerializedTranscriptionTask {
  readonly id: string;
  readonly requestId: string;
  readonly fileName: string;
  readonly language: string;
  readonly status: string;
  readonly transcriptText: string | null;
  readonly segments: readonly {
    readonly beginMs: number;
    readonly endMs: number;
    readonly text: string;
  }[] | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeTask(row: TranscriptionTaskRow): SerializedTranscriptionTask {
  let segments: SerializedTranscriptionTask["segments"] = null;
  if (row.segmentsJson) {
    try {
      const parsed: unknown = JSON.parse(row.segmentsJson);
      if (Array.isArray(parsed)) {
        segments = parsed
          .filter((item): item is { beginMs: number; endMs: number; text: string } =>
            typeof item === "object" && item !== null
            && typeof (item as { text?: unknown }).text === "string",
          )
          .map((item) => ({ beginMs: item.beginMs, endMs: item.endMs, text: item.text }));
      }
    } catch {
      segments = null;
    }
  }
  return {
    id: row.id,
    requestId: row.requestId,
    fileName: row.fileName,
    language: isTranscriptionLanguage(row.language) ? row.language : DEFAULT_TRANSCRIPTION_LANGUAGE,
    status: row.status,
    transcriptText: row.transcriptText,
    segments,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
