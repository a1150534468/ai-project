import { describe, it, expect } from "vitest";
import { computeChannelSummary, buildUserRows } from "./stats.js";

const agg = {
  u1: { totalRechargeFen: 1000, totalRechargeOrders: 2, totalConsumptionPoints: 300 },
  u2: { totalRechargeFen: 500, totalRechargeOrders: 1, totalConsumptionPoints: 0 },
};

describe("computeChannelSummary", () => {
  it("分成 = Σ充值分 × 比例，人数=userIds 长度", () => {
    const s = computeChannelSummary(["u1", "u2", "u3"], agg, 0.1);
    expect(s.totalUsers).toBe(3);
    expect(s.totalRechargeFen).toBe(1500);
    expect(s.commissionFen).toBe(150); // (1000+500)*0.1
  });
  it("比例带小数四舍五入到整分", () => {
    const s = computeChannelSummary(["u1"], agg, 0.15); // 1000*0.15=150
    expect(s.commissionFen).toBe(150);
    const s2 = computeChannelSummary(["u2"], agg, 0.333); // 500*0.333=166.5 → 167
    expect(s2.commissionFen).toBe(167);
  });
});

describe("buildUserRows", () => {
  const users = [
    { id: "u1", uid: "TT-00000001", username: "a", createdAt: new Date(0), lastActiveAt: null, membership: null },
  ];
  it("全开时含充值/消费/会员/活跃列", () => {
    const rows = buildUserRows(users, agg, {
      showRecharge: true, showConsumption: true, showMembership: true, showLastActive: true,
    });
    expect(rows[0].uid).toBe("TT-00000001");
    expect(rows[0].totalRechargeFen).toBe(1000);
    expect(rows[0].totalConsumptionPoints).toBe(300);
    expect(rows[0]).toHaveProperty("membership");
    expect(rows[0]).toHaveProperty("lastActiveAt");
  });
  it("关闭 showConsumption 后无消费列", () => {
    const rows = buildUserRows(users, agg, {
      showRecharge: true, showConsumption: false, showMembership: false, showLastActive: false,
    });
    expect(rows[0].totalRechargeFen).toBe(1000);
    expect(rows[0]).not.toHaveProperty("totalConsumptionPoints");
    expect(rows[0]).not.toHaveProperty("membership");
  });
  it("无 agg 的用户各项计 0", () => {
    const rows = buildUserRows(
      [{ id: "uX", uid: "TT-00000009", username: "x", createdAt: new Date(0), lastActiveAt: null, membership: null }],
      agg,
      { showRecharge: true, showConsumption: true, showMembership: false, showLastActive: false },
    );
    expect(rows[0].totalRechargeFen).toBe(0);
    expect(rows[0].totalConsumptionPoints).toBe(0);
  });
});
