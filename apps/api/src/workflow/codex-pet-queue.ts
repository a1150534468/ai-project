import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";

export const CODEX_PET_QUEUE_NAME = "codex-pet-runs";

export interface CodexPetQueuePayload {
  readonly runId: string;
}

let producerQueue: Queue<CodexPetQueuePayload> | null = null;

function requiredRedisUrl(env: NodeJS.ProcessEnv): string {
  const value = env.REDIS_URL?.trim();
  if (!value) throw new Error("REDIS_URL is required");
  return value;
}

export function codexPetBullConnection(env: NodeJS.ProcessEnv = process.env) {
  const parsed = new URL(requiredRedisUrl(env));
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
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

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Completed jobs are removed immediately. A run intentionally completes its
 * first worker pass while awaiting base review and must be enqueueable again
 * with the same runId after the user confirms a candidate. Failed Bull jobs
 * are removed as well: new per-image runs never retry provider calls, while
 * legacy runs retain their historical behavior. An infrastructure failure
 * that leaves a run active remains recoverable by the stale-run scanner.
 */
export function codexPetDefaultJobOptions(_env: NodeJS.ProcessEnv = process.env): JobsOptions {
  return {
    // Do not add a second retry layer around executeCodexPetRun. Per-image
    // runs fail or await one-time approval after the first provider attempt;
    // historical runs retain their persisted legacy behavior.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

function getProducerQueue(): Queue<CodexPetQueuePayload> {
  producerQueue ??= new Queue<CodexPetQueuePayload>(CODEX_PET_QUEUE_NAME, {
    connection: codexPetBullConnection(),
  });
  return producerQueue;
}

export async function enqueueCodexPetRun(
  payload: CodexPetQueuePayload,
  options: JobsOptions = {},
): Promise<void> {
  if (!payload.runId.trim()) throw new Error("runId is required");
  const queue = getProducerQueue();
  // Compatibility with failed jobs retained by deployments that predate
  // removeOnFail=true. A retained terminal Bull record would otherwise make
  // Queue.add(jobId=runId) a no-op and permanently block stale-run recovery.
  const existing = await queue.getJob(payload.runId);
  if (existing && (await existing.getState()) === "failed") await existing.remove();
  await queue.add("run", payload, {
    ...codexPetDefaultJobOptions(),
    ...options,
    // These invariants are intentionally not caller-overridable.
    jobId: payload.runId,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export function createCodexPetWorker(
  processor: Processor<CodexPetQueuePayload>,
  options: { readonly concurrency?: number; readonly env?: NodeJS.ProcessEnv } = {},
): Worker<CodexPetQueuePayload> {
  const env = options.env ?? process.env;
  return new Worker<CodexPetQueuePayload>(CODEX_PET_QUEUE_NAME, processor, {
    connection: codexPetBullConnection(env),
    concurrency: options.concurrency ?? positiveInteger(env, "CODEX_PET_WORKER_CONCURRENCY", 2),
  });
}

export async function closeCodexPetQueue(): Promise<void> {
  await producerQueue?.close();
  producerQueue = null;
}
