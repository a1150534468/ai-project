import { describe, it, expect } from "vitest";
import { computeRollup, addDays, type RollupInput } from "./rollup-core.js";

it("addDays 跨月正确", () => {
  expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
  expect(addDays("2026-06-01", 3)).toBe("2026-06-04");
});

function baseInput(over: Partial<RollupInput> = {}): RollupInput {
  return {
    metricDates: [],
    cohortDates: [],
    registrations: [],
    activity: [],
    dailyAgg: {},
    revenueByUser: {},
    ...over,
  };
}

describe("computeRollup MetricsDaily", () => {
  it("DAU/WAU/MAU 去重 + payingTotal 累加", () => {
    const r = computeRollup(baseInput({
      metricDates: ["2026-06-03"],
      registrations: [{ userId: "u1", date: "2026-06-01" }, { userId: "u2", date: "2026-06-03" }],
      activity: [
        { userId: "u1", date: "2026-06-01" },
        { userId: "u1", date: "2026-06-03" }, // 同人多天
        { userId: "u2", date: "2026-06-03" },
      ],
      dailyAgg: {
        "2026-06-01": { revenueFen: 100, topupCount: 1, grantedPoints: 10, consumedPoints: 0, payingUsers: 1, newPayingUsers: 1 },
        "2026-06-03": { revenueFen: 200, topupCount: 1, grantedPoints: 20, consumedPoints: 5, payingUsers: 1, newPayingUsers: 1 },
      },
    }));
    const m = r.metricsDaily.find((x) => x.date === "2026-06-03")!;
    expect(m.dau).toBe(2);              // u1,u2 当日
    expect(m.wau).toBe(2);             // 近7日 u1,u2
    expect(m.mau).toBe(2);
    expect(m.registered).toBe(1);      // 6-3 注册 1 人(u2)
    expect(m.revenueFen).toBe(200);
    expect(m.consumedPoints).toBe(5);
    expect(m.newPayingUsers).toBe(1);
    expect(m.payingTotal).toBe(2);     // 6-1 的 1 + 6-3 的 1 累加
  });
});

describe("computeRollup CohortDaily", () => {
  it("留存/LTV/付费人数 按 offset 累计", () => {
    const r = computeRollup(baseInput({
      cohortDates: ["2026-06-01"],
      registrations: [{ userId: "u1", date: "2026-06-01" }, { userId: "u2", date: "2026-06-01" }],
      activity: [
        { userId: "u1", date: "2026-06-01" }, // day0 活跃
        { userId: "u2", date: "2026-06-01" },
        { userId: "u1", date: "2026-06-04" }, // day3 活跃(仅 u1)
      ],
      revenueByUser: {
        u1: [{ paidAtDate: "2026-06-01", amountFen: 287 }], // day0 付费
        u2: [{ paidAtDate: "2026-06-05", amountFen: 100 }], // day4 付费
      },
    }));
    const c = (off: number) => r.cohortDaily.find((x) => x.cohortDate === "2026-06-01" && x.dayOffset === off)!;
    expect(c(0).cohortSize).toBe(2);
    expect(c(0).retained).toBe(2);          // day0 两人都活跃
    expect(c(3).retained).toBe(1);          // day3 仅 u1
    expect(c(0).cumRevenueFen).toBe(287);   // 截至 day0 仅 u1 付 287
    expect(c(3).cumRevenueFen).toBe(287);   // day3 仍只 u1
    expect(c(4).cumRevenueFen).toBe(387);   // day4 u2 付 100 累加
    expect(c(0).cumPayers).toBe(1);
    expect(c(4).cumPayers).toBe(2);
    // 共 31 个 offset
    expect(r.cohortDaily.filter((x) => x.cohortDate === "2026-06-01").length).toBe(31);
  });

  it("空队列不报错、值为 0", () => {
    const r = computeRollup(baseInput({ cohortDates: ["2026-06-09"] }));
    expect(r.cohortDaily.find((x) => x.dayOffset === 0)!.cohortSize).toBe(0);
    expect(r.cohortDaily.find((x) => x.dayOffset === 0)!.retained).toBe(0);
  });
});
