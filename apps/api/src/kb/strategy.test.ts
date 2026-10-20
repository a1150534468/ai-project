import { describe, expect, it } from "vitest";
import { failureText } from "./reaper.js";
import {
  KB_DEFAULT_LEASE_MS,
  KB_DEFAULT_MAX_ATTEMPTS,
  kbBatchSize,
  kbEmbedConcurrency,
  kbFailureText,
  kbLeaseMs,
  kbMaxAttempts,
  kbReaperIntervalMs,
} from "./strategy.js";

/**
 * reaper（收尸）与 indexer（续跑）对「多久算卡单、最多试几次」的看法必须一致——
 * 不一致时**不报错**，只是偶发重复索引或永久 failed。这两个模块现在都从本文件取值，
 * 下面这组断言把这条耦合从「注释里的约定」变成可测契约。
 */
describe("kb 的租约 / 重试策略（reaper 与 indexer 共用）", () => {
  it("默认值逐字保留：300_000 / 3", () => {
    expect(KB_DEFAULT_LEASE_MS).toBe(300_000);
    expect(KB_DEFAULT_MAX_ATTEMPTS).toBe(3);
  });

  it("同一个 env 值对两者同时生效（不再是各读一遍）", () => {
    const env = { KB_INDEX_LEASE_MS: "1234", KB_MAX_ATTEMPTS: "7" } as NodeJS.ProcessEnv;

    expect(kbLeaseMs({}, env)).toBe(1234);
    expect(kbMaxAttempts({}, env)).toBe(7);
    // reaper 与 indexer 调用的是同一对函数，取到的必然是同一个值
    expect(kbLeaseMs({}, env)).toBe(kbLeaseMs({ leaseMs: undefined }, env));
    expect(kbMaxAttempts({}, env)).toBe(kbMaxAttempts({ maxAttempts: undefined }, env));
  });

  it("options 覆盖优先于 env", () => {
    const env = { KB_INDEX_LEASE_MS: "1234", KB_MAX_ATTEMPTS: "7" } as NodeJS.ProcessEnv;

    expect(kbLeaseMs({ leaseMs: 999 }, env)).toBe(999);
    expect(kbMaxAttempts({ maxAttempts: 2 }, env)).toBe(2);
  });

  it("非法 env 退默认值，不会让租约变成 0（那是永远卡单）", () => {
    for (const bad of ["", "  ", "abc", "0", "-1", "1.5"]) {
      expect(kbLeaseMs({}, { KB_INDEX_LEASE_MS: bad } as NodeJS.ProcessEnv)).toBe(KB_DEFAULT_LEASE_MS);
      expect(kbMaxAttempts({}, { KB_MAX_ATTEMPTS: bad } as NodeJS.ProcessEnv)).toBe(KB_DEFAULT_MAX_ATTEMPTS);
    }
  });

  it("reaper 自己的两个参数也走同一份解析", () => {
    const env = { KB_REAPER_INTERVAL_MS: "4321" } as NodeJS.ProcessEnv;
    expect(kbReaperIntervalMs({}, env)).toBe(4321);
    expect(kbReaperIntervalMs({}, {})).toBe(30_000);
    expect(kbBatchSize({})).toBe(20);
    expect(kbEmbedConcurrency({} as NodeJS.ProcessEnv)).toBe(4);
  });

  it("两个模块的 error 文案是同一份（fallback 一致）", () => {
    expect(failureText(new Error())).toBe(kbFailureText(new Error()));
    expect(failureText("裸字符串")).toBe("Unknown error");
    expect(kbFailureText(new Error("真实原因"))).toBe("真实原因");
  });
});
