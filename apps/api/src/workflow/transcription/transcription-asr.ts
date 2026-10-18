/**
 * 百炼 qwen-audio-3.1-asr-flash-filetrans 异步转写客户端。
 *
 * 接口形状依据阿里云官方文档《非实时语音识别》（DashScope 原生 HTTP 接口，
 * 非 OpenAI 兼容——qwen-audio-3.1 系列不支持 OpenAI 兼容调用）：
 * - 提交：POST {base}/api/v1/services/audio/asr/transcription
 *   Header: Authorization: Bearer {key}, X-DashScope-Async: enable
 *   Body: { model, input: { file_urls: [url] }, parameters: { channel_id: [0], language_hints } }
 * - 轮询：GET {base}/api/v1/tasks/{task_id}
 * - 结果：output.results[].transcription_url → 下载 JSON（含句/字级时间戳，毫秒）
 *
 * 注意 filetrans 只接受公网可访问的音频 URL，调用方负责传入 publicObjectUrl
 * 拼出的地址（生产 COS 有 S3_PUBLIC_BASE_URL）。
 *
 * fetchFn 可注入，便于单测用假响应覆盖提交/轮询/下载全链路。
 */

import { TRANSCRIPTION_MODEL } from "./transcription-shared.js";

export interface AsrConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly submitTimeoutMs: number;
  readonly pollTimeoutMs: number;
  readonly downloadTimeoutMs: number;
}

export interface AsrWord {
  readonly beginMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface AsrSentence {
  readonly beginMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly words: readonly AsrWord[];
}

export interface AsrResult {
  readonly text: string;
  readonly sentences: readonly AsrSentence[];
}

export class AsrConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsrConfigError";
  }
}

export class AsrApiError extends Error {
  readonly statusCode: number | null;
  readonly retryable: boolean;
  constructor(message: string, statusCode: number | null, retryable: boolean) {
    super(message);
    this.name = "AsrApiError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw?.trim() ? Number(raw.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadAsrConfig(env: NodeJS.ProcessEnv = process.env): AsrConfig {
  const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim();
  const apiKey = env.BAILIAN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) {
    throw new AsrConfigError("BAILIAN_API_KEY（或 DASHSCOPE_API_KEY）required");
  }
  const baseURL = env.TRANSCRIPTION_ASR_BASE_URL?.trim()
    || (workspaceId ? `https://${workspaceId}.cn-beijing.maas.aliyuncs.com` : "");
  if (!baseURL) {
    throw new AsrConfigError(
      "BAILIAN_WORKSPACE_ID required（用于拼 workspace 专属接入点），或直接配置 TRANSCRIPTION_ASR_BASE_URL",
    );
  }
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey,
    model: env.TRANSCRIPTION_ASR_MODEL?.trim() || TRANSCRIPTION_MODEL,
    submitTimeoutMs: positiveInt(env.TRANSCRIPTION_ASR_SUBMIT_TIMEOUT_MS, DEFAULT_SUBMIT_TIMEOUT_MS),
    pollTimeoutMs: positiveInt(env.TRANSCRIPTION_ASR_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS),
    downloadTimeoutMs: positiveInt(env.TRANSCRIPTION_ASR_DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.code === "string" && body.code) return `code=${body.code}`;
  return null;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 429 / 5xx / 网络异常可重试；其余 4xx 为永久失败。 */
export function isRetryableAsrError(error: unknown): boolean {
  if (error instanceof AsrApiError) return error.retryable;
  if (error instanceof AsrConfigError) return false;
  return true;
}

async function postJson(args: {
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
  readonly asyncHeader?: boolean;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const onAbort = () => controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    };
    if (args.asyncHeader) headers["X-DashScope-Async"] = "enable";
    const response = await args.fetchFn(args.url, {
      method: "POST",
      headers,
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
    return { status: response.status, body: await readJsonSafe(response) };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

async function getJson(args: {
  readonly url: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const onAbort = () => controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await args.fetchFn(args.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${args.apiKey}` },
      signal: controller.signal,
    });
    return { status: response.status, body: await readJsonSafe(response) };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

function throwForStatus(status: number, body: unknown, action: string): never {
  const detail = readErrorMessage(body);
  const message = `ASR${action}失败：HTTP ${status}${detail ? `（${detail}）` : ""}`;
  const retryable = status === 429 || status >= 500;
  throw new AsrApiError(message, status, retryable);
}

/** 提交转写任务，返回百炼侧 task_id。 */
export async function submitTranscription(args: {
  readonly config: AsrConfig;
  readonly fileUrl: string;
  readonly languageHints: readonly string[];
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const fetchFn = args.fetchFn ?? fetch;
  const { status, body } = await postJson({
    url: `${args.config.baseURL}/api/v1/services/audio/asr/transcription`,
    apiKey: args.config.apiKey,
    body: {
      model: args.config.model,
      input: { file_urls: [args.fileUrl] },
      parameters: { channel_id: [0], language_hints: [...args.languageHints] },
    },
    timeoutMs: args.config.submitTimeoutMs,
    fetchFn,
    signal: args.signal,
    asyncHeader: true,
  });
  if (status < 200 || status >= 300) throwForStatus(status, body, "提交任务");
  const taskId = isRecord(body) && isRecord(body.output) && typeof body.output.task_id === "string"
    ? body.output.task_id
    : null;
  if (!taskId) {
    throw new AsrApiError(`ASR提交任务失败：响应缺少 output.task_id`, status, false);
  }
  return taskId;
}

export type BailianTaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";

export interface TranscriptionJobStatus {
  readonly status: BailianTaskStatus;
  /** SUCCEEDED 时才有：结果 JSON 下载地址（24 小时有效）。 */
  readonly transcriptionUrl: string | null;
  readonly message: string | null;
}

/** 轮询一次百炼任务状态。 */
export async function pollTranscriptionStatus(args: {
  readonly config: AsrConfig;
  readonly taskId: string;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<TranscriptionJobStatus> {
  const fetchFn = args.fetchFn ?? fetch;
  const { status, body } = await getJson({
    url: `${args.config.baseURL}/api/v1/tasks/${encodeURIComponent(args.taskId)}`,
    apiKey: args.config.apiKey,
    timeoutMs: args.config.pollTimeoutMs,
    fetchFn,
    signal: args.signal,
  });
  if (status < 200 || status >= 300) throwForStatus(status, body, "查询任务");
  if (!isRecord(body) || !isRecord(body.output)) {
    throw new AsrApiError("ASR查询任务失败：响应缺少 output", status, false);
  }
  const output = body.output;
  const rawStatus = typeof output.task_status === "string" ? output.task_status : "UNKNOWN";
  const normalized: BailianTaskStatus = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"].includes(rawStatus)
    ? (rawStatus as BailianTaskStatus)
    : "UNKNOWN";
  let transcriptionUrl: string | null = null;
  if (normalized === "SUCCEEDED" && Array.isArray(output.results)) {
    const first = output.results.find((item) => isRecord(item) && item.subtask_status === "SUCCEEDED");
    if (isRecord(first) && typeof first.transcription_url === "string") {
      transcriptionUrl = first.transcription_url;
    }
  }
  const message = readErrorMessage(output);
  return { status: normalized, transcriptionUrl, message };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 解析 transcription_url 下载的 JSON，抽出全文 + 句/字级时间戳。 */
export function parseTranscriptionResult(payload: unknown): AsrResult {
  if (!isRecord(payload) || !Array.isArray(payload.transcripts)) {
    throw new AsrApiError("ASR结果解析失败：缺少 transcripts 数组", null, false);
  }
  const sentences: AsrSentence[] = [];
  for (const transcript of payload.transcripts) {
    if (!isRecord(transcript) || !Array.isArray(transcript.sentences)) continue;
    for (const item of transcript.sentences) {
      if (!isRecord(item) || typeof item.text !== "string") continue;
      const beginMs = toFiniteNumber(item.begin_time) ?? 0;
      const endMs = toFiniteNumber(item.end_time) ?? beginMs;
      const words: AsrWord[] = [];
      if (Array.isArray(item.words)) {
        for (const word of item.words) {
          if (!isRecord(word) || typeof word.text !== "string") continue;
          const wordBegin = toFiniteNumber(word.begin_time) ?? beginMs;
          const wordEnd = toFiniteNumber(word.end_time) ?? wordBegin;
          words.push({ beginMs: wordBegin, endMs: wordEnd, text: word.text });
        }
      }
      sentences.push({ beginMs, endMs, text: item.text, words });
    }
  }
  const text = sentences.map((sentence) => sentence.text).join("");
  return { text, sentences };
}

/** 下载并解析转写结果 JSON。 */
export async function downloadTranscriptionResult(args: {
  readonly config: AsrConfig;
  readonly transcriptionUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<AsrResult> {
  const fetchFn = args.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.config.downloadTimeoutMs);
  const onAbort = () => controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchFn(args.transcriptionUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new AsrApiError(
        `ASR结果下载失败：HTTP ${response.status}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    return parseTranscriptionResult(await readJsonSafe(response));
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}
