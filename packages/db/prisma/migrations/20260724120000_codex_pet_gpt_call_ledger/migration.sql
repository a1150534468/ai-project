ALTER TABLE "CodexPetProject"
  ADD COLUMN "qualityInspectionEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CodexPetRun"
  ADD COLUMN "billingMode" TEXT NOT NULL DEFAULT 'legacy_package_v1',
  ADD COLUMN "billingResourceKey" TEXT,
  ADD COLUMN "billingReservedUnits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billingSettledUnits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billingReservedPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billingSettledPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billingSettlementStatus" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "billingSettledAt" TIMESTAMP(3),
  ADD COLUMN "qualityInspectionEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "plannedImageCallLimit" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CodexPetImageCall" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "jobKey" TEXT NOT NULL,
  "logicalAttempt" INTEGER NOT NULL,
  "callKind" TEXT NOT NULL DEFAULT 'planned',
  "purpose" TEXT NOT NULL,
  "requestedModel" TEXT NOT NULL,
  "actualModel" TEXT,
  "operationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'prepared',
  "resourceKey" TEXT,
  "units" INTEGER NOT NULL DEFAULT 1,
  "points" INTEGER NOT NULL DEFAULT 0,
  "upstreamRequestId" TEXT,
  "sentAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodexPetImageCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodexPetImageCall_operationId_key" ON "CodexPetImageCall"("operationId");
CREATE UNIQUE INDEX "CodexPetImageCall_runId_jobKey_logicalAttempt_key" ON "CodexPetImageCall"("runId", "jobKey", "logicalAttempt");
CREATE INDEX "CodexPetImageCall_projectId_createdAt_idx" ON "CodexPetImageCall"("projectId", "createdAt");
CREATE INDEX "CodexPetImageCall_runId_status_createdAt_idx" ON "CodexPetImageCall"("runId", "status", "createdAt");
CREATE INDEX "CodexPetImageCall_userId_createdAt_idx" ON "CodexPetImageCall"("userId", "createdAt");
CREATE INDEX "CodexPetRun_billingMode_billingSettlementStatus_idx" ON "CodexPetRun"("billingMode", "billingSettlementStatus");

ALTER TABLE "CodexPetImageCall" ADD CONSTRAINT "CodexPetImageCall_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "CodexPetProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetImageCall" ADD CONSTRAINT "CodexPetImageCall_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "CodexPetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetImageCall" ADD CONSTRAINT "CodexPetImageCall_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
