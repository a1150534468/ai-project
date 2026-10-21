/**
 * 纯逻辑轮询调度器（ADR-007：不依赖 React，Studio / 薄 hook 只是消费者）。
 *
 * 内化三条此前靠各 Studio 手写维持的不变量：
 * 1. **重叠保护**：上一轮 refresh 没回来不开下一轮（递归 setTimeout 而非
 *    setInterval）。慢请求下 setInterval 会叠出并发请求互相作废——知识库页
 *    和 StickerStudio 都为此吃过亏/专门绕过。
 * 2. **全部落地后停止空转**：`shouldPoll()` 为 false 就不再排程，等外部状态
 *    变化时用 `notify()` 重新评估。
 * 3. **签名 URL 有 TTL**：图片签名链接会过期（如形象照/试穿的交付 URL）。
 *    只靠「有活跃任务才轮询」的话，任务全落地后页面挂着不动，图会在 TTL
 *    到点时悄悄裂掉。给 poller 传 `ttlMs` 后，即使 `shouldPoll()` 为 false，
 *    距上次刷新超过 ttl 也会补一轮——ttl 这个数字和它的理由从此待在
 *    同一个 interface 上，而不是散落在各 Studio 的第二个 setInterval 里。
 */

export interface PollerClock {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

export interface PollerOptions {
  /** 常规轮询间隔（毫秒）：有活跃任务时每隔这么久刷一轮 */
  readonly intervalMs: number;
  /** 是否还有活跃任务。false 时不排程（除 TTL 唤醒外），不空转 */
  readonly shouldPoll: () => boolean;
  /** 一轮刷新。抛错走 onError，不会弄死调度器 */
  readonly refresh: () => Promise<void>;
  /**
   * 重叠保护，默认开启。关掉时退化为 setInterval 语义（上一轮没回来也开
   * 下一轮）——只有明确知道 refresh 幂等且便宜的场景才关。
   */
  readonly overlapGuard?: boolean;
  /**
   * 资源 TTL（毫秒）：距上次刷新完成超过这个时长，即使没有活跃任务也补刷
   * 一轮。给带签名 URL 的页面用（URL_REFRESH_MS = 10 分钟就是这个语义）。
   */
  readonly ttlMs?: number;
  readonly onError?: (error: unknown) => void;
  /** 测试注入假时钟用；默认用 window 定时器 */
  readonly clock?: PollerClock;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** 外部状态变了（shouldPoll 的输入变了）：重新评估排程 */
  notify(): void;
  /**
   * 手动触发一轮，走同一个重叠保护：已有一轮在飞时返回那一轮的 promise，
   * 不再叠加请求。手动刷新也算一轮（刷新 TTL 计时）。
   */
  refreshNow(): Promise<void>;
}

const systemClock: PollerClock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  now: () => Date.now(),
};

export function createPoller(options: PollerOptions): Poller {
  const clock = options.clock ?? systemClock;
  const overlapGuard = options.overlapGuard ?? true;
  let started = false;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let lastRefreshDoneAt = clock.now();

  const clearTimer = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    clearTimer();
    if (!started) return;
    let delay: number | null = null;
    if (options.shouldPoll()) delay = options.intervalMs;
    if (options.ttlMs !== undefined) {
      const ttlIn = Math.max(0, lastRefreshDoneAt + options.ttlMs - clock.now());
      // ttl 已到期但还有刷新在飞：它完成时会更新 lastRefreshDoneAt（有保护模式下
      // 还会重新 schedule）。这里若按 0ms 排程，无保护模式会以 0 间隔连环启动
      // 重叠请求 —— 降为常规间隔，等在飞的那轮落地后再回到 ttl 节奏。
      const effectiveTtlIn = ttlIn === 0 && inFlight !== null ? options.intervalMs : ttlIn;
      delay = delay === null ? effectiveTtlIn : Math.min(delay, effectiveTtlIn);
    }
    if (delay === null) return;
    timer = clock.setTimeout(() => {
      timer = null;
      void runCycle();
    }, delay);
  };

  const runRefresh = (): Promise<void> => {
    if (inFlight !== null && overlapGuard) return inFlight;
    // refresh 同步抛错时 IIFE 会在赋值前就跑完（catch/finally 都是同步的），
    // finally 里没东西可清；赋值时必须识别这种情况，否则已结束的 promise
    // 被存进 inFlight，单飞模式下后续刷新会永远复用它、实际请求永久停止。
    let finished = false;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await options.refresh();
      } catch (error) {
        options.onError?.(error);
      } finally {
        lastRefreshDoneAt = clock.now();
        finished = true;
        if (inFlight === promise) inFlight = null;
      }
    })();
    if (!finished) inFlight = promise;
    return promise;
  };

  const runCycle = async (): Promise<void> => {
    if (!started) return;
    if (!overlapGuard) {
      // 无重叠保护时先启动本轮再排下一轮（setInterval 语义）：schedule 要能看到
      // 本轮的 inFlight，否则 ttl 已过期时它会按 0ms 排出一串空转周期。
      const running = runRefresh();
      schedule();
      await running;
      return;
    }
    await runRefresh();
    schedule();
  };

  return {
    start() {
      if (started) return;
      started = true;
      lastRefreshDoneAt = clock.now();
      schedule();
    },
    stop() {
      started = false;
      clearTimer();
    },
    notify() {
      schedule();
    },
    async refreshNow() {
      await runRefresh();
      schedule();
    },
  };
}
