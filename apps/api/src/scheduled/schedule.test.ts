import { describe, it, expect } from "vitest";
import { validateCron, computeNextRun, presetToCron, checkMinInterval } from "./schedule.js";

describe("schedule 纯函数", () => {
  it("validateCron 接受合法、拒绝非法", () => {
    expect(validateCron("0 8 * * *")).toBe(true);
    expect(validateCron("not a cron")).toBe(false);
  });

  it("computeNextRun 按时区算出未来时间", () => {
    const from = new Date("2026-07-09T00:00:00Z");
    const next = computeNextRun("0 8 * * *", "Asia/Shanghai", from);
    expect(next).not.toBeNull();
    // 北京时间每天 08:00 = UTC 00:00；from 恰为 UTC 00:00，下一次应是次日 UTC 00:00
    expect(next!.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });

  it("presetToCron 生成对应表达式", () => {
    expect(presetToCron({ kind: "daily", hour: 8, minute: 0 })).toBe("0 8 * * *");
    expect(presetToCron({ kind: "hourly", minute: 30 })).toBe("30 * * * *");
    expect(presetToCron({ kind: "weekly", weekday: 1, hour: 9, minute: 0 })).toBe("0 9 * * 1");
    expect(presetToCron({ kind: "monthly", day: 1, hour: 0, minute: 0 })).toBe("0 0 1 * *");
  });

  it("checkMinInterval 拒绝过密的 cron", () => {
    expect(checkMinInterval("* * * * *", "UTC", 300_000)).toBe(false); // 每分钟
    expect(checkMinInterval("0 8 * * *", "UTC", 300_000)).toBe(true);  // 每天
  });
});
