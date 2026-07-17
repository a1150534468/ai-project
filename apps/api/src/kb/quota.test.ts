import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import { myQuota } from "./quota.js";

const prisma = getPrisma();
const createdUserIds: string[] = [];

afterAll(async () => {
  await prisma.kbQuotaGrant.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.knowledgeBase.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("KB quota", () => {
  it("returns default, membership and active grant capacity without purchasable packages", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { uid: `quota-${suffix}`, username: `quota-${suffix}`, passwordHash: "test" },
    });
    createdUserIds.push(user.id);

    await prisma.kbQuotaGrant.createMany({
      data: [
        { userId: user.id, bytes: 8, source: "ADMIN" },
        { userId: user.id, bytes: 99, source: "ADMIN", expiresAt: new Date(Date.now() - 1_000) },
      ],
    });

    const result = await myQuota(
      prisma,
      { getUserKbQuota: async () => ({ defaultBytes: 1_073_741_824, membershipBytes: 16 }) },
      user.id,
    );

    expect(result).toEqual({
      effective: 1_073_741_848,
      used: 0,
      breakdown: { defaultBytes: 1_073_741_824, membershipBytes: 16, grantBytes: 8 },
    });
    expect("packages" in result).toBe(false);
  });
});
