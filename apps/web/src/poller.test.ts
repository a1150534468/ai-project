import { describe, expect, it, vi } from "vitest";
import { createPoller, type PollerClock } from "./poller";

/** 手动推进的假时钟：setTimeout 队列按到期时间触发，回调里再排的定时器同轮可达 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: PollerClock = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.fn();
      // 让已触发的 refresh（微任务）跑完，否则同轮排的下一轮定时器看不到
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
  };
  return { clock, advance };
}

/** 冲干净微任务链（refresh 完成 → 续排下一轮要走几层 continuation） */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("createPoller", () => {
  it("推时钟 N×interval，refresh 恰好调用 N 次（慢请求不重叠）", async () => {
    const { clock, advance } = fakeClock();
    let calls = 0;
    let release: (() => void) | null = null;
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      shouldPoll: () => true,
      refresh: () => {
        calls += 1;
        // 每轮都要 2.5 个 interval 才回来：setInterval 会叠出 3 轮并发，这里必须串行
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    poller.start();
    await advance(1000);
    expect(calls).toBe(1);
    // refresh 还没回来，再推 5 个 interval 也不开新轮
    await advance(5000);
    expect(calls).toBe(1);
    release!();
    await flush();
    await advance(1000);
    expect(calls).toBe(2);
    release!();
    await flush();
    await advance(3000);
    expect(calls).toBe(3);
    poller.stop();
  });

  it("无活跃任务时不轮询；notify 后状态变活跃才开始", async () => {
    const { clock, advance } = fakeClock();
    let active = false;
    const refresh = vi.fn(async () => undefined);
    const poller = createPoller({ clock, intervalMs: 1000, shouldPoll: () => active, refresh });
    poller.start();
    await advance(5000);
    expect(refresh).not.toHaveBeenCalled();
    active = true;
    poller.notify();
    await advance(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    active = false;
    poller.notify();
    await advance(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("全部落地（shouldPoll 转 false）后停止空转", async () => {
    const { clock, advance } = fakeClock();
    let remaining = 2;
    const refresh = vi.fn(async () => {
      remaining -= 1;
    });
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      shouldPoll: () => remaining > 0,
      refresh,
    });
    poller.start();
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("推进到 ttl 后即使没有活跃任务也触发一次刷新，之后按 ttl 周期续", async () => {
    const { clock, advance } = fakeClock();
    const refresh = vi.fn(async () => undefined);
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      ttlMs: 10_000,
      shouldPoll: () => false,
      refresh,
    });
    poller.start();
    await advance(9_999);
    expect(refresh).not.toHaveBeenCalled();
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("refreshNow 与轮询共用重叠保护，且刷新会推迟 ttl 唤醒", async () => {
    const { clock, advance } = fakeClock();
    let calls = 0;
    let release: (() => void) | null = null;
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      ttlMs: 5000,
      shouldPoll: () => false,
      refresh: () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    poller.start();
    // 先推进 2000ms 再手动刷新：旧 ttl 截止 = start+5000，新截止 = 刷新完成+5000 = 7000。
    // 两者必须拉开距离，否则「推迟了 ttl」这个断言在同为 5000 时恒真、测不出回归。
    await advance(2000);
    expect(calls).toBe(0);
    const first = poller.refreshNow();
    const second = poller.refreshNow();
    expect(calls).toBe(1);
    release!();
    await Promise.all([first, second]);
    await advance(3000); // t=5000：旧截止到达 —— 若没推迟，这里会误触发
    expect(calls).toBe(1);
    await advance(1999); // t=6999
    expect(calls).toBe(1);
    await advance(1); // t=7000：新截止
    expect(calls).toBe(2);
    release!();
    await flush();
    poller.stop();
  });

  it("refresh 同步抛错不弄死单飞：之后仍能真正刷新", async () => {
    const { clock, advance } = fakeClock();
    const onError = vi.fn();
    let calls = 0;
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      shouldPoll: () => true,
      onError,
      refresh: () => {
        calls += 1;
        if (calls === 1) throw new Error("sync boom"); // 同步抛错，不是 rejected promise
        return Promise.resolve();
      },
    });
    poller.start();
    await advance(1000);
    expect(calls).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    // 若单飞状态被已完成的 promise 卡死，后面每个周期都只会复用它、calls 不再涨
    await advance(1000);
    expect(calls).toBe(2);
    await advance(1000);
    expect(calls).toBe(3);
    poller.stop();
  });

  it("overlapGuard 关闭 + ttlMs：刷新悬挂越过 ttl 时不 0ms 空转连发", async () => {
    const { clock, advance } = fakeClock();
    let calls = 0;
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      ttlMs: 300,
      overlapGuard: false,
      shouldPoll: () => false,
      refresh: () => {
        calls += 1;
        return new Promise<void>(() => {}); // 永远不完成
      },
    });
    poller.start();
    await advance(300); // ttl 触发第一轮
    expect(calls).toBe(1);
    await advance(300); // 又过一个 ttl 周期：在飞未落地，最多按 interval 节奏，不能连环引爆
    expect(calls).toBe(1);
    await advance(700); // t=1300 = 上轮启动 + intervalMs
    expect(calls).toBe(2);
    poller.stop();
  });

  it("overlapGuard 关闭 + ttlMs：快速完成的刷新按完成时刻续 ttl，不退化成 intervalMs", async () => {
    const { clock, advance } = fakeClock();
    let calls = 0;
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      ttlMs: 300,
      overlapGuard: false,
      shouldPoll: () => false,
      refresh: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    poller.start();
    await advance(300); // t=300 第一轮，立即完成 → 下一轮应排在完成+300=600，而非启动+1000=1300
    expect(calls).toBe(1);
    await advance(300); // t=600
    expect(calls).toBe(2);
    await advance(300); // t=900，节奏稳定在 ttl 上
    expect(calls).toBe(3);
    poller.stop();
  });

  it("refresh 抛错走 onError 且不弄死调度器", async () => {
    const { clock, advance } = fakeClock();
    const onError = vi.fn();
    let calls = 0;
    const poller = createPoller({
      clock,
      intervalMs: 1000,
      shouldPoll: () => true,
      onError,
      refresh: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
    });
    poller.start();
    await advance(3000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    poller.stop();
  });

  it("stop 后不再触发", async () => {
    const { clock, advance } = fakeClock();
    const refresh = vi.fn(async () => undefined);
    const poller = createPoller({ clock, intervalMs: 1000, shouldPoll: () => true, refresh });
    poller.start();
    poller.stop();
    await advance(5000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
