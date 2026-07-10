import type { PrismaClient, KbQuotaPackage } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { KbQuotaBilling } from "./service.js";
import { effectiveQuota, usedBytes } from "./service.js";

export class PackageNotFoundError extends Error {
  constructor(message: string = "配额包不存在或已停用") {
    super(message);
    this.name = "PackageNotFoundError";
  }
}

/**
 * 我的配额：有效/已用/各来源明细 + 可购买的启用配额包
 */
export async function myQuota(
  prisma: PrismaClient,
  billing: KbQuotaBilling,
  userId: string
): Promise<{
  effective: number;
  used: number;
  breakdown: { defaultBytes: number; membershipBytes: number; grantBytes: number };
  packages: Array<{ id: string; name: string; bytes: number; durationDays: number; pricePoints: number }>;
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

  // Get enabled packages
  const packages = await prisma.kbQuotaPackage.findMany({
    where: { enabled: true },
    select: {
      id: true,
      name: true,
      bytes: true,
      durationDays: true,
      pricePoints: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    effective,
    used,
    breakdown: {
      defaultBytes,
      membershipBytes,
      grantBytes,
    },
    packages,
  };
}

/**
 * 购买配额包：固定点数扣减 + 建授予（金钱）
 *
 * 流程（顺序固定，金钱安全）：
 * 1. 查 KbQuotaPackage by id 且 enabled=true；不存在/停用 → 抛 PackageNotFoundError
 * 2. 生成 opId：kb:quota:{userId}:{packageId}:{cuid}
 * 3. chargePoints({ operationId: opId, userId, points: pkg.pricePoints, kind: "kb_quota" })
 *    - InsufficientBalanceError 向上抛（路由层转 402）
 *    - chargePoints 余额不足是原子的——不会扣款
 * 4. 扣款成功后建授予
 * 5. 返回 effective + grantId
 */
export async function buyQuota(
  prisma: PrismaClient,
  billing: { chargePoints: (args: { operationId: string; userId: string; points: number; kind: string }) => Promise<any>; getUserKbQuota: (userId: string) => Promise<{ membershipBytes: number; defaultBytes: number }> },
  userId: string,
  packageId: string
): Promise<{ effective: number; grantId: string }> {
  // Step 1: Fetch package
  const pkg = await prisma.kbQuotaPackage.findUnique({
    where: { id: packageId },
  });

  if (!pkg || !pkg.enabled) {
    throw new PackageNotFoundError("配额包不存在或已停用");
  }

  // Step 2: Generate operation ID (unique for each purchase)
  const opId = `kb:quota:${userId}:${packageId}:${randomUUID()}`;

  // Step 3: Charge points (atomic - either succeeds or throws)
  try {
    await billing.chargePoints({
      operationId: opId,
      userId,
      points: pkg.pricePoints,
      kind: "kb_quota",
    });
  } catch (err) {
    // InsufficientBalanceError and other errors are re-thrown
    throw err;
  }

  // Step 4: Create grant (after successful charge)
  let grant;
  try {
    grant = await prisma.kbQuotaGrant.create({
      data: {
        userId,
        bytes: pkg.bytes,
        source: "PURCHASE",
        expiresAt:
          pkg.durationDays > 0
            ? new Date(Date.now() + pkg.durationDays * 86400000)
            : null,
        opId,
        note: pkg.name,
      },
    });
  } catch (err) {
    // If grant creation fails, log error with opId for manual reconciliation
    const logger = console;
    logger.error(`[KB Quota] Grant creation failed for opId=${opId}, userId=${userId}. Manual reconciliation needed.`, err);
    throw err;
  }

  // Step 5: Return effective quota + grant ID
  const effective = await effectiveQuota(prisma, billing, userId);

  return {
    effective,
    grantId: grant.id,
  };
}
