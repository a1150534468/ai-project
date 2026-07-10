import argon2 from "argon2";
import type { PrismaClient } from "@yc/db";

const VIS_ID = "singleton";

export async function createReseller(
  prisma: PrismaClient,
  data: { username: string; password: string; code: string; commissionRate: number },
) {
  const passwordHash = await argon2.hash(data.password);
  return prisma.$transaction(async (tx) => {
    const admin = await tx.admin.create({
      data: { username: data.username, passwordHash, role: "reseller", permissions: [] },
      select: { id: true, username: true, role: true, disabled: true, createdAt: true },
    });
    const channel = await tx.channel.create({
      data: {
        code: data.code,
        ownerType: "RESELLER",
        resellerId: admin.id,
        commissionRate: data.commissionRate,
        enabled: true,
      },
    });
    return { admin, channel };
  });
}

export async function listResellers(prisma: PrismaClient) {
  const channels = await prisma.channel.findMany({
    where: { ownerType: "RESELLER" },
    orderBy: { createdAt: "desc" },
  });
  const adminIds = channels.map((c) => c.resellerId).filter((x): x is string => Boolean(x));
  const admins = await prisma.admin.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, username: true, disabled: true, createdAt: true },
  });
  const byId = new Map(admins.map((a) => [a.id, a]));
  return channels.map((c) => ({
    channelId: c.id,
    code: c.code,
    commissionRate: c.commissionRate,
    enabled: c.enabled,
    resellerId: c.resellerId,
    username: c.resellerId ? byId.get(c.resellerId)?.username ?? null : null,
    disabled: c.resellerId ? byId.get(c.resellerId)?.disabled ?? null : null,
    createdAt: c.createdAt,
  }));
}

export async function updateChannel(
  prisma: PrismaClient,
  channelId: string,
  patch: { commissionRate?: number; enabled?: boolean },
) {
  return prisma.channel.update({ where: { id: channelId }, data: patch });
}

export async function getVisibilityConfig(prisma: PrismaClient) {
  return prisma.resellerVisibilityConfig.upsert({
    where: { id: VIS_ID },
    create: { id: VIS_ID },
    update: {},
  });
}

export async function setVisibilityConfig(
  prisma: PrismaClient,
  patch: { showRecharge?: boolean; showConsumption?: boolean; showMembership?: boolean; showLastActive?: boolean },
) {
  return prisma.resellerVisibilityConfig.upsert({
    where: { id: VIS_ID },
    create: { id: VIS_ID, ...patch },
    update: patch,
  });
}
