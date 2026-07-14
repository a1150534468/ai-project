import type { Redis } from "ioredis";

export type ReleaseFn = () => Promise<void>;

export async function acquireSessionLock(
  redis: Redis,
  sessionId: string,
  ttlMs = 120_000,
): Promise<ReleaseFn | null> {
  const key = `ai-assistant:lock:session:${sessionId}`;
  const token = `${Date.now()}-${Math.floor(performance.now())}`;
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  if (ok !== "OK") return null;
  return async () => {
    // 仅释放自己持有的锁
    const cur = await redis.get(key);
    if (cur === token) await redis.del(key);
  };
}
