import { describe, expect, it, vi } from "vitest";
import { reapPendingLocalBusinessPromoRefunds } from "./local-business-promo-refund.js";

function createRefundRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    projectId: "project-1",
    userId: "u1",
    billingOperationId: "local-business-promo-render:project-1:op-1",
    billingRefundedAt: null,
    billingRefundStatus: "pending",
    billingRefundError: "refund failed",
    billingRefundRetryCount: 1,
    billingRefundLastAttemptAt: new Date("2026-07-08T10:00:00.000Z"),
    billingRefundNextRetryAt: new Date("2026-07-08T10:01:00.000Z"),
    status: "failed",
    updatedAt: new Date("2026-07-08T10:00:00.000Z"),
    ...overrides,
  };
}

describe("local-business-promo-refund reaper", () => {
  it("refunds due pending runs and marks them refunded", async () => {
    const run = createRefundRun();
    const prisma = {
      localBusinessPromoRun: {
        findMany: vi.fn().mockResolvedValue([run]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(run, data)),
      },
    } as any;
    const billing = { refundResource: vi.fn().mockResolvedValue({ success: true }) };
    const now = new Date("2026-07-08T10:05:00.000Z");

    const processed = await reapPendingLocalBusinessPromoRefunds({
      prisma,
      billing,
      now,
    });

    expect(processed).toBe(1);
    expect(billing.refundResource).toHaveBeenCalledWith(run.billingOperationId);
    expect(run.billingRefundStatus).toBe("refunded");
    expect(run.billingRefundedAt).toEqual(now);
    expect(run.billingRefundError).toBeNull();
    expect(run.billingRefundNextRetryAt).toBeNull();
  });

  it("keeps pending runs scheduled when the retry still fails", async () => {
    const run = createRefundRun();
    const prisma = {
      localBusinessPromoRun: {
        findMany: vi.fn().mockResolvedValue([run]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(run, data)),
      },
    } as any;
    const billing = { refundResource: vi.fn().mockRejectedValue(new Error("upstream timeout")) };
    const now = new Date("2026-07-08T10:05:00.000Z");

    const processed = await reapPendingLocalBusinessPromoRefunds({
      prisma,
      billing,
      now,
    });

    expect(processed).toBe(1);
    expect(run.billingRefundStatus).toBe("pending");
    expect(run.billingRefundedAt).toBeNull();
    expect(run.billingRefundError).toContain("upstream timeout");
    expect(run.billingRefundRetryCount).toBe(2);
    expect(run.billingRefundNextRetryAt).not.toBeNull();
  });
});
