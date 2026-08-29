/**
 * video-routes 拆分后的任务流水线:提交带重试、轮询到终态、下载入库、按时长结算、
 * 失败退款。四个对外函数 `finishSubmittedVideoTask` / `refundAndFailVideoTask` /
 * `runVideoTask` 由路由与兜底扫(reaper)共用。
 *
 * `finishSubmittedVideoTask` 之所以独立于 `runVideoTask` 存在:提交成功之后进程可能挂,
 * 兜底扫捞起这条任务时只能从"已提交"这半段接着跑。把它并回 `runVideoTask` 会让兜底扫
 * 重新提交一次上游任务 —— 那就是重复扣费。同理 `refundAndFailVideoTask` 必须是共用的
 * 那一份,主路径与兜底扫的失败语义要一字不差。
 *
 * `isTransientSubmitError` 是重试的唯一判据:只有 abort / 超时 / 网络 / 5xx / 429 才重试。
 * 明确的 4xx 重试也不会成功,只会把同一个错误再撞一遍并拖满超时预算。
 *
 * `submitWithRetry` 把 requestId 作 client_business_id 传上游:上游按此幂等去重则安全,
 * 即便真的重复建了任务,我方计费仍只扣一次、失败退款。
 *
 * 依赖方向:support / contracts / serialize → 本文件。不 import schemas,不 import 路由门面。
 */

import type { PrismaClient } from "@prisma/client";
import {
  getVideoGenerationStatus,
  isAutoDuration,
  loadVideoGenerationConfig,
  storeGeneratedVideo,
  submitVideoGeneration,
  type ExtractedVideoStatus,
} from "../_shared/video-service.js";
import { videoOperationId, type VideoTaskRow } from "./video-shared.js";
import {
  DEFAULT_STATUS_TIMEOUT_MS,
  DEFAULT_SUBMIT_TIMEOUT_MS,
  loadNumber,
  safeErrorMessage,
  videoTaskStatus,
  wait,
} from "./video-route-support.js";
import type { BillingForVideos } from "./video-route-contracts.js";
import { normalizeRequest, statusPayloadJson } from "./video-route-serialize.js";

// 仅瞬态错误可重试：abort/超时/网络/5xx/429；明确 4xx（非 429）客户端错误不重试（重试也不会成功）。
function isTransientSubmitError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const matched = msg.match(/video submit (\d{3})/);
  if (matched) {
    const code = Number(matched[1]);
    if (code >= 400 && code < 500 && code !== 429) return false;
    return code >= 500 || code === 429;
  }
  return /abort|timeout|超时|fetch failed|econnreset|etimedout|socket|network|und_err/.test(msg);
}

// 提交带重试：上游偶发提交超时/抖动时自动重试。requestId 作 client_business_id 传上游，
// 上游按此幂等去重则安全；即便重复建任务，我方计费仍只扣一次、失败退款。
async function submitWithRetry(
  submitArgs: Parameters<typeof submitVideoGeneration>[0],
  retries: number,
  delayMs: number,
  onRetry?: (error: unknown, attempt: number) => void,
): Promise<Awaited<ReturnType<typeof submitVideoGeneration>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await submitVideoGeneration(submitArgs);
    } catch (error) {
      lastErr = error;
      if (attempt === retries || !isTransientSubmitError(error)) throw error;
      onRetry?.(error, attempt + 1);
      await wait(delayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

async function pollVideoUntilDone(args: {
  readonly task: VideoTaskRow;
  readonly cfg: ReturnType<typeof loadVideoGenerationConfig>;
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  readonly initialDelayMs: number;
  readonly intervalMs: number;
  readonly maxAttempts: number;
}): Promise<ExtractedVideoStatus> {
  const providerTaskId = args.task.providerTaskId;
  if (!providerTaskId) throw new Error("missing provider task id");
  if (args.initialDelayMs > 0) await wait(args.initialDelayMs);
  let lastStatus: ExtractedVideoStatus | null = null;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const status = await getVideoGenerationStatus({
      cfg: args.cfg,
      providerTaskId,
      fetchFn: args.fetchFn,
      timeoutMs: loadNumber("VIDEO_STATUS_TIMEOUT_MS", DEFAULT_STATUS_TIMEOUT_MS),
    });
    lastStatus = status;
    // 完成态延后到视频入库后由 runVideoTask 统一写(storeGeneratedVideo→upsert asset→标记 completed)。
    // 此处若把 completed 提前落库，会出现"任务已完成但 videoAsset 尚未入库"的空窗；
    // 一旦后台任务在下载期间被中断(如 pod 滚动重启)，任务将永久停在 completed 却无视频。
    const providerCompleted = status.status === videoTaskStatus.completed;
    await args.prisma.videoGenerationTask.update({
      where: { id: args.task.id },
      data: {
        status: providerCompleted ? videoTaskStatus.running : status.status,
        progress: status.progress,
        error: status.error,
        resultPayload: statusPayloadJson(status),
        completedAt: providerCompleted ? null : status.completedAt,
      },
    });
    if (status.status === videoTaskStatus.completed || status.status === videoTaskStatus.failed) return status;
    if (attempt < args.maxAttempts) await wait(args.intervalMs);
  }
  throw new Error(`video task timeout${lastStatus ? `: ${lastStatus.providerStatus}` : ""}`);
}

/**
 * 提交之后那半段：轮询到终态 → 下载入库 → 自动时长结算 → 标记 completed。
 *
 * 从 `runVideoTask` 里抽出来，是因为兜底扫必须能对**已经拿到 `providerTaskId`**
 * 的行单独跑这半段。直接拿 `runVideoTask` 去续跑会从提交开始，向上游重复提交
 * 一个新任务（还会重复计费）。
 *
 * 不含 try/catch：失败一律往外抛，由调用方决定收尾（主路径与兜底都收敛到
 * `refundAndFailVideoTask`，语义保持一致）。
 *
 * `inputDurationSec` 传 `null` 表示「不知道」。这不是可选参数的省略 ——
 * 见下方结算处的说明，传错比不传更糟。
 */
export async function finishSubmittedVideoTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForVideos;
  readonly fetchFn: typeof fetch;
  readonly task: VideoTaskRow;
  readonly cfg: ReturnType<typeof loadVideoGenerationConfig>;
  readonly pollInitialDelayMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly inputDurationSec: number | null;
  readonly onSettleSkipped?: (task: VideoTaskRow) => void;
}): Promise<void> {
  const operationId = videoOperationId(args.task.requestId);
  const task = args.task;
  const finalStatus = await pollVideoUntilDone({
    task,
    cfg: args.cfg,
    prisma: args.prisma,
    fetchFn: args.fetchFn,
    initialDelayMs: args.pollInitialDelayMs,
    intervalMs: args.pollIntervalMs,
    maxAttempts: args.maxPollAttempts,
  });
  if (finalStatus.status === videoTaskStatus.failed) throw new Error(finalStatus.error ?? "视频生成失败");
  if (!finalStatus.videoUrl) throw new Error("视频生成结果缺少 URL");
  const stored = await storeGeneratedVideo({
    url: finalStatus.videoUrl,
    userId: task.userId,
    requestId: task.requestId,
    requestIndex: 0,
    format: finalStatus.format,
    fetchFn: args.fetchFn,
  });
  // 自动时长：按实际输出秒结算，退回预扣（15s）多扣的差额。best-effort：结算失败不回滚已生成的视频。
  //
  // 有输入视频而又不知道输入秒数时**必须跳过**，不能拿 0 顶上：结算侧
  // `SettleVideoIO` 会用 `QuoteVideoIO(resourceKey, inputSec, outputSec)` 重算实际成本，
  // 对 VIDEO_IO 定价是 `输入秒×输入单价 + 输出秒×输出单价`（billing 的
  // resource.go:88）。inputSec 传 0 会把实际成本算少，于是**多退**给用户一笔。
  // 跳过只是让用户按预扣的 15s 多付一点，方向上安全得多。
  const inputUnitsUnknown = task.hasInputVideo && args.inputDurationSec === null;
  if (isAutoDuration(task.durationSec) && stored.durationSec > 0 && args.billing.settleVideoResource) {
    if (inputUnitsUnknown) args.onSettleSkipped?.(task);
    else {
      await args.billing.settleVideoResource({
        operationId,
        resourceKey: task.resourceKey,
        units: stored.durationSec,
        ...(task.hasInputVideo ? { inputUnits: args.inputDurationSec as number } : {}),
      }).catch(() => undefined);
    }
  }
  const assetDurationSec = stored.durationSec > 0 ? stored.durationSec : task.durationSec;
  await args.prisma.videoAsset.upsert({
    where: { requestId_requestIndex: { requestId: task.requestId, requestIndex: 0 } },
    update: {},
    create: {
      userId: task.userId,
      requestId: task.requestId,
      requestIndex: 0,
      prompt: task.prompt,
      model: task.model,
      aspectRatio: task.aspectRatio,
      resolution: task.resolution,
      durationSec: assetDurationSec,
      originalUrl: stored.originalUrl,
      objectKey: stored.objectKey,
      mime: stored.mime,
      format: stored.format,
    },
  });
  await args.prisma.videoGenerationTask.update({
    where: { id: task.id },
    data: {
      status: videoTaskStatus.completed,
      progress: 100,
      error: null,
      completedAt: finalStatus.completedAt ?? new Date(),
      resultPayload: statusPayloadJson(finalStatus),
    },
  });
}

/** 退款 + 置 failed。主路径与兜底扫共用，保证两边的失败语义一字不差。 */
export async function refundAndFailVideoTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForVideos;
  readonly task: VideoTaskRow;
  readonly error: unknown;
}): Promise<void> {
  await args.billing.refundResource(videoOperationId(args.task.requestId)).catch(() => undefined);
  await args.prisma.videoGenerationTask.update({
    where: { id: args.task.id },
    data: {
      status: videoTaskStatus.failed,
      error: safeErrorMessage(args.error),
    },
  }).catch(() => undefined);
}

export async function runVideoTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForVideos;
  readonly fetchFn: typeof fetch;
  readonly task: VideoTaskRow;
  readonly request: ReturnType<typeof normalizeRequest>;
  readonly pollInitialDelayMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly inputDurationSec: number;
  readonly submitRetries: number;
  readonly submitRetryDelayMs: number;
  readonly onSubmitRetry?: (error: unknown, attempt: number) => void;
}): Promise<void> {
  try {
    const cfg = loadVideoGenerationConfig();
    const submitted = await submitWithRetry({
      cfg,
      request: args.request,
      fetchFn: args.fetchFn,
      timeoutMs: loadNumber("VIDEO_SUBMIT_TIMEOUT_MS", DEFAULT_SUBMIT_TIMEOUT_MS),
    }, args.submitRetries, args.submitRetryDelayMs, args.onSubmitRetry);
    const task = await args.prisma.videoGenerationTask.update({
      where: { id: args.task.id },
      data: {
        providerTaskId: submitted.providerTaskId,
        status: submitted.status,
        progress: submitted.progress,
        error: null,
      },
    });
    await finishSubmittedVideoTask({
      prisma: args.prisma,
      billing: args.billing,
      fetchFn: args.fetchFn,
      task,
      cfg,
      pollInitialDelayMs: args.pollInitialDelayMs,
      pollIntervalMs: args.pollIntervalMs,
      maxPollAttempts: args.maxPollAttempts,
      inputDurationSec: args.inputDurationSec,
    });
  } catch (error) {
    await refundAndFailVideoTask({ prisma: args.prisma, billing: args.billing, task: args.task, error });
    throw error;
  }
}
