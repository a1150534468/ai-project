-- A Codex pet run is persisted before the external package charge starts.
-- These fields form the durable charge/activation saga and let API or
-- maintenance processes safely reconcile an uncertain idempotent charge.
ALTER TABLE "CodexPetRun"
ADD COLUMN "billingChargeStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "billingChargeAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "billingChargeError" TEXT,
ADD COLUMN "billingChargeLastAttemptAt" TIMESTAMP(3),
ADD COLUMN "billingChargeNextRetryAt" TIMESTAMP(3),
ADD COLUMN "billingChargeLeaseUntil" TIMESTAMP(3),
ADD COLUMN "billingChargedAt" TIMESTAMP(3),
ADD COLUMN "billingActivatedAt" TIMESTAMP(3);

-- Runs created before this migration performed the charge and run.queued
-- insert together. Backfill them as activated so maintenance never charges a
-- legacy operation again (the event also covers a legitimate zero-point
-- resource price).
UPDATE "CodexPetRun" AS run
SET
  "billingChargeStatus" = 'charged',
  "billingChargedAt" = COALESCE(run."startedAt", run."createdAt"),
  "billingActivatedAt" = COALESCE(run."startedAt", run."createdAt")
WHERE run."billingOperationId" IS NOT NULL
  AND (
    run."billingPoints" > 0
    OR EXISTS (
      SELECT 1
      FROM "CodexPetEvent" AS event
      WHERE event."runId" = run."id"
        AND event."type" = 'run.queued'
    )
  );

CREATE INDEX "CodexPetRun_billingChargeStatus_billingChargeNextRetryAt_idx"
ON "CodexPetRun"("billingChargeStatus", "billingChargeNextRetryAt");
