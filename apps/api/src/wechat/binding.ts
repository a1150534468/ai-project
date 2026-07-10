import type { PrismaClient } from "@yc/db";

export interface ResolvedBinding {
  userId: string;
  deviceId: string;
  targetType: "agent" | "team";
  targetId: string;
  sessionId: string;
  model: string;
}

export async function resolveBindingByDevice(
  prisma: PrismaClient,
  deviceId: string,
): Promise<ResolvedBinding | null> {
  const b = await prisma.wechatBinding.findUnique({ where: { deviceId } });
  if (!b) return null;
  return {
    userId: b.userId,
    deviceId: b.deviceId,
    targetType: b.targetType as "agent" | "team",
    targetId: b.targetId,
    sessionId: b.sessionId,
    model: b.model,
  };
}
