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
 * filetrans 只接受**百炼能拉到**的地址：公网 HTTP(S)，或阿里云 OSS 的 `oss://` 临时地址
 * （后者需要 `X-DashScope-OssResourceResolve: enable`，见 `uploadToDashScopeTempStorage`）。
 *
 * 对象地址是内网/单标签主机名时，百炼那边解析不了、也读不到 —— 表现是任务
 * 跑几十秒后失败、只回一个 `code=SERVER_ERROR`。所以走公网 URL 之前必须先过
 * `isPubliclyReachableUrl`，内网地址改走百炼临时存储中转。
 * 对象存储现在是腾讯云 COS、地址公网可达，正常配置下这里不会产生中转上传；
 * 只有把 `S3_ENDPOINT` 配成内网地址（或对象落在私有 VPC）时才会走回中转路径。
 *
 * fetchFn 可注入，便于单测用假响应覆盖提交/轮询/下载全链路。
 */

import { envInt } from "../../runtime/env.js";
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


export function loadAsrConfig(env: NodeJS.ProcessEnv = process.env): AsrConfig {
  const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim();
  const apiKey = env.BAILIAN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) {
    throw new AsrConfigError("BAILIAN_API_KEY（或 DASHSCOPE_API_KEY）required");
  }
  const baseURL =
    env.TRANSCRIPTION_ASR_BASE_URL?.trim() ||
    (workspaceId ? `https://${workspaceId}.cn-beijing.maas.aliyuncs.com` : "");
  if (!baseURL) {
    throw new AsrConfigError(
      "BAILIAN_WORKSPACE_ID required（用于拼 workspace 专属接入点），或直接配置 TRANSCRIPTION_ASR_BASE_URL",
    );
  }
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey,
    model: env.TRANSCRIPTION_ASR_MODEL?.trim() || TRANSCRIPTION_MODEL,
    submitTimeoutMs: envInt(env, "TRANSCRIPTION_ASR_SUBMIT_TIMEOUT_MS", DEFAULT_SUBMIT_TIMEOUT_MS),
    pollTimeoutMs: envInt(env, "TRANSCRIPTION_ASR_POLL_TIMEOUT_MS", DEFAULT_POLL_TIMEOUT_MS),
    downloadTimeoutMs: envInt(env, "TRANSCRIPTION_ASR_DOWNLOAD_TIMEOUT_MS", DEFAULT_DOWNLOAD_TIMEOUT_MS),
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

/**
 * 这个地址百炼能不能拉到。
 *
 * 只挡「一定拉不到」的那几类：localhost / *.local、回环、私网、链路本地。判定为 false 时
 * 调用方要改走 `uploadToDashScopeTempStorage`；判定为 true 也不保证一定通（域名解析、
 * 403 权限仍然可能失败），那是存储侧的配置问题，不该被这里悄悄吞掉。
 */
export function isPubliclyReachableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // IPv6 在 URL 里带方括号，统一剥掉再判
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;

  if (host.includes(":")) {
    // ::1 / :: 回环，fc00::/7 唯一本地，fe80::/10 链路本地
    if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false;
    return true;
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
  }
  // 单标签主机名（compose 里的服务名等）不是公网 FQDN，百炼解析不了
  if (!host.includes(".")) return false;
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
  readonly extraHeaders?: Readonly<Record<string, string>>;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const onAbort = () => controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      ...args.extraHeaders,
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
    // oss:// 是百炼自己的临时存储，要显式让服务端去解析；公网 http(s) 地址不加这个头
    extraHeaders: args.fileUrl.startsWith("oss://") ? { "X-DashScope-OssResourceResolve": "enable" } : undefined,
  });
  if (status < 200 || status >= 300) throwForStatus(status, body, "提交任务");
  const taskId =
    isRecord(body) && isRecord(body.output) && typeof body.output.task_id === "string" ? body.output.task_id : null;
  if (!taskId) {
    throw new AsrApiError(`ASR提交任务失败：响应缺少 output.task_id`, status, false);
  }
  return taskId;
}

/** `getPolicy` 返回的上传凭证。字段名沿用 OSS 表单原文，只挑我们真正要填的几个。 */
interface DashScopeUploadPolicy {
  readonly uploadDir: string;
  readonly uploadHost: string;
  readonly ossAccessKeyId: string;
  readonly signature: string;
  readonly policy: string;
  readonly objectAcl: string;
  readonly forbidOverwrite: string;
}

function readUploadPolicy(body: unknown, status: number): DashScopeUploadPolicy {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const policy: DashScopeUploadPolicy = {
    uploadDir: text(data?.upload_dir),
    uploadHost: text(data?.upload_host),
    ossAccessKeyId: text(data?.oss_access_key_id),
    signature: text(data?.signature),
    policy: text(data?.policy),
    objectAcl: text(data?.x_oss_object_acl),
    forbidOverwrite: text(data?.x_oss_forbid_overwrite),
  };
  if (!policy.uploadDir || !policy.uploadHost || !policy.ossAccessKeyId || !policy.signature || !policy.policy) {
    throw new AsrApiError("ASR临时上传失败：上传凭证字段不全", status, false);
  }
  return policy;
}

/** OSS 表单上传`file`域必须最后，且文件名里的路径分隔符会破坏 key。 */
function uploadObjectName(fileName: string): string {
  const cleaned = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || "audio";
}

/**
 * 把音频先传到百炼的临时存储，拿到 `oss://` 地址再提交 filetrans。
 *
 * 用途：本地开发 / 内网部署时对象存储没有公网地址，百炼直接拉 `http://localhost:9000/...`
 * 只会得到一个迟到的 `SERVER_ERROR`。这条路等价于官方 Python 示例先传文件再识别，
 * 只是换成 Node 的 FormData 直接打 OSS 表单接口。
 *
 * 限制（官方文档明说，别拿去当生产主路径）：凭证接口限流 100 QPS，
 * `oss://` 地址 48 小时过期 —— 转写是提交后立刻跑，过期时间对我们没有影响。
 */
export async function uploadToDashScopeTempStorage(args: {
  readonly config: AsrConfig;
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly contentType: string;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const fetchFn = args.fetchFn ?? fetch;
  const policyArgs = {
    apiKey: args.config.apiKey,
    timeoutMs: args.config.submitTimeoutMs,
    fetchFn,
    signal: args.signal,
  };

  const policyResponse = await getJson({
    ...policyArgs,
    url: `${args.config.baseURL}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(args.config.model)}`,
  });
  if (policyResponse.status < 200 || policyResponse.status >= 300) {
    throwForStatus(policyResponse.status, policyResponse.body, "获取临时上传凭证");
  }
  const policy = readUploadPolicy(policyResponse.body, policyResponse.status);
  const objectName = uploadObjectName(args.fileName);
  const key = `${policy.uploadDir}/${objectName}`;

  const form = new FormData();
  form.append("OSSAccessKeyId", policy.ossAccessKeyId);
  form.append("Signature", policy.signature);
  form.append("policy", policy.policy);
  form.append("x-oss-object-acl", policy.objectAcl);
  form.append("x-oss-forbid-overwrite", policy.forbidOverwrite);
  form.append("key", key);
  form.append("success_action_status", "200");
  // 必须最后 append：OSS 表单要求 file 域在末尾
  form.append("file", new Blob([new Uint8Array(args.bytes)], { type: args.contentType }), objectName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.config.downloadTimeoutMs);
  const onAbort = () => controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchFn(policy.uploadHost, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AsrApiError(
        `ASR临时上传失败：HTTP ${response.status}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
  return `oss://${key}`;
}

export type BailianTaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";

export interface TranscriptionJobStatus {
  readonly status: BailianTaskStatus;
  /** SUCCEEDED 时才有：结果 JSON 下载地址（24 小时有效）。 */
  readonly transcriptionUrl: string | null;
  /** 失败时的机器可读原因（如 ASR_RESPONSE_HAVE_NO_WORDS），用于给用户一句人话。 */
  readonly code: string | null;
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
  const code = typeof output.code === "string" && output.code ? output.code : null;
  return { status: normalized, transcriptionUrl, code, message };
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
