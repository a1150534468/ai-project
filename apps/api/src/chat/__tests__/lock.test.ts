import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireSessionLock, type SessionLockRedis } from "../lock.js";

interface RedisDouble extends SessionLockRedis {
  set: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
}

function redisDouble(acquired: boolean): RedisDouble {
  return {
    set: vi.fn().mockResolvedValue(acquired ? "OK" : null),
    eval: vi.fn().mockResolvedValue(1),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session lock", () => {
  it("uses a leased NX key and returns null when another request owns it", async () => {
    const redis = redisDouble(false);

    await expect(acquireSessionLock(redis, "session-1", 9_000)).resolves.toBeNull();
    expect(redis.set).toHaveBeenCalledWith(
      "ai-assistant:lock:session:session-1",
      expect.any(String),
      "PX",
      9_000,
      "NX",
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("renews only while the caller still owns the lock", async () => {
    vi.useFakeTimers();
    const redis = redisDouble(true);
    const release = await acquireSessionLock(redis, "session-2", 900);

    await vi.advanceTimersByTimeAsync(300);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("pexpire"),
      1,
      "ai-assistant:lock:session:session-2",
      expect.any(String),
      900,
    );

    redis.eval.mockResolvedValueOnce(0);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(900);
    expect(redis.eval).toHaveBeenCalledTimes(2);

    await release?.();
  });

  it("releases atomically with the same ownership token and only once", async () => {
    vi.useFakeTimers();
    const redis = redisDouble(true);
    const release = await acquireSessionLock(redis, "session-3", 900);
    const token = redis.set.mock.calls[0]?.[1];

    await release?.();
    await release?.();

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del"'),
      1,
      "ai-assistant:lock:session:session-3",
      token,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight renewal before deleting the lease", async () => {
    vi.useFakeTimers();
    let finishRenewal: ((value: number) => void) | undefined;
    const redis = redisDouble(true);
    redis.eval.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finishRenewal = resolve;
        }),
    );
    const release = await acquireSessionLock(redis, "session-4", 300);

    await vi.advanceTimersByTimeAsync(100);
    const releasing = release?.();
    const duplicateRelease = release?.();
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(duplicateRelease).toBe(releasing);

    finishRenewal?.(1);
    await Promise.all([releasing, duplicateRelease]);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[1]?.[0]).toContain('redis.call("del"');
  });

  it("rejects invalid lease durations before touching Redis", async () => {
    const redis = redisDouble(true);

    await expect(acquireSessionLock(redis, "session-5", 0)).rejects.toThrow(RangeError);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
