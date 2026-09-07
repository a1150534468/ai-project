import { randomUUID } from "node:crypto";

export interface SessionLockRedis {
  set(key: string, value: string, expiryMode: "PX", ttlMs: number, condition: "NX"): Promise<unknown>;
  eval(script: string, keyCount: number, key: string, ...args: Array<string | number>): Promise<unknown>;
}

export type ReleaseSessionLock = () => Promise<void>;

const LOCK_KEY_PREFIX = "ai-assistant:lock:session:";

const EXTEND_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const DELETE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function renewalDelay(ttlMs: number): number {
  return Math.max(1, Math.floor(ttlMs / 3));
}

export async function acquireSessionLock(
  redis: SessionLockRedis,
  sessionId: string,
  ttlMs = 120_000,
): Promise<ReleaseSessionLock | null> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("session lock TTL must be a positive integer");
  }

  const key = `${LOCK_KEY_PREFIX}${sessionId}`;
  const token = randomUUID();
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return null;

  let released = false;
  let renewal: Promise<void> | null = null;
  let releaseTask: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (released || renewal) return;
    renewal = redis
      .eval(EXTEND_IF_OWNER, 1, key, token, ttlMs)
      .then((result) => {
        if (Number(result) !== 1) clearInterval(timer);
      })
      .catch(() => {
        // A transient Redis failure may recover before the current lease expires.
      })
      .finally(() => {
        renewal = null;
      });
  }, renewalDelay(ttlMs));
  timer.unref?.();

  return () => {
    if (releaseTask) return releaseTask;
    released = true;
    clearInterval(timer);
    releaseTask = (async () => {
      await renewal;
      await redis.eval(DELETE_IF_OWNER, 1, key, token);
    })();
    return releaseTask;
  };
}
