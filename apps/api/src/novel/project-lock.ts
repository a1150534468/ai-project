import { randomUUID } from "node:crypto";
import { getRedis } from "@ai-assistant/db";
import type { Redis } from "ioredis";

const LOCK_TTL_MS = 5 * 60_000;
const ACQUIRE_TIMEOUT_MS = 90_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withNovelProjectLock<T>(args: {
  readonly projectId: string;
  readonly work: () => Promise<T>;
  readonly redis?: Redis;
  readonly acquireTimeoutMs?: number;
}): Promise<T> {
  const redis = args.redis ?? getRedis();
  const key = `novel:project-lock:${args.projectId}`;
  const token = randomUUID();
  const deadline = Date.now() + (args.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  while (await redis.set(key, token, "PX", LOCK_TTL_MS, "NX") !== "OK") {
    if (Date.now() >= deadline) throw new Error("同一作品的前序任务仍在执行，请稍后重试");
    await wait(250);
  }
  const renew = setInterval(() => {
    void redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      key,
      token,
      String(LOCK_TTL_MS),
    ).catch(() => undefined);
  }, 30_000);
  try {
    return await args.work();
  } finally {
    clearInterval(renew);
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    ).catch(() => undefined);
  }
}
