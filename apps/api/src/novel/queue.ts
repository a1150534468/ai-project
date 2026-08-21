import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";

export const NOVEL_QUEUE_NAME = "novel-runs";

export type NovelQueuePayload =
  | { readonly type: "engine-step"; readonly stepId: string }
  | { readonly type: "generation-task"; readonly taskId: string };

let producerQueue: Queue<NovelQueuePayload> | null = null;

function requiredRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.REDIS_URL?.trim();
  if (!url) throw new Error("REDIS_URL is required for the novel worker");
  return url;
}

export function novelBullConnection(env: NodeJS.ProcessEnv = process.env) {
  const parsed = new URL(requiredRedisUrl(env));
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) || 0 : 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

function queue(): Queue<NovelQueuePayload> {
  producerQueue ??= new Queue<NovelQueuePayload>(NOVEL_QUEUE_NAME, { connection: novelBullConnection() });
  return producerQueue;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultJobOptions(env: NodeJS.ProcessEnv = process.env): JobsOptions {
  return {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: positiveInteger(env.QUEUE_COMPLETED_JOB_COUNT, 100),
    removeOnFail: positiveInteger(env.QUEUE_FAILED_JOB_COUNT, 200),
  };
}

export async function enqueueNovelEngineStep(stepId: string, priority = 5): Promise<void> {
  const targetQueue = queue();
  const existing = await targetQueue.getJob(stepId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove();
    } else {
      return;
    }
  }
  await targetQueue.add(
    "execute-step",
    { type: "engine-step", stepId },
    {
      ...defaultJobOptions(),
      jobId: stepId,
      priority,
    },
  );
}

export async function enqueueNovelGenerationTask(taskId: string): Promise<void> {
  const targetQueue = queue();
  const jobId = `generation-${taskId}`;
  const existing = await targetQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") await existing.remove();
    else return;
  }
  await targetQueue.add(
    "generation-task",
    { type: "generation-task", taskId },
    {
      ...defaultJobOptions(),
      jobId,
      priority: 1,
    },
  );
}

export function createNovelWorker(
  processor: Processor<NovelQueuePayload>,
  concurrency?: number,
): Worker<NovelQueuePayload> {
  const configured = positiveInteger(
    process.env.NOVEL_WORKER_CONCURRENCY,
    positiveInteger(process.env.WORKER_CONCURRENCY, 1),
  );
  return new Worker<NovelQueuePayload>(NOVEL_QUEUE_NAME, processor, {
    connection: novelBullConnection(),
    concurrency: concurrency ?? configured,
  });
}

export async function closeNovelQueue(): Promise<void> {
  await producerQueue?.close();
  producerQueue = null;
}
