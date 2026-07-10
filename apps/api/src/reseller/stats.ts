import type { UserAggRow } from "@yc/billing";

type Agg = Record<string, UserAggRow>;
const ZERO: UserAggRow = { totalRechargeFen: 0, totalRechargeOrders: 0, totalConsumptionPoints: 0 };

export function computeChannelSummary(userIds: string[], agg: Agg, rate: number) {
  let totalRechargeFen = 0;
  for (const id of userIds) totalRechargeFen += agg[id]?.totalRechargeFen ?? 0;
  return {
    totalUsers: userIds.length,
    totalRechargeFen,
    commissionFen: Math.round(totalRechargeFen * rate),
  };
}

export interface VisibilityConfig {
  showRecharge: boolean;
  showConsumption: boolean;
  showMembership: boolean;
  showLastActive: boolean;
}

export interface UserRecord {
  id: string;
  uid: string;
  username: string;
  createdAt: Date;
  lastActiveAt: Date | null;
  membership: string | null;
}

export function buildUserRows(users: UserRecord[], agg: Agg, vis: VisibilityConfig) {
  return users.map((u) => {
    const a = agg[u.id] ?? ZERO;
    const row: Record<string, unknown> = { uid: u.uid, username: u.username, createdAt: u.createdAt };
    if (vis.showRecharge) {
      row.totalRechargeFen = a.totalRechargeFen;
      row.totalRechargeOrders = a.totalRechargeOrders;
    }
    if (vis.showConsumption) row.totalConsumptionPoints = a.totalConsumptionPoints;
    if (vis.showMembership) row.membership = u.membership;
    if (vis.showLastActive) row.lastActiveAt = u.lastActiveAt;
    return row;
  });
}
