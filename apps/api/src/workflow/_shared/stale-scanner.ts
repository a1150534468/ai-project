import type { Redis } from "ioredis";

/**
 * 卡单回收的定时扫描骨架（seam）。此前 5 个业务域各写一份 tick：
 * redis 分布式锁 `SET key 1 EX 55 NX` 抄了 4 遍，`timer.unref()`、
 * 「不在启动时立即跑第一轮」、「扫描失败不影响定时器」这些不变量
 * 靠各文件的注释维持。现在收进这一处，各域只提供自己的 scan
 * （findStale + handle 的语义差异是业务决策，留在各域，不在这里统一）。
 *
 * `lockKey: null` 表示该域不需要分布式锁 —— 例如 sticker 的状态机转换
 * 幂等（updateMany 带 status 守卫），多实例同跑也不会重复标记。
 * 不要为了统一强行给它加锁。
 */
export interface StaleScannerOptions {
  readonly lockKey: string | null;
  /** lockKey 非 null 时必填 */
  readonly redis?: Redis;
  readonly intervalMs: number;
  readonly scan: () => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
}

/** 锁 TTL：比 60s 的常规扫描间隔短一截，持锁进程死了锁能自己过期。 */
const LOCK_TTL_SECONDS = 55;

export interface StaleScanner {
  /** 启动定时扫描。不立即跑第一轮：多实例同时重启会互相抢锁打断，等第一个 interval 更稳。 */
  start(): NodeJS.Timeout;
  /** 跑一轮（测试与手动触发用）：拿不到锁就跳过；scan 抛错走 onError，不往外抛。 */
  tick(): Promise<void>;
}

export function createStaleScanner(options: StaleScannerOptions): StaleScanner {
  const tick = async (): Promise<void> => {
    if (options.lockKey !== null) {
      if (!options.redis) throw new Error("stale scanner: lockKey 非 null 时必须提供 redis");
      const got = await options.redis
        .set(options.lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX")
        .catch(() => null);
      if (got !== "OK") return;
    }
    try {
      await options.scan();
    } catch (error) {
      // 扫描失败不影响定时器：这一轮放弃，下一轮重试
      options.onError?.(error);
    }
  };
  return {
    tick,
    start() {
      const timer = setInterval(() => void tick(), options.intervalMs);
      timer.unref();
      return timer;
    },
  };
}
