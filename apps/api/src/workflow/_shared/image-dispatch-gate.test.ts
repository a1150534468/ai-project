import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_UPSTREAM_CONCURRENCY,
  DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS,
  imageDispatchGateSnapshot,
  imageDispatchWorstWaitMs,
  imageUpstreamPoolKey,
  loadImageUpstreamConcurrency,
  loadImageUpstreamQueueWaitMs,
  resetImageDispatchGates,
  withImageDispatchPermit,
} from "./image-dispatch-gate.js";

const ENDPOINT = "https://relay.example.com/v1/images/generations";
const OTHER = "https://other-relay.example.com/v1/images/generations";
const KEY = "relay.example.com";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 让已就绪的微任务与 0ms 定时器都跑完，避免靠猜微任务层数写断言。 */
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  resetImageDispatchGates();
});

describe("闸门配置", () => {
  it("并发上限：默认 4，0 是显式关闭，配错回落默认而不是关掉闸门", () => {
    expect(loadImageUpstreamConcurrency({})).toBe(DEFAULT_IMAGE_UPSTREAM_CONCURRENCY);
    expect(loadImageUpstreamConcurrency({ IMAGE_UPSTREAM_CONCURRENCY: "1" })).toBe(1);
    expect(loadImageUpstreamConcurrency({ IMAGE_UPSTREAM_CONCURRENCY: "0" })).toBe(0);
    for (const value of ["abc", "-2", "", "  "]) {
      expect(loadImageUpstreamConcurrency({ IMAGE_UPSTREAM_CONCURRENCY: value })).toBe(
        DEFAULT_IMAGE_UPSTREAM_CONCURRENCY,
      );
    }
  });

  it("排队上限：默认 120s，非法值回落默认", () => {
    expect(loadImageUpstreamQueueWaitMs({})).toBe(DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS);
    expect(loadImageUpstreamQueueWaitMs({ IMAGE_UPSTREAM_QUEUE_WAIT_MS: "5000" })).toBe(5_000);
    for (const value of ["0", "-1", "abc"]) {
      expect(loadImageUpstreamQueueWaitMs({ IMAGE_UPSTREAM_QUEUE_WAIT_MS: value })).toBe(
        DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS,
      );
    }
  });

  it("给卡单阈值用的最坏等待：闸门开着等于排队上限，关掉是 0", () => {
    expect(imageDispatchWorstWaitMs({})).toBe(DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS);
    expect(imageDispatchWorstWaitMs({ IMAGE_UPSTREAM_QUEUE_WAIT_MS: "30000" })).toBe(30_000);
    expect(imageDispatchWorstWaitMs({ IMAGE_UPSTREAM_CONCURRENCY: "0" })).toBe(0);
  });

  it("按上游 host 分池：同一个中继的不同路径共用一个池", () => {
    expect(imageUpstreamPoolKey(ENDPOINT)).toBe(KEY);
    expect(imageUpstreamPoolKey("https://Relay.Example.com/v1/images/edits")).toBe(KEY);
    expect(imageUpstreamPoolKey(ENDPOINT)).not.toBe(imageUpstreamPoolKey(OTHER));
    expect(imageUpstreamPoolKey("https://relay.example.com:8443/v1")).toBe("relay.example.com:8443");
    // 假端点（测试里常见）不合法也要能分池，不能全塌成同一个 key。
    expect(imageUpstreamPoolKey("not-a-url")).toBe("not-a-url");
  });
});

describe("withImageDispatchPermit", () => {
  it("同一上游最多放行 concurrency 个，多的排队等归还", async () => {
    const env = { IMAGE_UPSTREAM_CONCURRENCY: "2" };
    const holds = [deferred(), deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const runs = holds.map((hold, index) =>
      withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await hold.promise;
        active -= 1;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);
    expect(imageDispatchGateSnapshot()[KEY]).toMatchObject({ limit: 2, inFlight: 2, waiting: 3 });

    holds[0]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    for (const hold of holds) hold.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(imageDispatchGateSnapshot()[KEY]).toMatchObject({ inFlight: 0, waiting: 0, failedOpen: 0 });
  });

  it("排队先到先得：谁也挤不掉谁", async () => {
    const env = { IMAGE_UPSTREAM_CONCURRENCY: "1" };
    const holds = [deferred(), deferred(), deferred()];
    const order: number[] = [];
    const runs = holds.map((hold, index) =>
      withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
        order.push(index);
        await hold.promise;
      }),
    );

    await tick();
    expect(order).toEqual([0]);
    holds[0]!.resolve();
    await tick();
    expect(order).toEqual([0, 1]);
    holds[1]!.resolve();
    await tick();
    expect(order).toEqual([0, 1, 2]);
    holds[2]!.resolve();
    await Promise.all(runs);
  });

  it("不同上游各自一个池，互不排队", async () => {
    const env = { IMAGE_UPSTREAM_CONCURRENCY: "1" };
    const a = deferred();
    const b = deferred();
    const started: string[] = [];
    const runA = withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
      started.push("a");
      await a.promise;
    });
    const runB = withImageDispatchPermit({ endpoint: OTHER, env }, async () => {
      started.push("b");
      await b.promise;
    });

    await tick();
    expect(started).toEqual(["a", "b"]);
    a.resolve();
    b.resolve();
    await Promise.all([runA, runB]);
  });

  it("work 抛错也归还许可，不会把名额漏光", async () => {
    const env = { IMAGE_UPSTREAM_CONCURRENCY: "1" };
    await expect(
      withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
        throw new Error("upstream 500");
      }),
    ).rejects.toThrow("upstream 500");
    await expect(withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => "ok")).resolves.toBe("ok");
    expect(imageDispatchGateSnapshot()[KEY]).toMatchObject({ inFlight: 0, waiting: 0 });
  });
});

describe("闸门的失效方式", () => {
  it("等不到许可就直接放行：闸门不许让一次已付费的调用失败", async () => {
    const env = { IMAGE_UPSTREAM_CONCURRENCY: "1", IMAGE_UPSTREAM_QUEUE_WAIT_MS: "20" };
    const stuck = deferred();
    const held = withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
      await stuck.promise;
    });
    await tick();

    await expect(withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => "delivered")).resolves.toBe(
      "delivered",
    );
    expect(imageDispatchGateSnapshot()[KEY]).toMatchObject({ inFlight: 1, failedOpen: 1 });

    stuck.resolve();
    await held;
    // fail open 的那次没占名额，归还后计数必须回到干净状态（否则名额会被越算越少）。
    expect(imageDispatchGateSnapshot()[KEY]).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it("调用方取消时抛 AbortError，且不会真的发出这次请求", async () => {
    const env = { IMAGE_UPSTREAM_CONCURRENCY: "1" };
    const stuck = deferred();
    const held = withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
      await stuck.promise;
    });
    await tick();

    const controller = new AbortController();
    let ran = false;
    const queued = withImageDispatchPermit({ endpoint: ENDPOINT, env, signal: controller.signal }, async () => {
      ran = true;
    });
    await tick();
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(ran).toBe(false);
    stuck.resolve();
    await held;
    expect(imageDispatchGateSnapshot()[KEY]).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it("signal 早就取消了就不必进队列", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(
      withImageDispatchPermit({ endpoint: ENDPOINT, env: {}, signal: controller.signal }, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(ran).toBe(false);
  });

  it("IMAGE_UPSTREAM_CONCURRENCY=0 整体关掉闸门：不排队也不建池", async () => {
    const env = { IMAGE_UPSTREAM_CONCURRENCY: "0" };
    const first = deferred();
    const started: string[] = [];
    const a = withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
      started.push("a");
      await first.promise;
    });
    const b = withImageDispatchPermit({ endpoint: ENDPOINT, env }, async () => {
      started.push("b");
    });

    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(imageDispatchGateSnapshot()).toEqual({});
    first.resolve();
    await Promise.all([a, b]);
  });

  it("上限调大立刻放行在排的人，不用等谁归还", async () => {
    const stuck = deferred();
    const held = withImageDispatchPermit({ endpoint: ENDPOINT, env: { IMAGE_UPSTREAM_CONCURRENCY: "1" } }, async () => {
      await stuck.promise;
    });
    await tick();
    let ran = false;
    const queued = withImageDispatchPermit({ endpoint: ENDPOINT, env: { IMAGE_UPSTREAM_CONCURRENCY: "1" } }, async () => {
      ran = true;
    });
    await tick();
    expect(ran).toBe(false);

    await withImageDispatchPermit({ endpoint: ENDPOINT, env: { IMAGE_UPSTREAM_CONCURRENCY: "3" } }, async () => undefined);
    await queued;
    expect(ran).toBe(true);
    stuck.resolve();
    await held;
  });
});
