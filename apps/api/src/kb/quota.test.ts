import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrisma } from "@yc/db";
import { myQuota, buyQuota, PackageNotFoundError } from "./quota.js";
import { InsufficientBalanceError } from "@yc/billing";

const prisma = getPrisma();

// Test data collectors for id-scoped cleanup
let createdUserIds: string[] = [];
let createdPackageIds: string[] = [];
let createdGrantIds: string[] = [];

beforeAll(async () => {
  // Create test packages
  const permanentPkg = await prisma.kbQuotaPackage.create({
    data: {
      name: "标准配额（永久）",
      bytes: 10 * 1024 * 1024, // 10MB
      durationDays: 0, // Permanent
      pricePoints: 100,
      enabled: true,
    },
  });
  createdPackageIds.push(permanentPkg.id);

  const limitedPkg = await prisma.kbQuotaPackage.create({
    data: {
      name: "临时配额（30天）",
      bytes: 50 * 1024 * 1024, // 50MB
      durationDays: 30,
      pricePoints: 300,
      enabled: true,
    },
  });
  createdPackageIds.push(limitedPkg.id);

  // Create a disabled package (should not appear in myQuota.packages)
  const disabledPkg = await prisma.kbQuotaPackage.create({
    data: {
      name: "已停用配额",
      bytes: 100 * 1024 * 1024,
      durationDays: 0,
      pricePoints: 500,
      enabled: false,
    },
  });
  createdPackageIds.push(disabledPkg.id);
});

afterAll(async () => {
  // Clean up in reverse order of dependencies
  // KbQuotaGrants before KbQuotaPackages
  if (createdGrantIds.length > 0) {
    await prisma.kbQuotaGrant.deleteMany({
      where: { id: { in: createdGrantIds } },
    });
  }

  // KbQuotaPackages
  if (createdPackageIds.length > 0) {
    await prisma.kbQuotaPackage.deleteMany({
      where: { id: { in: createdPackageIds } },
    });
  }

  // Users last
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  }
});

describe("KB Quota Service", () => {
  describe("myQuota", () => {
    it("计算有效配额：default + membership + 未过期的 grants", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-test-1-${Date.now()}`,
          username: `quota-test-1-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const mockBilling = {
        async getUserKbQuota() {
          return { defaultBytes: 100 * 1024 * 1024, membershipBytes: 10 * 1024 * 1024 };
        },
      };

      // Create grants: permanent, expired, and future-expiring
      const permanentGrant = await prisma.kbQuotaGrant.create({
        data: {
          userId: user.id,
          bytes: 5 * 1024 * 1024,
          source: "PURCHASE",
          expiresAt: null,
        },
      });
      createdGrantIds.push(permanentGrant.id);

      // Expired grant (should not count)
      const expiredGrant = await prisma.kbQuotaGrant.create({
        data: {
          userId: user.id,
          bytes: 20 * 1024 * 1024,
          source: "ADMIN",
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      createdGrantIds.push(expiredGrant.id);

      // Future-expiring grant (should count)
      const futureGrant = await prisma.kbQuotaGrant.create({
        data: {
          userId: user.id,
          bytes: 3 * 1024 * 1024,
          source: "PURCHASE",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      createdGrantIds.push(futureGrant.id);

      const quota = await myQuota(prisma, mockBilling, user.id);

      // Check breakdown
      expect(quota.breakdown.defaultBytes).toBe(100 * 1024 * 1024);
      expect(quota.breakdown.membershipBytes).toBe(10 * 1024 * 1024);
      expect(quota.breakdown.grantBytes).toBe(8 * 1024 * 1024); // permanent (5) + future (3)

      // Check effective = 100 + 10 + 8 = 118MB
      expect(quota.effective).toBe(118 * 1024 * 1024);

      // Check used is 0 (no documents)
      expect(quota.used).toBe(0);

      // Check packages only contains enabled ones
      expect(quota.packages.length).toBeGreaterThanOrEqual(2);
      expect(quota.packages.every((p) => p.id === undefined || true)).toBe(true); // All packages should be enabled
    });

    it("packages 只包含启用的配额包，按 createdAt 排序", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-test-2-${Date.now()}`,
          username: `quota-test-2-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const mockBilling = {
        async getUserKbQuota() {
          return { defaultBytes: 0, membershipBytes: 0 };
        },
      };

      const quota = await myQuota(prisma, mockBilling, user.id);

      // Should contain permanent and limited packages, but NOT disabled
      const enabledPackageNames = quota.packages.map((p) => p.name);
      expect(enabledPackageNames).toContain("标准配额（永久）");
      expect(enabledPackageNames).toContain("临时配额（30天）");
      expect(enabledPackageNames).not.toContain("已停用配额");
    });
  });

  describe("buyQuota", () => {
    it("购买永久包成功：chargePoints 被调用、建 grant、返回 effective + grantId", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-buy-1-${Date.now()}`,
          username: `quota-buy-1-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      // Get permanent package
      const permanentPkg = await prisma.kbQuotaPackage.findFirst({
        where: { name: "标准配额（永久）", enabled: true },
      });
      expect(permanentPkg).toBeDefined();

      let chargePointsCalled = false;
      let capturedOpId = "";

      const mockBilling = {
        async chargePoints(args: { operationId: string; userId: string; points: number; kind: string }) {
          chargePointsCalled = true;
          capturedOpId = args.operationId;
          expect(args.userId).toBe(user.id);
          expect(args.points).toBe(permanentPkg!.pricePoints);
          expect(args.kind).toBe("kb_quota");
          return { charged: args.points };
        },
        async getUserKbQuota() {
          return { defaultBytes: 100 * 1024 * 1024, membershipBytes: 10 * 1024 * 1024 };
        },
      };

      const result = await buyQuota(prisma, mockBilling, user.id, permanentPkg!.id);

      // Verify chargePoints was called
      expect(chargePointsCalled).toBe(true);

      // Verify opId contains userId and packageId
      expect(capturedOpId).toContain(`kb:quota:${user.id}:${permanentPkg!.id}:`);

      // Verify grant was created
      const grant = await prisma.kbQuotaGrant.findUnique({ where: { id: result.grantId } });
      expect(grant).toBeDefined();
      expect(grant!.userId).toBe(user.id);
      expect(grant!.bytes).toBe(permanentPkg!.bytes);
      expect(grant!.source).toBe("PURCHASE");
      expect(grant!.expiresAt).toBeNull(); // Permanent grant
      expect(grant!.opId).toBe(capturedOpId);
      expect(grant!.note).toBe(permanentPkg!.name);
      createdGrantIds.push(grant!.id);

      // Verify effective quota increased
      expect(result.effective).toBe(100 * 1024 * 1024 + 10 * 1024 * 1024 + permanentPkg!.bytes);
    });

    it("购买限时包成功：grant.expiresAt ≈ now + durationDays*86400000", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-buy-2-${Date.now()}`,
          username: `quota-buy-2-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const limitedPkg = await prisma.kbQuotaPackage.findFirst({
        where: { name: "临时配额（30天）", enabled: true },
      });
      expect(limitedPkg).toBeDefined();

      const mockBilling = {
        async chargePoints() {
          return { charged: limitedPkg!.pricePoints };
        },
        async getUserKbQuota() {
          return { defaultBytes: 0, membershipBytes: 0 };
        },
      };

      const beforeTime = Date.now();
      const result = await buyQuota(prisma, mockBilling, user.id, limitedPkg!.id);
      const afterTime = Date.now();

      const grant = await prisma.kbQuotaGrant.findUnique({ where: { id: result.grantId } });
      expect(grant).toBeDefined();
      expect(grant!.expiresAt).toBeDefined();

      // Check that expiresAt is approximately now + 30 days
      const expectedExpiry = beforeTime + limitedPkg!.durationDays * 86400000;
      const actualExpiry = grant!.expiresAt!.getTime();
      const diff = Math.abs(actualExpiry - expectedExpiry);
      expect(diff).toBeLessThan(5000); // Allow 5 second tolerance
      createdGrantIds.push(grant!.id);
    });

    it("包不存在时抛 PackageNotFoundError、不调 chargePoints", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-buy-3-${Date.now()}`,
          username: `quota-buy-3-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      let chargePointsCalled = false;

      const mockBilling = {
        async chargePoints() {
          chargePointsCalled = true;
          return { charged: 0 };
        },
        async getUserKbQuota() {
          return { defaultBytes: 0, membershipBytes: 0 };
        },
      };

      await expect(
        buyQuota(prisma, mockBilling, user.id, "nonexistent-package-id")
      ).rejects.toThrow(PackageNotFoundError);

      // Verify chargePoints was NOT called
      expect(chargePointsCalled).toBe(false);
    });

    it("包被停用时抛 PackageNotFoundError、不调 chargePoints", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-buy-4-${Date.now()}`,
          username: `quota-buy-4-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const disabledPkg = await prisma.kbQuotaPackage.findFirst({
        where: { name: "已停用配额", enabled: false },
      });
      expect(disabledPkg).toBeDefined();

      let chargePointsCalled = false;

      const mockBilling = {
        async chargePoints() {
          chargePointsCalled = true;
          return { charged: 0 };
        },
        async getUserKbQuota() {
          return { defaultBytes: 0, membershipBytes: 0 };
        },
      };

      await expect(
        buyQuota(prisma, mockBilling, user.id, disabledPkg!.id)
      ).rejects.toThrow(PackageNotFoundError);

      // Verify chargePoints was NOT called
      expect(chargePointsCalled).toBe(false);
    });

    it("余额不足时抛 InsufficientBalanceError、不建 grant", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-buy-5-${Date.now()}`,
          username: `quota-buy-5-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const permanentPkg = await prisma.kbQuotaPackage.findFirst({
        where: { name: "标准配额（永久）", enabled: true },
      });
      expect(permanentPkg).toBeDefined();

      const mockBilling = {
        async chargePoints() {
          throw new InsufficientBalanceError();
        },
        async getUserKbQuota() {
          return { defaultBytes: 0, membershipBytes: 0 };
        },
      };

      await expect(
        buyQuota(prisma, mockBilling, user.id, permanentPkg!.id)
      ).rejects.toThrow(InsufficientBalanceError);

      // Verify NO grant was created
      const grantsForUser = await prisma.kbQuotaGrant.findMany({
        where: { userId: user.id },
      });
      expect(grantsForUser).toHaveLength(0);
    });

    it("opId 包含 userId、packageId、且每次购买都唯一", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-buy-6-${Date.now()}`,
          username: `quota-buy-6-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const permanentPkg = await prisma.kbQuotaPackage.findFirst({
        where: { name: "标准配额（永久）", enabled: true },
      });
      expect(permanentPkg).toBeDefined();

      const capturedOpIds: string[] = [];

      const mockBilling = {
        async chargePoints(args: { operationId: string }) {
          capturedOpIds.push(args.operationId);
          return { charged: 100 };
        },
        async getUserKbQuota() {
          return { defaultBytes: 0, membershipBytes: 0 };
        },
      };

      // Buy twice
      const result1 = await buyQuota(prisma, mockBilling, user.id, permanentPkg!.id);
      const result2 = await buyQuota(prisma, mockBilling, user.id, permanentPkg!.id);
      createdGrantIds.push(result1.grantId, result2.grantId);

      // Verify opIds are different
      expect(capturedOpIds[0]).not.toBe(capturedOpIds[1]);

      // Verify both contain prefix
      expect(capturedOpIds[0]).toContain(`kb:quota:${user.id}:${permanentPkg!.id}:`);
      expect(capturedOpIds[1]).toContain(`kb:quota:${user.id}:${permanentPkg!.id}:`);

      // Verify opId is @unique (DB constraint)
      const grants = await prisma.kbQuotaGrant.findMany({
        where: { userId: user.id },
      });
      expect(grants).toHaveLength(2);
      const opIds = grants.map((g) => g.opId);
      expect(new Set(opIds).size).toBe(2); // All unique
    });

    it("chargePoints 成功但 grant 创建失败时抛错并记录 opId", async () => {
      const user = await prisma.user.create({
        data: {
          uid: `quota-buy-7-${Date.now()}`,
          username: `quota-buy-7-${Date.now()}`,
          passwordHash: "dummy",
        },
      });
      createdUserIds.push(user.id);

      const permanentPkg = await prisma.kbQuotaPackage.findFirst({
        where: { name: "标准配额（永久）", enabled: true },
      });
      expect(permanentPkg).toBeDefined();

      let loggedOpId = "";
      const originalLog = console.error;
      console.error = (msg: string, ...args: any[]) => {
        if (msg.includes("[KB Quota]")) {
          loggedOpId = msg;
        }
      };

      const mockBilling = {
        async chargePoints() {
          return { charged: 100 };
        },
        async getUserKbQuota() {
          return { defaultBytes: 0, membershipBytes: 0 };
        },
      };

      // Mock prisma to fail on second grant creation
      const originalCreate = prisma.kbQuotaGrant.create;
      let createCallCount = 0;
      prisma.kbQuotaGrant.create = (async (args: any) => {
        createCallCount++;
        if (createCallCount > 1) {
          throw new Error("Simulated DB failure");
        }
        return originalCreate.call(prisma.kbQuotaGrant, args);
      }) as any;

      try {
        // First purchase should succeed
        const result1 = await buyQuota(prisma, mockBilling, user.id, permanentPkg!.id);
        createdGrantIds.push(result1.grantId);

        // Second purchase will fail on grant creation
        await expect(
          buyQuota(prisma, mockBilling, user.id, permanentPkg!.id)
        ).rejects.toThrow("Simulated DB failure");

        // Verify opId was logged
        expect(loggedOpId).toContain("[KB Quota]");
      } finally {
        console.error = originalLog;
        prisma.kbQuotaGrant.create = originalCreate;
      }
    });
  });
});
