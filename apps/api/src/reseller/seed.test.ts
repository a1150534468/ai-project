import { describe, it, expect } from "vitest";
import { getPrisma } from "@yc/db";
import { seedPlatformChannel } from "./seed.js";

describe("seedPlatformChannel", () => {
  it("幂等 seed 平台渠道 GF + 可见项", async () => {
    const prisma = getPrisma();
    await seedPlatformChannel(prisma);
    await seedPlatformChannel(prisma); // 第二次不报错、不重复
    const ch = await prisma.channel.findUnique({ where: { code: "GF" } });
    expect(ch?.ownerType).toBe("PLATFORM");
    expect(ch?.commissionRate).toBe(0);
    const vis = await prisma.resellerVisibilityConfig.findUnique({ where: { id: "singleton" } });
    expect(vis).not.toBeNull();
  });
});
