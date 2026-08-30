import type { PrismaClient } from "@ai-assistant/db";

export function getPlatformChannelCode(): string {
  return process.env.PLATFORM_CHANNEL_CODE ?? "GF";
}

export async function seedPlatformChannel(prisma: PrismaClient) {
  const platformCode = getPlatformChannelCode();
  await prisma.channel.upsert({
    where: { code: platformCode },
    create: { code: platformCode, ownerType: "PLATFORM", commissionRate: 0, enabled: true },
    update: {},
  });
  await prisma.resellerVisibilityConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
}
