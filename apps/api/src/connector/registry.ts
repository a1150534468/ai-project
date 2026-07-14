export interface RedisLike {
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

const LOC_TTL_SEC = 120; // 心跳每 <60s 刷新，超时即视为掉线
const PENDING_TTL_BUFFER_SEC = 60;

function key(deviceId: string): string {
  return `ai-assistant:conn:loc:${deviceId}`;
}

function pendingKey(invocationId: string): string {
  return `ai-assistant:conn:pending:${invocationId}`;
}

export function createRegistry(redis: RedisLike) {
  return {
    async setLocation(deviceId: string, instanceId: string): Promise<void> {
      await redis.set(key(deviceId), instanceId, "EX", LOC_TTL_SEC);
    },
    async getLocation(deviceId: string): Promise<string | null> {
      return redis.get(key(deviceId));
    },
    async clearLocation(deviceId: string): Promise<void> {
      await redis.del(key(deviceId));
    },
    async clearLocationIfOwner(deviceId: string, instanceId: string): Promise<boolean> {
      if (await redis.get(key(deviceId)) !== instanceId) return false;
      await redis.del(key(deviceId));
      return true;
    },
    async setPendingOwner(invocationId: string, instanceId: string, timeoutMs: number): Promise<void> {
      const ttlSec = Math.max(1, Math.ceil(timeoutMs / 1000) + PENDING_TTL_BUFFER_SEC);
      await redis.set(pendingKey(invocationId), instanceId, "EX", ttlSec);
    },
    async getPendingOwner(invocationId: string): Promise<string | null> {
      return redis.get(pendingKey(invocationId));
    },
    async clearPendingOwner(invocationId: string): Promise<void> {
      await redis.del(pendingKey(invocationId));
    },
  };
}
