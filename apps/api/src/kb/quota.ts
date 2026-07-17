import type { PrismaClient } from "@prisma/client";
import type { KbQuotaBilling } from "./service.js";
import { effectiveQuota, usedBytes } from "./service.js";

/**
 * 我的配额：有效/已用/各来源明细。
 */
export async function myQuota(
  prisma: PrismaClient,
  billing: KbQuotaBilling,
  userId: string
): Promise<{
  effective: number;
  used: number;
  breakdown: { defaultBytes: number; membershipBytes: number; grantBytes: number };
}> {
  // Get effective quota and used bytes
  const effective = await effectiveQuota(prisma, billing, userId);
  const used = await usedBytes(prisma, userId);

  // Get breakdown: default + membership from billing, grants from DB
  const { defaultBytes, membershipBytes } = await billing.getUserKbQuota(userId);

  const now = new Date();
  const grantResult = await prisma.kbQuotaGrant.aggregate({
    _sum: { bytes: true },
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  const grantBytes = grantResult._sum.bytes ?? 0;

  return {
    effective,
    used,
    breakdown: {
      defaultBytes,
      membershipBytes,
      grantBytes,
    },
  };
}
