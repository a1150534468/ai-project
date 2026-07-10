import { describe, expect, it } from "vitest";
import { cadenceLabel, periodsInDuration, totalGrantOverDuration } from "./planMath";

describe("planMath", () => {
  it("cadenceLabel 映射中文，未知回落每月", () => {
    expect(cadenceLabel("DAILY")).toBe("每日");
    expect(cadenceLabel("WEEKLY")).toBe("每周");
    expect(cadenceLabel("MONTHLY")).toBe("每月");
    expect(cadenceLabel("XXX")).toBe("每月");
  });
  it("periodsInDuration 按 cadence 折算，至少 1", () => {
    expect(periodsInDuration("DAILY", 30)).toBe(30);
    expect(periodsInDuration("WEEKLY", 30)).toBe(4);
    expect(periodsInDuration("MONTHLY", 30)).toBe(1);
    expect(periodsInDuration("MONTHLY", 90)).toBe(3);
    expect(periodsInDuration("DAILY", 0)).toBe(1);
  });
  it("totalGrantOverDuration 计算总发放并标记除不尽", () => {
    expect(totalGrantOverDuration("DAILY", 30, 6600)).toEqual({ points: 198000, approx: false });
    expect(totalGrantOverDuration("MONTHLY", 30, 99000)).toEqual({ points: 99000, approx: false });
    expect(totalGrantOverDuration("WEEKLY", 30, 100)).toEqual({ points: 400, approx: true });
  });
});
