function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const SCHED = {
  tickMs: intEnv("SCHED_TICK_MS", 30_000),
  dueBatch: intEnv("SCHED_DUE_BATCH", 50),
  maxConcurrent: intEnv("SCHED_MAX_CONCURRENT", 4),
  minIntervalMs: intEnv("SCHED_MIN_INTERVAL_MS", 300_000), // 5 分钟
  maxTasksPerUser: intEnv("SCHED_MAX_TASKS_PER_USER", 20),
  activeTtlSec: intEnv("SCHED_ACTIVE_TTL_SEC", 900),
  slotLockTtlSec: intEnv("SCHED_SLOT_LOCK_TTL_SEC", 120),
  maxOutputTokens: intEnv("SCHED_MAX_OUTPUT_TOKENS", 4096),
  maxIterations: intEnv("SCHED_MAX_ITERATIONS", 64),
  streamTotalTimeoutMs: intEnv("SCHED_STREAM_TOTAL_TIMEOUT_MS", 300_000),
  aiDraftModel: (process.env.SCHED_AI_DRAFT_MODEL ?? "MiniMax-M3"),
  aiDraftMaxOutputTokens: intEnv("SCHED_AI_DRAFT_MAX_OUTPUT_TOKENS", 800),
} as const;

export const SCHED_KEY = {
  slot: (taskId: string, slotIso: string) => `yunclaude:sched:run:${taskId}:${slotIso}`,
  active: (taskId: string) => `yunclaude:sched:active:${taskId}`,
} as const;
