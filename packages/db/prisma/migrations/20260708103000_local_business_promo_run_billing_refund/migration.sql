-- AlterTable
ALTER TABLE "LocalBusinessPromoRun"
ADD COLUMN     "billingOperationId" TEXT,
ADD COLUMN     "billingRefundedAt" TIMESTAMP(3);
