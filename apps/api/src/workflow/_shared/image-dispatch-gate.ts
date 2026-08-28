/**
 * 跨域共享的出图派发闸门。
 *
 * 出图并发在每个域里各自定义：图文按 ARTICLE_IMAGE_BATCH_SIZE=2 分批 Promise.all，
 * 生图按 count（最多 8）整批 Promise.allSettled 扇出，人像按 count（最多 4），
 * 桌宠已经把自己的 visual 并发从 3 降到 1（docs/codex-pet.md 6.12.11）。
 * 但四个域打的是**同一个上游中继**：谁扇得宽谁挤掉谁，症状是 429 与连接被掐，
 * 重试再把压力放大一轮。桌宠单方面降并发只护住了自己，别的域照样能把上游打满。
 *
 * 所以把许可收到进程级、按上游 host 分池共享：同一个 host 上同时在飞的出图请求
 * 不超过 IMAGE_UPSTREAM_CONCURRENCY 个，先到先得（FIFO），谁也挤不掉谁。
 *
 * 铁律：闸门**不允许让一次已付费的调用失败**。排到上限还没轮到就直接放行
 * （fail open），只损失削峰效果，不损失用户的钱——这是它唯一可接受的失效方式。
 * 调用方自己的 signal 被取消是另一回事，照 fetchWithSignal 的老规矩抛 AbortError。
 */

/**
 * 默认 4：除「生图单请求要 5~8 张」以外，任何单个请求的最宽扇出都不会被闸门减速
 * （图文 2 / 人像 4 / 桌宠 1），只有跨域撞车才会排队。上游更弱就往下调，0 = 关掉。
 */
export const DEFAULT_IMAGE_UPSTREAM_CONCURRENCY = 4;
/** 排队等待上限。等超了就 fail open，因此它同时是闸门给单次尝试引入的最坏额外耗时。 */
export const DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS = 120_000;

export interface ImageDispatchGateStats {
  readonly limit: number;
  readonly inFlight: number;
  readonly waiting: number;
  readonly failedOpen: number;
}

export function loadImageUpstreamConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IMAGE_UPSTREAM_CONCURRENCY?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IMAGE_UPSTREAM_CONCURRENCY;
  const value = Number(raw);
  // 0 是「关掉闸门」的显式取值；负数与非数字按配错处理，回落默认而不是把闸门关掉。
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IMAGE_UPSTREAM_CONCURRENCY;
  return Math.floor(value);
}

export function loadImageUpstreamQueueWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_UPSTREAM_QUEUE_WAIT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS;
}

/**
 * 闸门给**单次尝试**引入的最坏额外等待，供各域推导卡单阈值——图文/人像/生图的
 * reaper 阈值都是从单次尝试预算推出来的。闸门关掉时是 0，不要凭空加余量。
 *
 * 漏掉这一项的后果这个仓库吃过两次：阈值短于一次心跳间隔，正在跑的行被判卡单收尸。
 */
export function imageDispatchWorstWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return loadImageUpstreamConcurrency(env) > 0 ? loadImageUpstreamQueueWaitMs(env) : 0;
}

/** 同一个中继下的所有模型共用一个池：瓶颈是中继本身，不是模型。 */
export function imageUpstreamPoolKey(endpoint: string): string {
  try {
    const host = new URL(endpoint).host.toLowerCase();
    if (host.length > 0) return host;
  } catch {
    // 不是合法 URL（测试里的假端点）就按原样分池，至少不会把两个上游混成一个。
  }
  return endpoint.trim().toLowerCase();
}

type Release = () => void;
/** fail open 时没有持有许可，归还必须是空操作，否则会把别人的名额减掉。 */
const ALREADY_OPEN: Release = () => undefined;

type WaiterOutcome = "granted" | "fail-open" | "aborted";

interface Waiter {
  settled: boolean;
  readonly settle: (outcome: WaiterOutcome) => void;
}

function dispatchAbortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

class HostDispatchGate {
  private limit: number;
  private inFlight = 0;
  private failedOpen = 0;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  snapshot(): ImageDispatchGateStats {
    return { limit: this.limit, inFlight: this.inFlight, waiting: this.waiters.length, failedOpen: this.failedOpen };
  }

  /** 调大上限要立刻放行已经在排的人，否则 env 改了也要等下一次归还才生效。 */
  setLimit(limit: number): void {
    if (limit === this.limit) return;
    this.limit = limit;
    this.drain();
  }

  async acquire(waitMs: number, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) throw dispatchAbortError();
    if (this.inFlight < this.limit) return this.hold();
    return await new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        settle: (outcome) => {
          if (waiter.settled) return;
          waiter.settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          if (outcome === "granted") {
            resolve(this.hold());
          } else if (outcome === "aborted") {
            reject(dispatchAbortError());
          } else {
            this.failedOpen += 1;
            resolve(ALREADY_OPEN);
          }
        },
      };
      const onAbort = () => waiter.settle("aborted");
      const timer = setTimeout(() => waiter.settle("fail-open"), waitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** 归还幂等：同一个 release 被调两次不会凭空多出一个名额。 */
  private hold(): Release {
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.inFlight < this.limit) {
      const next = this.waiters.shift();
      if (!next) return;
      // settle("granted") 会把 inFlight 加一，循环因此必然收敛。
      next.settle("granted");
    }
  }
}

const gates = new Map<string, HostDispatchGate>();

function gateFor(key: string, limit: number): HostDispatchGate {
  const existing = gates.get(key);
  if (existing) {
    existing.setLimit(limit);
    return existing;
  }
  const created = new HostDispatchGate(limit);
  gates.set(key, created);
  return created;
}

/**
 * 拿到许可再跑 work，跑完（成功或失败）都归还。
 *
 * 必须包在 onRequestDispatching 与单次尝试 deadline **外面**：排队等待既不该吃掉
 * 尝试预算（那样等久了会被判成上游超时并重试，反而加压），也不该让台账先记下
 * 一次还没真正发出去的派发。
 */
export async function withImageDispatchPermit<T>(
  args: { readonly endpoint: string; readonly signal?: AbortSignal; readonly env?: NodeJS.ProcessEnv },
  work: () => Promise<T>,
): Promise<T> {
  const env = args.env ?? process.env;
  const limit = loadImageUpstreamConcurrency(env);
  if (limit <= 0) return await work();
  const release = await gateFor(imageUpstreamPoolKey(args.endpoint), limit)
    .acquire(loadImageUpstreamQueueWaitMs(env), args.signal);
  try {
    return await work();
  } finally {
    release();
  }
}

/** 仅测试用：丢掉所有池。正在排队的等待者会被孤立，直到自己 fail open。 */
export function resetImageDispatchGates(): void {
  gates.clear();
}

/** 观测用：各上游池的当前占用。failedOpen 不为 0 说明闸门已经在被绕过。 */
export function imageDispatchGateSnapshot(): Readonly<Record<string, ImageDispatchGateStats>> {
  return Object.fromEntries([...gates].map(([key, gate]) => [key, gate.snapshot()]));
}
