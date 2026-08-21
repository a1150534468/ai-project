import { describe, expect, it, vi } from "vitest";
import { reapStaleVideoTasks, startVideoReaper, VIDEO_REAPER_LOCK_KEY, type VideoReapHandlers } from "./video-reaper.js";
import { DEFAULT_VIDEO_STALE_TASK_MS, loadVideoStaleTaskMs, type VideoTaskRow } from "./video-shared.js";

// findMany 的入参类型要显式声明，否则 vi.fn(async () => rows) 的 mock.calls[0] 被推成
// 空元组 []，取 [0] 会报 TS2493（portrait/image 的 reaper 测试踩过同一个坑）。
interface FindManyArgs {
  readonly where: {
    readonly status: string;
    readonly updatedAt: { readonly lt: Date };
  };
  readonly orderBy?: unknown;
  readonly take?: number;
}

const NOW = new Date("2026-08-05T12:00:00.000Z").getTime();

function makeRow(overrides: Partial<VideoTaskRow> = {}): VideoTaskRow {
  return {
    id: "task-1",
    userId: "u1",
    requestId: "req-1",
    providerTaskId: "prov-1",
    prompt: "一只猫",
    model: "seedance-2",
    aspectRatio: "16:9",
    resolution: "720p",
    durationSec: 5,
    generateAudio: true,
    hasInputVideo: false,
    resourceKey: "video_seedance_2_720p",
    chargedPoints: 120,
    status: "running",
    progress: 30,
    error: null,
    resultPayload: null,
    completedAt: null,
    createdAt: new Date(NOW - 3_600_000),
    updatedAt: new Date(NOW - 1_800_000),
    ...overrides,
  };
}

function makePrisma(rows: VideoTaskRow[]) {
  const findMany = vi.fn(async (_args: FindManyArgs) => rows);
  return { prisma: { videoGenerationTask: { findMany } } as never, findMany };
}

function makeHandlers(overrides: Partial<VideoReapHandlers> = {}) {
  const resume = vi.fn(async (_row: VideoTaskRow) => undefined);
  const fail = vi.fn(async (_row: VideoTaskRow, _reason: string) => undefined);
  const probe = vi.fn(async (_row: VideoTaskRow) => ({ kind: "found", upstreamFailed: false }) as Awaited<ReturnType<VideoReapHandlers["probe"]>>);
  const handlers = { resume, fail, probe, ...overrides } as VideoReapHandlers;
  return { handlers, resume, fail, probe };
}

describe("video reaper", () => {
  it("阈值默认值盖得住提交阶段的最坏心跳空窗", () => {
    // 建行 → 提交成功是最长的一段空窗：
    // VIDEO_SUBMIT_TIMEOUT_MS(60s) × (1 + VIDEO_SUBMIT_RETRIES(2)) + 2 × RETRY_DELAY(2s) = 184s。
    // 这条是防「有人照抄别的域把阈值调小」的回归用例。
    const worstSubmitMs = 60_000 * 3 + 2 * 2_000;
    expect(DEFAULT_VIDEO_STALE_TASK_MS).toBeGreaterThan(worstSubmitMs);
    // 也必须盖住「最后一次轮询 → 标记完成」中间的下载（硬编码 120s 超时）+ 上传。
    expect(DEFAULT_VIDEO_STALE_TASK_MS).toBeGreaterThan(120_000);
  });

  it("阈值按文档的推导取值：最坏提交空窗的两倍以上", () => {
    // 注释里写的是「取 184s 的两倍再取整到 10 分钟」，这里把那个推导钉住。
    // （10 分钟恰好等于 maxPollAttempts × pollIntervalMs 的 600s 是巧合，不是依据 ——
    // 轮询每轮都刷 updatedAt，总窗口不是心跳间隔。）
    expect(DEFAULT_VIDEO_STALE_TASK_MS).toBeGreaterThanOrEqual(2 * (60_000 * 3 + 2 * 2_000));
  });

  it("VIDEO_STALE_TASK_MS 可覆盖，非法值回落默认", () => {
    expect(loadVideoStaleTaskMs({ VIDEO_STALE_TASK_MS: "120000" })).toBe(120_000);
    expect(loadVideoStaleTaskMs({ VIDEO_STALE_TASK_MS: "0" })).toBe(DEFAULT_VIDEO_STALE_TASK_MS);
    expect(loadVideoStaleTaskMs({ VIDEO_STALE_TASK_MS: "-1" })).toBe(DEFAULT_VIDEO_STALE_TASK_MS);
    expect(loadVideoStaleTaskMs({ VIDEO_STALE_TASK_MS: "abc" })).toBe(DEFAULT_VIDEO_STALE_TASK_MS);
    expect(loadVideoStaleTaskMs({})).toBe(DEFAULT_VIDEO_STALE_TASK_MS);
  });

  it("只扫 running 且心跳超期的行，跨用户，吃 [status, updatedAt] 索引", async () => {
    const { prisma, findMany } = makePrisma([]);
    const { handlers } = makeHandlers();
    await reapStaleVideoTasks({ prisma, handlers, staleMs: 600_000, now: () => NOW });
    const where = findMany.mock.calls[0]![0].where;
    expect(where.status).toBe("running");
    expect(where.updatedAt.lt.getTime()).toBe(NOW - 600_000);
    // 没有 userId 过滤：兜底必须跨用户，否则等于没兜底。
    expect(Object.keys(where)).toEqual(["status", "updatedAt"]);
  });

  it("批量有上限：每行都要打一次上游，别一轮打爆限流", async () => {
    const { prisma, findMany } = makePrisma([]);
    const { handlers } = makeHandlers();
    await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(findMany.mock.calls[0]![0].take).toBe(50);
    await reapStaleVideoTasks({ prisma, handlers, take: 7, now: () => NOW });
    expect(findMany.mock.calls[1]![0].take).toBe(7);
  });

  it("一行都没有就直接返回，不碰 handlers", async () => {
    const { prisma } = makePrisma([]);
    const { handlers, resume, fail, probe } = makeHandlers();
    const result = await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(result).toEqual({ scanned: 0, resumed: 0, failed: 0, leftAlone: 0 });
    expect(probe).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  // —— 四个必须覆盖的分支 ——

  it("上游仍在跑 → 恢复轮询，不退款", async () => {
    const row = makeRow();
    const { prisma } = makePrisma([row]);
    const { handlers, resume, fail } = makeHandlers({
      probe: vi.fn(async () => ({ kind: "found", upstreamFailed: false })) as VideoReapHandlers["probe"],
    });
    const result = await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0].id).toBe("task-1");
    expect(fail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, resumed: 1, failed: 0 });
  });

  it("上游已完成 → 同样交给续跑（它会把入库与结算补完），不退款", async () => {
    // 上游 completed 但本地没入库，是「下载/上传期间被杀」留下的。
    // 这时要的不是退款，是把视频补进库 —— 所以走的仍是 resume。
    const row = makeRow();
    const { prisma } = makePrisma([row]);
    const { handlers, resume, fail } = makeHandlers({
      probe: vi.fn(async () => ({ kind: "found", upstreamFailed: false })) as VideoReapHandlers["probe"],
    });
    await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });

  it("上游查不到（404/410）→ 置 failed 并退款", async () => {
    const row = makeRow();
    const { prisma } = makePrisma([row]);
    const { handlers, resume, fail } = makeHandlers({
      probe: vi.fn(async () => ({ kind: "missing" })) as VideoReapHandlers["probe"],
    });
    const result = await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]![1]).toContain("上游已无此任务");
    expect(resume).not.toHaveBeenCalled();
    expect(result).toMatchObject({ resumed: 0, failed: 1 });
  });

  it("没有 providerTaskId（提交前就崩）→ 直接失败退款，不问上游", async () => {
    const row = makeRow({ providerTaskId: null });
    const { prisma } = makePrisma([row]);
    const { handlers, resume, fail, probe } = makeHandlers();
    const result = await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]![1]).toContain("无 providerTaskId");
    // 没有 id 可问，探测一次都不该发。
    expect(probe).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1 });
  });

  it("上游说这活失败了 → 置 failed 并退款", async () => {
    const row = makeRow();
    const { prisma } = makePrisma([row]);
    const { handlers, resume, fail } = makeHandlers({
      probe: vi.fn(async () => ({ kind: "found", upstreamFailed: true })) as VideoReapHandlers["probe"],
    });
    await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]![1]).toContain("上游任务失败");
    expect(resume).not.toHaveBeenCalled();
  });

  // —— 计划没要求、但对应「不可错退一笔」的两条 ——

  it("上游暂时答不了（5xx/超时/网络）→ 一行都不动，等下一轮", async () => {
    // 这是本文件存在的首要理由：把上游抖动当成「任务没了」去退款，
    // 会把仍在正常跑的长任务误杀 —— 用户拿到了货还被退了钱。
    const row = makeRow();
    const { prisma } = makePrisma([row]);
    const { handlers, resume, fail } = makeHandlers({
      probe: vi.fn(async () => ({ kind: "unknown", reason: "video status 503" })) as VideoReapHandlers["probe"],
    });
    const result = await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(fail).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, resumed: 0, failed: 0, leftAlone: 1 });
  });

  it("一行处置抛异常不带走整批，且那一行不被退款", async () => {
    const rows = [makeRow({ id: "a", requestId: "ra" }), makeRow({ id: "b", requestId: "rb" })];
    const { prisma } = makePrisma(rows);
    const probe = vi.fn(async (row: VideoTaskRow) => {
      if (row.id === "a") throw new Error("boom");
      return { kind: "found", upstreamFailed: false } as const;
    });
    const { handlers, resume, fail } = makeHandlers({ probe: probe as VideoReapHandlers["probe"] });
    const result = await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    // 第二行照样救回来了。
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0].id).toBe("b");
    // 抛异常的那行不退款（原因不明就别动钱），留给下一轮。
    expect(fail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 2, resumed: 1, failed: 0, leftAlone: 1 });
  });

  it("onOutcome 报出每行的处置，便于线上观察", async () => {
    const rows = [makeRow({ id: "a", requestId: "ra" }), makeRow({ id: "b", requestId: "rb", providerTaskId: null })];
    const { prisma } = makePrisma(rows);
    const onOutcome = vi.fn();
    const { handlers } = makeHandlers({ onOutcome });
    await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(onOutcome.mock.calls.map((call) => [call[0].id, call[1]])).toEqual([["a", "resumed"], ["b", "failed"]]);
  });

  it("混合一批：各分支计数分别正确", async () => {
    const rows = [
      makeRow({ id: "r1", requestId: "r1", providerTaskId: "p1" }),
      makeRow({ id: "r2", requestId: "r2", providerTaskId: null }),
      makeRow({ id: "r3", requestId: "r3", providerTaskId: "p3" }),
      makeRow({ id: "r4", requestId: "r4", providerTaskId: "p4" }),
    ];
    const { prisma } = makePrisma(rows);
    const probe = vi.fn(async (row: VideoTaskRow) => {
      if (row.id === "r3") return { kind: "missing" } as const;
      if (row.id === "r4") return { kind: "unknown", reason: "timeout" } as const;
      return { kind: "found", upstreamFailed: false } as const;
    });
    const { handlers, resume, fail } = makeHandlers({ probe: probe as VideoReapHandlers["probe"] });
    const result = await reapStaleVideoTasks({ prisma, handlers, now: () => NOW });
    expect(result).toEqual({ scanned: 4, resumed: 1, failed: 2, leftAlone: 1 });
    expect(resume.mock.calls.map((c) => c[0].id)).toEqual(["r1"]);
    expect(fail.mock.calls.map((c) => c[0].id)).toEqual(["r2", "r3"]);
  });
});

describe("startVideoReaper", () => {
  function makeRedis(setResult: "OK" | null) {
    return { set: vi.fn(async () => setResult) } as never;
  }

  it("抢到锁才扫，参数与其他 reaper 一致（NX + EX 55）", async () => {
    vi.useFakeTimers();
    try {
      const { prisma, findMany } = makePrisma([]);
      const redis = makeRedis("OK");
      const { handlers } = makeHandlers();
      const timer = startVideoReaper({ prisma, redis, handlers });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalledWith(
        VIDEO_REAPER_LOCK_KEY, "1", "EX", 55, "NX",
      );
      expect(findMany).toHaveBeenCalledTimes(1);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("抢不到锁就整轮跳过，多实例不会重复处置同一批", async () => {
    vi.useFakeTimers();
    try {
      const { prisma, findMany } = makePrisma([]);
      const { handlers } = makeHandlers();
      const timer = startVideoReaper({ prisma, redis: makeRedis(null), handlers });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(findMany).not.toHaveBeenCalled();
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("不立即跑第一轮：同时重启的实例会在启动瞬间抢同一把锁", async () => {
    vi.useFakeTimers();
    try {
      const { prisma, findMany } = makePrisma([]);
      const { handlers } = makeHandlers();
      const timer = startVideoReaper({ prisma, redis: makeRedis("OK"), handlers });
      await vi.advanceTimersByTimeAsync(0);
      expect(findMany).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(findMany).toHaveBeenCalledTimes(1);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("扫的时候抛了走 onError，定时器继续活着", async () => {
    vi.useFakeTimers();
    try {
      const findMany = vi.fn(async (_args: FindManyArgs) => { throw new Error("db down"); });
      const prisma = { videoGenerationTask: { findMany } } as never;
      const onError = vi.fn();
      const { handlers } = makeHandlers();
      const timer = startVideoReaper({ prisma, redis: makeRedis("OK"), handlers, onError });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onError).toHaveBeenCalledTimes(2);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("timer.unref 已调用，不吊住进程退出", () => {
    vi.useFakeTimers();
    try {
      const { prisma } = makePrisma([]);
      const { handlers } = makeHandlers();
      const timer = startVideoReaper({ prisma, redis: makeRedis("OK"), handlers });
      expect(typeof timer.unref).toBe("function");
      expect(timer.hasRef()).toBe(false);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});
