import { randomUUID } from "node:crypto";

export class WorkflowMutationConflictError extends Error {
  readonly name = "WorkflowMutationConflictError";

  constructor(message = "工作流正在处理，请稍后重试") {
    super(message);
  }
}

export function workflowMutationKey(workflowId: string): string {
  return `ecom-workflow:${workflowId}`;
}

export function workflowCreateMutationKey(userId: string): string {
  return `ecom-master-create:${userId}`;
}

export const DEFAULT_ECOM_MUTATION_LOCK_TTL_MS = 600_000;
const LOCK_RENEW_INTERVAL_CAP_MS = 60_000;
const RELEASE_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export type WorkflowMutationRedis = {
  readonly set: (key: string, value: string, mode: "PX", ttlMs: number, option: "NX") => Promise<"OK" | null>;
  readonly eval: (script: string, numKeys: number, key: string, ...args: string[]) => Promise<unknown>;
};

export type WorkflowMutationLocker = {
  readonly withLock: <T>(key: string, run: () => Promise<T>) => Promise<T>;
};

export function createRedisWorkflowMutationLocker(
  redis: WorkflowMutationRedis,
  ttlMs = DEFAULT_ECOM_MUTATION_LOCK_TTL_MS,
): WorkflowMutationLocker {
  return {
    async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
      const lockKey = `ai-assistant:lock:ecom-workflow:${key}`;
      const token = randomUUID();
      const acquired = await redis.set(lockKey, token, "PX", ttlMs, "NX");
      if (acquired !== "OK") throw new WorkflowMutationConflictError();
      const renewIntervalMs = Math.min(LOCK_RENEW_INTERVAL_CAP_MS, Math.max(1_000, Math.floor(ttlMs / 3)));
      const renewTimer = setInterval(() => {
        void redis.eval(RENEW_LOCK_SCRIPT, 1, lockKey, token, String(ttlMs));
      }, renewIntervalMs);
      renewTimer.unref?.();
      try {
        return await run();
      } finally {
        clearInterval(renewTimer);
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
      }
    },
  };
}
