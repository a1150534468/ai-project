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
import { publicObjectUrl } from "../../storage/public-url.js";
import { loadS3Config } from "../../storage/s3.js";
import {
  downloadTranscriptionResult,
  isRetryableAsrError,
  loadAsrConfig,
  pollTranscriptionStatus,
  submitTranscription,
  type AsrConfig,
  type AsrResult,
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

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw?.trim() ? Number(raw.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadTranscriptionRunnerConfig(env: NodeJS.ProcessEnv = process.env): TranscriptionRunnerConfig {
  return {
    asr: loadAsrConfig(env),
    pollIntervalMs: positiveInt(env.TRANSCRIPTION_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    runTimeoutMs: positiveInt(env.TRANSCRIPTION_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS),
    maxSubmitAttempts: positiveInt(env.TRANSCRIPTION_MAX_ATTEMPTS, DEFAULT_MAX_SUBMIT_ATTEMPTS),
    submitRetryDelayMs: positiveInt(env.TRANSCRIPTION_SUBMIT_RETRY_DELAY_MS, DEFAULT_SUBMIT_RETRY_DELAY_MS),
  };
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

/** 取消登记表：requestId → AbortController。绝不在别处另建一份。 */
export const activeTranscriptionTasks = new Map<string, AbortController>();

export type ScheduleTask = (work: () => Promise<void>) => void;

async function updateTask(
  prisma: PrismaClient,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
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
        await updateTask(prisma, task.id, { error: `提交转写任务失败（第 ${attempt} 次），${cfg.submitRetryDelayMs}ms 后重试` });
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
    if (job.status === "FAILED" || job.status === "CANCELED") {
      throw new Error(`百炼转写任务${job.status === "FAILED" ? "失败" : "被取消"}${job.message ? `：${job.message}` : ""}`);
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
  if (!fresh || (fresh.status !== TRANSCRIPTION_TASK_STATUS.queued && fresh.status !== TRANSCRIPTION_TASK_STATUS.running)) {
    return;
  }
  await updateTask(prisma, task.id, { status: TRANSCRIPTION_TASK_STATUS.running, error: null });

  try {
    assertNotAborted(signal);
    const s3Config = loadS3Config();
    const fileUrl = publicObjectUrl(s3Config, task.audioObjectKey);

    const bailianTaskId = fresh.bailianTaskId
      ?? await submitWithRetry({ prisma, cfg, fetchFn, task, fileUrl, signal });

    const deadline = Date.now() + cfg.runTimeoutMs;
    const transcriptionUrl = await pollUntilDone({
      prisma, cfg, fetchFn, taskId: bailianTaskId, rowId: task.id, signal, deadline,
    });

    assertNotAborted(signal);
    const result: AsrResult = await downloadTranscriptionResult({
      config: cfg.asr, transcriptionUrl, fetchFn, signal,
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
  const resumed = await Promise.all(staleTasks.map(async (task) => {
    const claimed = await claimStaleTask(args.prisma, task);
    if (!claimed) return 0;
    args.onResume(claimed);
    scheduleTranscriptionTask(args.scheduleTask, async (signal) => {
      await runTranscriptionTask({
        prisma: args.prisma,
        fetchFn: args.fetchFn,
        cfg: args.cfg,
        task: claimed,
        signal,
        onAttemptFailure: (error, attempt) => args.onAttemptFailure(claimed, error, attempt),
      });
    }, claimed.requestId);
    return 1;
  }));
  return resumed.reduce<number>((sum, value) => sum + value, 0);
}
