import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { loadS3Config, makeS3 } from "../../storage/s3.js";
import type { S3 } from "../../storage/s3-types.js";
import { putObject } from "../../storage/s3-objects.js";
import {
  loadTranscriptionRunnerConfig,
  resumeStaleTasks,
  runTranscriptionTask,
  scheduleTranscriptionTask,
  type ScheduleTask,
  type TranscriptionRunnerConfig,
} from "./transcription-task-runner.js";
import { loadTranscriptionStaleTaskMs, type TranscriptionTaskRow } from "./transcription-shared.js";
import { loadTranscriptionMaxBytes, safeErrorMessage } from "./transcription-route-helpers.js";

export interface TranscriptionRouteDeps {
  readonly prisma?: PrismaClient;
  readonly fetchFn?: typeof fetch;
  readonly scheduleTask?: ScheduleTask;
  readonly runnerConfig?: TranscriptionRunnerConfig;
  readonly maxBytes?: number;
  readonly redis?: unknown;
}

export interface TranscriptionRouteContext {
  readonly app: FastifyInstance;
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  readonly s3: S3;
  /** 懒加载：BAILIAN_API_KEY 未配时路由仍可注册，任务启动时才报错（信息明确）。 */
  readonly loadRunnerConfig: () => TranscriptionRunnerConfig;
  readonly maxBytes: number;
  readonly staleTaskMs: number;
  readonly storeAudio: (objectKey: string, body: Buffer, contentType: string) => Promise<void>;
  readonly startTask: (task: TranscriptionTaskRow) => void;
  readonly resumeStale: (tasks: readonly TranscriptionTaskRow[]) => Promise<number>;
}

export function createTranscriptionRouteContext(
  app: FastifyInstance,
  deps: TranscriptionRouteDeps,
): TranscriptionRouteContext {
  const prisma = deps.prisma ?? getPrisma();
  const fetchFn = deps.fetchFn ?? fetch;
  // S3 懒加载：测试/CI 环境可能没配 S3_ENDPOINT，路由注册时不能炸；
  // 第一次真正上传/删除音频时才初始化，配错了报错信息也更贴近实际操作。
  let cachedS3: S3 | undefined;
  const getS3 = (): S3 => {
    if (!cachedS3) cachedS3 = makeS3(loadS3Config());
    return cachedS3;
  };
  const maxBytes = deps.maxBytes ?? loadTranscriptionMaxBytes();
  const staleTaskMs = loadTranscriptionStaleTaskMs();
  const scheduleTask: ScheduleTask = deps.scheduleTask
    ?? ((work) => void work().catch((error) => app.log.error(error)));

  const startTask = (task: TranscriptionTaskRow) => {
    scheduleTranscriptionTask(scheduleTask, async (signal) => {
      await runTranscriptionTask({
        prisma,
        fetchFn,
        cfg: deps.runnerConfig,
        task,
        signal,
        onAttemptFailure: (error) => app.log.warn(
          { requestId: task.requestId, error: safeErrorMessage(error) },
          "transcription task attempt failed",
        ),
      });
    }, task.requestId);
  };

  return {
    app,
    prisma,
    fetchFn,
    get s3(): S3 {
      return getS3();
    },
    loadRunnerConfig: () => deps.runnerConfig ?? loadTranscriptionRunnerConfig(),
    maxBytes,
    staleTaskMs,
    storeAudio: (objectKey, body, contentType) => putObject(getS3(), objectKey, body, contentType),
    startTask,
    resumeStale: (tasks) => resumeStaleTasks({
      prisma,
      fetchFn,
      cfg: deps.runnerConfig,
      tasks,
      scheduleTask,
      staleTaskMs,
      onResume: (task) => app.log.warn({ requestId: task.requestId }, "resuming stale transcription task"),
      onAttemptFailure: (task, error) => app.log.warn(
        { requestId: task.requestId, error: safeErrorMessage(error) },
        "resumed transcription task attempt failed",
      ),
    }),
  };
}
