/**
 * transcription 任务执行层：认领 → 提交百炼 filetrans → 轮询 → 下载结果 → 落库。
 *
 * 并发与续跑对齐 image-task-runner.ts：
 * - `activeTranscriptionTasks` 登记表：cancel 路由 abort 的是同一张表，取消才不会静默失效；
 * - `claimStaleTask` 用 updatedAt 乐观锁认领卡单；
 * - runner 每次轮询都写一次 bailianTaskId（哪怕值不变）刷 @updatedAt 当心跳，
 *   reaper 只扫「running 且超期无心跳」的行，正常跑的行不会被偷走。
 */

import type { PrismaClient } from "@prisma/client";
import { envInt } from "../../runtime/env.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import { publicObjectUrl } from "../../storage/public-url.js";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import {
  downloadTranscriptionResult,
  isPubliclyReachableUrl,
  isRetryableAsrError,
  loadAsrConfig,
  pollTranscriptionStatus,
  submitTranscription,
  uploadToDashScopeTempStorage,
  type AsrConfig,
  type AsrResult,
  type TranscriptionJobStatus,
} from "./transcription-asr.js";
import {
  isTranscriptionLanguage,
  LANGUAGE_HINTS,
  TRANSCRIPTION_TASK_STATUS,
  type TranscriptionLanguage,
  type TranscriptionTaskRow,
} from "./transcription-shared.js";

export interface TranscriptionRunnerConfig {
  readonly asr: AsrConfig;
  /** 轮询间隔（毫秒）。 */
  readonly pollIntervalMs: number;
  /** 整轮运行超时（毫秒），覆盖 60 分钟音频的最坏转写耗时。 */
  readonly runTimeoutMs: number;
  /** 提交阶段的最大尝试次数。 */
  readonly maxSubmitAttempts: number;
  /** 提交重试间隔（毫秒）。 */
  readonly submitRetryDelayMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 8000;
const DEFAULT_RUN_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_MAX_SUBMIT_ATTEMPTS = 3;
const DEFAULT_SUBMIT_RETRY_DELAY_MS = 5000;


export function loadTranscriptionRunnerConfig(env: NodeJS.ProcessEnv = process.env): TranscriptionRunnerConfig {
  return {
    asr: loadAsrConfig(env),
    pollIntervalMs: envInt(env, "TRANSCRIPTION_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    runTimeoutMs: envInt(env, "TRANSCRIPTION_RUN_TIMEOUT_MS", DEFAULT_RUN_TIMEOUT_MS),
    maxSubmitAttempts: envInt(env, "TRANSCRIPTION_MAX_ATTEMPTS", DEFAULT_MAX_SUBMIT_ATTEMPTS),
    submitRetryDelayMs: envInt(env, "TRANSCRIPTION_SUBMIT_RETRY_DELAY_MS", DEFAULT_SUBMIT_RETRY_DELAY_MS),
  };
}

// 与 transcription-route-helpers 同一份口径，见那里的注释：不用 `String(error)`。
export function safeErrorMessage(error: unknown): string {
  return errorMessageOrFallback(error, "转写任务处理失败");
}

/** 取消登记表：requestId → AbortController。绝不在别处另建一份。 */
export const activeTranscriptionTasks = new Map<string, AbortController>();

export type ScheduleTask = (work: () => Promise<void>) => void;

async function updateTask(prisma: PrismaClient, id: string, data: Record<string, unknown>): Promise<void> {
  await prisma.transcriptionTask.update({ where: { id }, data });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("转写任务已取消");
    error.name = "TranscriptionTaskStoppedError";
    throw error;
  }
}

function isStoppedError(error: unknown): boolean {
  return error instanceof Error && error.name === "TranscriptionTaskStoppedError";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("转写任务已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("转写任务已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function languageOf(task: TranscriptionTaskRow): TranscriptionLanguage {
  return isTranscriptionLanguage(task.language) ? task.language : "zh-CN";
}

/**
 * 交给百炼的音频地址。
 *
 * 对象存储是腾讯云 COS、地址公网可达，正常配置下直接给公网直链，不产生任何额外上传；
 * 只有把 `S3_ENDPOINT` 配成内网地址时，百炼才拉不到 —— 这时先传到百炼的临时存储，
 * 换成 `oss://` 地址。不这么兜的话，任务要跑四十多秒才失败，而且只回一个
 * `code=SERVER_ERROR`，完全看不出是「你的对象存储在内网」。
 */
async function resolveAudioFileUrl(args: {
  readonly cfg: TranscriptionRunnerConfig;
  readonly fetchFn: typeof fetch;
  readonly task: TranscriptionTaskRow;
  readonly signal: AbortSignal;
}): Promise<string> {
  const s3Config = loadS3Config();
  const publicUrl = publicObjectUrl(s3Config, args.task.audioObjectKey);
  if (isPubliclyReachableUrl(publicUrl)) return publicUrl;

  const bytes = await getObject(makeS3(s3Config), args.task.audioObjectKey);
  return uploadToDashScopeTempStorage({
    config: args.cfg.asr,
    bytes,
    fileName: args.task.fileName,
    contentType: args.task.mimeType,
    fetchFn: args.fetchFn,
    signal: args.signal,
  });
}

/** 百炼的失败码翻成人话；没收录的就把原文抛出去，别吞。 */
const TASK_FAILURE_HINTS: Record<string, string> = {
  ASR_RESPONSE_HAVE_NO_WORDS: "没有识别到人声（录音可能是静音、纯环境噪声或格式异常）",
  ASR_RESPONSE_HAVE_NO_VALID_SENTENCE: "没有识别到有效语句（录音过短或没有人声）",
  ASR_RESPONSE_HAVE_NO_VALID_WORD: "没有识别到有效字词（录音可能是静音或噪声）",
};

function taskFailureMessage(job: TranscriptionJobStatus): string {
  const hint = job.code ? TASK_FAILURE_HINTS[job.code] : undefined;
  if (hint) return `百炼转写任务失败：${hint}（${job.code}）`;
  const detail = job.message && job.message !== job.code ? job.message : job.code;
  return `百炼转写任务失败${detail ? `：${detail}` : "：百炼未返回原因"}`;
}

async function submitWithRetry(args: {
  readonly prisma: PrismaClient;
  readonly cfg: TranscriptionRunnerConfig;
  readonly fetchFn: typeof fetch;
  readonly task: TranscriptionTaskRow;
  readonly fileUrl: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { prisma, cfg, fetchFn, task, fileUrl, signal } = args;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= cfg.maxSubmitAttempts; attempt += 1) {
    assertNotAborted(signal);
    try {
      const taskId = await submitTranscription({
        config: cfg.asr,
        fileUrl,
        languageHints: LANGUAGE_HINTS[languageOf(task)],
        fetchFn,
        signal,
      });
      await updateTask(prisma, task.id, { bailianTaskId: taskId });
      return taskId;
    } catch (error) {
      lastError = error;
      if (!isRetryableAsrError(error)) throw error;
      if (attempt < cfg.maxSubmitAttempts) {
        await updateTask(prisma, task.id, {
          error: `提交转写任务失败（第 ${attempt} 次），${cfg.submitRetryDelayMs}ms 后重试`,
        });
        await sleep(cfg.submitRetryDelayMs, signal);
      }
    }
  }
  throw lastError;
}

async function pollUntilDone(args: {
  readonly prisma: PrismaClient;
  readonly cfg: TranscriptionRunnerConfig;
  readonly fetchFn: typeof fetch;
  readonly taskId: string;
  readonly rowId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
}): Promise<string> {
  const { prisma, cfg, fetchFn, taskId, rowId, signal, deadline } = args;
  for (;;) {
    assertNotAborted(signal);
    if (Date.now() >= deadline) {
      throw new Error("转写超时：百炼任务长时间未完成");
    }
    let job;
    try {
      job = await pollTranscriptionStatus({ config: cfg.asr, taskId, fetchFn, signal });
    } catch (error) {
      if (!isRetryableAsrError(error)) throw error;
      await updateTask(prisma, rowId, { error: `查询转写状态失败：${safeErrorMessage(error)}，继续等待` });
      await sleep(cfg.pollIntervalMs, signal);
      continue;
    }
    // 心跳：刷 updatedAt，reaper 就不会把正常跑的行判成卡单
    await updateTask(prisma, rowId, { bailianTaskId: taskId, error: null });
    if (job.status === "SUCCEEDED") {
      if (!job.transcriptionUrl) throw new Error("转写成功但未返回结果下载地址");
      return job.transcriptionUrl;
    }
    if (job.status === "FAILED") {
      throw new Error(taskFailureMessage(job));
    }
    if (job.status === "CANCELED") {
      throw new Error(`百炼转写任务被取消${job.message ? `：${job.message}` : ""}`);
    }
    await sleep(cfg.pollIntervalMs, signal);
  }
}

export async function runTranscriptionTask(args: {
  readonly prisma: PrismaClient;
  readonly fetchFn?: typeof fetch;
  readonly cfg?: TranscriptionRunnerConfig;
  readonly task: TranscriptionTaskRow;
  readonly signal: AbortSignal;
  readonly onAttemptFailure?: (error: unknown, attempt: number) => void;
}): Promise<void> {
  const { prisma, task, signal } = args;
  const fetchFn = args.fetchFn ?? fetch;
  const cfg = args.cfg ?? loadTranscriptionRunnerConfig();

  const fresh = await prisma.transcriptionTask.findUnique({ where: { id: task.id } });
  if (
    !fresh ||
    (fresh.status !== TRANSCRIPTION_TASK_STATUS.queued && fresh.status !== TRANSCRIPTION_TASK_STATUS.running)
  ) {
    return;
  }
  await updateTask(prisma, task.id, { status: TRANSCRIPTION_TASK_STATUS.running, error: null });

  try {
    assertNotAborted(signal);
    // 已经有 bailianTaskId 说明上次提交成功、只是没等到结果，续跑不该再传一遍音频
    let bailianTaskId = fresh.bailianTaskId;
    if (!bailianTaskId) {
      bailianTaskId = await submitWithRetry({
        prisma,
        cfg,
        fetchFn,
        task,
        fileUrl: await resolveAudioFileUrl({ cfg, fetchFn, task, signal }),
        signal,
      });
    }

    const deadline = Date.now() + cfg.runTimeoutMs;
    const transcriptionUrl = await pollUntilDone({
      prisma,
      cfg,
      fetchFn,
      taskId: bailianTaskId,
      rowId: task.id,
      signal,
      deadline,
    });

    assertNotAborted(signal);
    const result: AsrResult = await downloadTranscriptionResult({
      config: cfg.asr,
      transcriptionUrl,
      fetchFn,
      signal,
    });
    await updateTask(prisma, task.id, {
      status: TRANSCRIPTION_TASK_STATUS.completed,
      transcriptText: result.text,
      segmentsJson: JSON.stringify(result.sentences),
      error: null,
    });
  } catch (error) {
    if (isStoppedError(error) || signal.aborted) {
      await updateTask(prisma, task.id, { status: TRANSCRIPTION_TASK_STATUS.cancelled, error: "任务已取消" });
      return;
    }
    const message = safeErrorMessage(error);
    await updateTask(prisma, task.id, { status: TRANSCRIPTION_TASK_STATUS.failed, error: message });
    args.onAttemptFailure?.(error, 1);
  }
}

export function scheduleTranscriptionTask(
  scheduleTask: ScheduleTask,
  task: (signal: AbortSignal) => Promise<void>,
  requestId: string,
): void {
  const controller = new AbortController();
  activeTranscriptionTasks.set(requestId, controller);
  scheduleTask(async () => {
    try {
      await task(controller.signal);
    } finally {
      if (activeTranscriptionTasks.get(requestId) === controller) {
        activeTranscriptionTasks.delete(requestId);
      }
    }
  });
}

export function cancelTranscriptionTask(requestId: string): boolean {
  const controller = activeTranscriptionTasks.get(requestId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isStaleRunningTask(task: TranscriptionTaskRow, staleTaskMs: number, nowMs = Date.now()): boolean {
  return task.status === TRANSCRIPTION_TASK_STATUS.running && nowMs - task.updatedAt.getTime() >= staleTaskMs;
}

export async function claimStaleTask(
  prisma: PrismaClient,
  task: TranscriptionTaskRow,
): Promise<TranscriptionTaskRow | null> {
  const claimed = await prisma.transcriptionTask.updateMany({
    where: {
      id: task.id,
      status: TRANSCRIPTION_TASK_STATUS.running,
      updatedAt: task.updatedAt,
    },
    data: { error: "任务恢复中，将继续等待转写结果" },
  });
  if (claimed.count !== 1) return null;
  return (await prisma.transcriptionTask.findUnique({ where: { id: task.id } })) as TranscriptionTaskRow | null;
}

export async function resumeStaleTasks(args: {
  readonly prisma: PrismaClient;
  readonly fetchFn?: typeof fetch;
  readonly cfg?: TranscriptionRunnerConfig;
  readonly tasks: readonly TranscriptionTaskRow[];
  readonly scheduleTask: ScheduleTask;
  readonly staleTaskMs: number;
  readonly onResume: (task: TranscriptionTaskRow) => void;
  readonly onAttemptFailure: (task: TranscriptionTaskRow, error: unknown, attempt: number) => void;
}): Promise<number> {
  const staleTasks = args.tasks.filter(
    (task) => !activeTranscriptionTasks.has(task.requestId) && isStaleRunningTask(task, args.staleTaskMs),
  );
  const resumed = await Promise.all(
    staleTasks.map(async (task) => {
      const claimed = await claimStaleTask(args.prisma, task);
      if (!claimed) return 0;
      args.onResume(claimed);
      scheduleTranscriptionTask(
        args.scheduleTask,
        async (signal) => {
          await runTranscriptionTask({
            prisma: args.prisma,
            fetchFn: args.fetchFn,
            cfg: args.cfg,
            task: claimed,
            signal,
            onAttemptFailure: (error, attempt) => args.onAttemptFailure(claimed, error, attempt),
          });
        },
        claimed.requestId,
      );
      return 1;
    }),
  );
  return resumed.reduce<number>((sum, value) => sum + value, 0);
}
