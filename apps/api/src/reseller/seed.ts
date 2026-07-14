import type { PrismaClient } from "@ai-assistant/db";

const PLATFORM_CODE = process.env.PLATFORM_CHANNEL_CODE ?? "GF";

export async function seedPlatformChannel(prisma: PrismaClient) {
  await prisma.channel.upsert({
    where: { code: PLATFORM_CODE },
    create: { code: PLATFORM_CODE, ownerType: "PLATFORM", commissionRate: 0, enabled: true },
    update: {},
  });
  await prisma.resellerVisibilityConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
}
