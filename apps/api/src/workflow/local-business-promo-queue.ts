import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";

export const LOCAL_BUSINESS_PROMO_QUEUE_NAME = "local-business-promo-runs";

export interface LocalBusinessPromoQueuePayload {
  readonly runId: string;
}

let producerQueue: Queue | null = null;

function redisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.REDIS_URL?.trim();
  if (!url) throw new Error("REDIS_URL is required");
  return url;
}

function createBullConnection(env: NodeJS.ProcessEnv = process.env) {
  const parsed = new URL(redisUrl(env));
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

function createProducerQueue(env: NodeJS.ProcessEnv = process.env): Queue {
  producerQueue ??= new Queue(LOCAL_BUSINESS_PROMO_QUEUE_NAME, {
    connection: createBullConnection(env),
  });
  return producerQueue;
}

function loadNumber(envKey: string, fallback: number): number {
  const value = Number(process.env[envKey]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function defaultJobOptions(): JobsOptions {
  return {
    attempts: Math.max(1, loadNumber("LOCAL_BUSINESS_PROMO_JOB_ATTEMPTS", 2)),
    backoff: {
      type: "fixed",
      delay: Math.max(0, loadNumber("LOCAL_BUSINESS_PROMO_JOB_BACKOFF_MS", 30_000)),
    },
    removeOnComplete: 200,
    removeOnFail: 500,
  };
}

export async function enqueueLocalBusinessPromoRun(
  payload: LocalBusinessPromoQueuePayload,
  options: JobsOptions = {},
): Promise<void> {
  const queue = createProducerQueue();
  await queue.add("render", payload, {
    ...defaultJobOptions(),
    ...options,
    jobId: options.jobId ?? payload.runId,
  });
}

export function createLocalBusinessPromoWorker(
  processor: Processor<LocalBusinessPromoQueuePayload>,
  options: { concurrency?: number } = {},
): Worker<LocalBusinessPromoQueuePayload> {
  return new Worker<LocalBusinessPromoQueuePayload>(
    LOCAL_BUSINESS_PROMO_QUEUE_NAME,
    processor,
    {
      connection: createBullConnection(),
      concurrency: options.concurrency ?? Math.max(1, loadNumber("LOCAL_BUSINESS_PROMO_WORKER_CONCURRENCY", 2)),
    },
  );
}

export async function closeLocalBusinessPromoQueue(): Promise<void> {
  await producerQueue?.close();
  producerQueue = null;
}
