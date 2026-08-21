import { describe, expect, it } from "vitest";
import { continuationBillingBlocked } from "./codex-pet-failed-continuation.js";

const legacyRefunded = {
  billingMode: "legacy_package_v1",
  billingChargeStatus: "charged",
  billingRefundStatus: "refunded",
  billingRefundedAt: new Date("2026-07-30T00:00:00.000Z"),
  billingSettlementStatus: "none",
} as const;

// A per-image run never charges up front and never refunds: it holds a
// reservation and settles once. Its columns therefore look nothing like a
// refunded legacy run, and requiring the legacy shape rejected every one of them.
const perImageReserved = {
  billingMode: "per_image_call_v1",
  billingChargeStatus: "reserved",
  billingRefundStatus: "none",
  billingRefundedAt: null,
  billingSettlementStatus: "reserved",
} as const;

describe("codex pet continuation billing guard", () => {
  it("accepts a legacy run only once its up-front charge was actually refunded", () => {
    expect(continuationBillingBlocked(legacyRefunded)).toBeNull();
    expect(continuationBillingBlocked({ ...legacyRefunded, billingRefundStatus: "pending" })).toMatch(/已退款/);
    expect(continuationBillingBlocked({ ...legacyRefunded, billingRefundedAt: null })).toMatch(/已退款/);
    expect(continuationBillingBlocked({ ...legacyRefunded, billingChargeStatus: "pending" })).toMatch(/已退款/);
  });

  it("accepts a per-image run whose reservation is still unsettled", () => {
    expect(continuationBillingBlocked(perImageReserved)).toBeNull();
  });

  it("rejects a per-image run that was already settled", () => {
    // Settlement is irreversible and closes worker eligibility, extra-call
    // approval and continuation alike, so a settled run must not be resumed.
    expect(continuationBillingBlocked({ ...perImageReserved, billingSettlementStatus: "settled" }))
      .toMatch(/已结清/);
  });

  it("does not judge a per-image run by the legacy refund columns", () => {
    // The regression this guards: "reserved" + refundStatus "none" is the normal,
    // healthy state of a resumable per-image run, not a disqualifying one.
    expect(continuationBillingBlocked({
      ...perImageReserved,
      billingChargeStatus: "reserved",
      billingRefundStatus: "none",
      billingRefundedAt: null,
    })).toBeNull();
  });

  it("rejects a per-image reservation that never completed", () => {
    for (const status of ["none", "reserve_failed", "insufficient", "settle_failed"]) {
      expect(continuationBillingBlocked({ ...perImageReserved, billingSettlementStatus: status })).not.toBeNull();
    }
  });
});
