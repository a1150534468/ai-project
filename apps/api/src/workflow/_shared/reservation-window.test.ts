import { describe, expect, it } from "vitest";
import {
  BILLING_MAX_RESERVATION_TTL_SECONDS,
  BILLING_RECON_GLOBAL_TTL_MS,
  reservationMarginMs,
  reservationResumeAllowance,
  reservationTtlSeconds,
  upstreamImageWorstMs,
} from "./reservation-window.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("reservationTtlSeconds", () => {
  it("窗口再短也不低于 billing 全局兜底 + 余量：声明 TTL 只许延长窗口", () => {
    // 声明出一个比不声明还短的 TTL，等于亲手把漏计费的窗口提前——比不声明更糟。
    const floor = Math.ceil((BILLING_RECON_GLOBAL_TTL_MS + reservationMarginMs(EMPTY_ENV)) / 1000);
    expect(reservationTtlSeconds({ perHeartbeatMs: 1_000, heartbeats: 1, resumeAllowance: 0, env: EMPTY_ENV })).toBe(floor);
    expect(reservationTtlSeconds({ perHeartbeatMs: 0, heartbeats: 0, resumeAllowance: 0, env: EMPTY_ENV })).toBe(floor);
  });

  it("心跳数与续跑余量都按整段间隔累加", () => {
    const perHeartbeatMs = 10 * 60_000;
    const marginSeconds = reservationMarginMs(EMPTY_ENV) / 1000;
    expect(reservationTtlSeconds({ perHeartbeatMs, heartbeats: 3, resumeAllowance: 0, env: EMPTY_ENV })).toBe(
      30 * 60 + marginSeconds,
    );
    expect(reservationTtlSeconds({ perHeartbeatMs, heartbeats: 3, resumeAllowance: 4, env: EMPTY_ENV })).toBe(
      70 * 60 + marginSeconds,
    );
  });

  it("与心跳无关的等待直接叠加（小说的 worker 排队就走这条）", () => {
    // perHeartbeatMs 取 20 分钟，先越过 10 分钟的下限，叠加关系才是真的在测叠加。
    const perHeartbeatMs = 20 * 60_000;
    const base = reservationTtlSeconds({ perHeartbeatMs, heartbeats: 1, resumeAllowance: 0, env: EMPTY_ENV });
    expect(
      reservationTtlSeconds({
        perHeartbeatMs,
        heartbeats: 1,
        resumeAllowance: 0,
        extraWindowMs: 3 * 60 * 60_000,
        env: EMPTY_ENV,
      }),
    ).toBe(base + 3 * 60 * 60);
  });

  it("超过 billing 30 天上限时截断，而不是让 reserve 请求直接 400", () => {
    // 400 会把整条链路挡死；兜底晚于业务只是少一次自动退款。
    expect(
      reservationTtlSeconds({ perHeartbeatMs: 60 * 24 * 60 * 60_000, heartbeats: 1, resumeAllowance: 0, env: EMPTY_ENV }),
    ).toBe(BILLING_MAX_RESERVATION_TTL_SECONDS);
  });

  it("负数与 NaN 输入不会把窗口算成负值", () => {
    const floor = reservationTtlSeconds({ perHeartbeatMs: 0, heartbeats: 1, resumeAllowance: 0, env: EMPTY_ENV });
    expect(
      reservationTtlSeconds({ perHeartbeatMs: -1_000, heartbeats: -3, resumeAllowance: -4, extraWindowMs: -1, env: EMPTY_ENV }),
    ).toBe(floor);
  });

  it("余量与续跑余量都能用 env 调，且默认值不为 0", () => {
    expect(reservationMarginMs(EMPTY_ENV)).toBeGreaterThan(0);
    expect(reservationMarginMs({ BILLING_RESERVATION_MARGIN_MS: "60000" })).toBe(60_000);
    for (const value of ["0", "-1", "abc", ""]) {
      expect(reservationMarginMs({ BILLING_RESERVATION_MARGIN_MS: value })).toBe(reservationMarginMs(EMPTY_ENV));
    }
    // 0 是「本域不续跑」的合法取值，不能被当成非法值回退成默认的 4。
    expect(reservationResumeAllowance({ BILLING_RESERVATION_RESUME_ALLOWANCE: "0" })).toBe(0);
    expect(reservationResumeAllowance({ BILLING_RESERVATION_RESUME_ALLOWANCE: "2" })).toBe(2);
    expect(reservationResumeAllowance({ BILLING_RESERVATION_RESUME_ALLOWANCE: "abc" })).toBe(
      reservationResumeAllowance(EMPTY_ENV),
    );
    expect(reservationResumeAllowance(EMPTY_ENV)).toBeGreaterThan(0);
  });
});

describe("upstreamImageWorstMs", () => {
  it("一张图 = （尝试超时 + 闸门等待）× 尝试次数 + 退避，再乘非上游余量", () => {
    expect(
      upstreamImageWorstMs({ attemptTimeoutMs: 600_000, dispatchWaitMs: 120_000, maxAttempts: 2, retryDelayMs: 1_000 }),
    ).toBe(Math.round((720_000 * 2 + 1_000) * 1.5));
  });

  it("闸门等待不能漏：排队期间不写心跳，漏掉就又是一次误判", () => {
    const withGate = upstreamImageWorstMs({ attemptTimeoutMs: 600_000, dispatchWaitMs: 120_000, maxAttempts: 3, retryDelayMs: 0 });
    const withoutGate = upstreamImageWorstMs({ attemptTimeoutMs: 600_000, dispatchWaitMs: 0, maxAttempts: 3, retryDelayMs: 0 });
    expect(withGate - withoutGate).toBe(Math.round(120_000 * 3 * 1.5));
  });

  it("尝试次数 0/负数按 1 次算，退避负数按 0 算", () => {
    const once = upstreamImageWorstMs({ attemptTimeoutMs: 1_000, dispatchWaitMs: 0, maxAttempts: 1, retryDelayMs: 0 });
    expect(upstreamImageWorstMs({ attemptTimeoutMs: 1_000, dispatchWaitMs: 0, maxAttempts: 0, retryDelayMs: -5 })).toBe(once);
    expect(upstreamImageWorstMs({ attemptTimeoutMs: 1_000, dispatchWaitMs: 0, maxAttempts: -2, retryDelayMs: -5 })).toBe(once);
  });
});
