-- AlterTable
ALTER TABLE "LocalBusinessPromoRun"
ADD COLUMN     "billingRefundStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "billingRefundError" TEXT,
ADD COLUMN     "billingRefundRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "billingRefundLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "billingRefundNextRetryAt" TIMESTAMP(3);

UPDATE "LocalBusinessPromoRun"
SET "billingRefundStatus" = 'refunded'
WHERE "billingRefundedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "LocalBusinessPromoRun_billingRefundStatus_billingRefundNex_idx"
ON "LocalBusinessPromoRun"("billingRefundStatus", "billingRefundNextRetryAt");
