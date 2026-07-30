-- A charged extra image call that failed at the provider produced no image, so
-- it must be refunded instead of silently billed. Track the refund on the call
-- row so a refund outage is retryable from the ledger.
ALTER TABLE "CodexPetImageCall"
  ADD COLUMN "refundStatus" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "refundError" TEXT;

-- Lets the sweeper find refunds still owed without scanning the whole ledger.
CREATE INDEX "CodexPetImageCall_refundStatus_idx"
  ON "CodexPetImageCall" ("refundStatus", "createdAt");
