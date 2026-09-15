import type { PrismaClient } from "@prisma/client";
import { loadUserActivity } from "./user-activity.js";
import { loadUserTimeline } from "./user-timeline.js";

export interface AdminUserBasic {
  id: string;
  uid: string;
  username: string;
  bannedAt: Date | null;
  createdAt: Date;
}

export async function buildAdminUserDetail(
  prisma: PrismaClient,
  user: AdminUserBasic,
  now = new Date(),
) {
  const [activity, timeline] = await Promise.all([
    loadUserActivity(prisma, user.id, now),
    loadUserTimeline(prisma, user.id),
  ]);
  return {
    user,
    kpis: { loginCountToday: activity.loginCountToday, todayAgent: activity.todayAgents },
    activity: activity.periods,
    timeline,
  };
}
