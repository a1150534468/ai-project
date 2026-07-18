CREATE TABLE "CodexPetProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "stylePreset" TEXT NOT NULL DEFAULT 'auto',
    "styleNotes" TEXT NOT NULL DEFAULT '',
    "referenceAssetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "autoContinue" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "latestRunId" TEXT,
    "createIdempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodexPetProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodexPetRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "inputSnapshot" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progressStage" TEXT NOT NULL DEFAULT 'queued',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "autoContinue" BOOLEAN NOT NULL DEFAULT false,
    "colorKey" TEXT,
    "billingOperationId" TEXT,
    "billingPoints" INTEGER NOT NULL DEFAULT 0,
    "billingRefundedAt" TIMESTAMP(3),
    "billingRefundStatus" TEXT NOT NULL DEFAULT 'none',
    "billingRefundError" TEXT,
    "billingRefundRetryCount" INTEGER NOT NULL DEFAULT 0,
    "billingRefundLastAttemptAt" TIMESTAMP(3),
    "billingRefundNextRetryAt" TIMESTAMP(3),
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "hasSuccessfulImage" BOOLEAN NOT NULL DEFAULT false,
    "selectedBaseArtifactId" TEXT,
    "spritesheetArtifactId" TEXT,
    "packageArtifactId" TEXT,
    "previewArtifactId" TEXT,
    "validationReport" JSONB,
    "requestedModel" TEXT NOT NULL DEFAULT 'gpt-image-2',
    "actualModels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "usage" JSONB,
    "knowledgeDocumentId" TEXT,
    "lastEventSequence" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodexPetRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodexPetJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "dependencyKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "providerMetadata" JSONB,
    "inputArtifactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "outputArtifactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "workerId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodexPetJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodexPetArtifact" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "objectKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodexPetArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodexPetEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "jobKey" TEXT,
    "message" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodexPetEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodexPetProject_userId_createIdempotencyKey_key" ON "CodexPetProject"("userId", "createIdempotencyKey");
CREATE INDEX "CodexPetProject_userId_updatedAt_idx" ON "CodexPetProject"("userId", "updatedAt");
CREATE INDEX "CodexPetProject_userId_status_idx" ON "CodexPetProject"("userId", "status");

CREATE UNIQUE INDEX "CodexPetRun_billingOperationId_key" ON "CodexPetRun"("billingOperationId");
CREATE UNIQUE INDEX "CodexPetRun_knowledgeDocumentId_key" ON "CodexPetRun"("knowledgeDocumentId");
CREATE UNIQUE INDEX "CodexPetRun_projectId_idempotencyKey_key" ON "CodexPetRun"("projectId", "idempotencyKey");
CREATE INDEX "CodexPetRun_projectId_createdAt_idx" ON "CodexPetRun"("projectId", "createdAt");
CREATE INDEX "CodexPetRun_userId_updatedAt_idx" ON "CodexPetRun"("userId", "updatedAt");
CREATE INDEX "CodexPetRun_status_updatedAt_idx" ON "CodexPetRun"("status", "updatedAt");
CREATE INDEX "CodexPetRun_billingRefundStatus_billingRefundNextRetryAt_idx" ON "CodexPetRun"("billingRefundStatus", "billingRefundNextRetryAt");

CREATE UNIQUE INDEX "CodexPetJob_runId_key_key" ON "CodexPetJob"("runId", "key");
CREATE INDEX "CodexPetJob_projectId_createdAt_idx" ON "CodexPetJob"("projectId", "createdAt");
CREATE INDEX "CodexPetJob_userId_updatedAt_idx" ON "CodexPetJob"("userId", "updatedAt");
CREATE INDEX "CodexPetJob_status_updatedAt_idx" ON "CodexPetJob"("status", "updatedAt");

CREATE UNIQUE INDEX "CodexPetArtifact_objectKey_key" ON "CodexPetArtifact"("objectKey");
CREATE INDEX "CodexPetArtifact_projectId_createdAt_idx" ON "CodexPetArtifact"("projectId", "createdAt");
CREATE INDEX "CodexPetArtifact_runId_kind_createdAt_idx" ON "CodexPetArtifact"("runId", "kind", "createdAt");
CREATE INDEX "CodexPetArtifact_userId_createdAt_idx" ON "CodexPetArtifact"("userId", "createdAt");
CREATE INDEX "CodexPetArtifact_jobId_idx" ON "CodexPetArtifact"("jobId");
CREATE INDEX "CodexPetArtifact_expiresAt_idx" ON "CodexPetArtifact"("expiresAt");

CREATE UNIQUE INDEX "CodexPetEvent_runId_sequence_key" ON "CodexPetEvent"("runId", "sequence");
CREATE INDEX "CodexPetEvent_projectId_createdAt_idx" ON "CodexPetEvent"("projectId", "createdAt");
CREATE INDEX "CodexPetEvent_runId_createdAt_idx" ON "CodexPetEvent"("runId", "createdAt");
CREATE INDEX "CodexPetEvent_userId_createdAt_idx" ON "CodexPetEvent"("userId", "createdAt");

ALTER TABLE "CodexPetProject" ADD CONSTRAINT "CodexPetProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetRun" ADD CONSTRAINT "CodexPetRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodexPetProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetRun" ADD CONSTRAINT "CodexPetRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetRun" ADD CONSTRAINT "CodexPetRun_knowledgeDocumentId_fkey" FOREIGN KEY ("knowledgeDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CodexPetJob" ADD CONSTRAINT "CodexPetJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodexPetProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetJob" ADD CONSTRAINT "CodexPetJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodexPetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetJob" ADD CONSTRAINT "CodexPetJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetArtifact" ADD CONSTRAINT "CodexPetArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodexPetProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetArtifact" ADD CONSTRAINT "CodexPetArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodexPetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetArtifact" ADD CONSTRAINT "CodexPetArtifact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetArtifact" ADD CONSTRAINT "CodexPetArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CodexPetJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CodexPetEvent" ADD CONSTRAINT "CodexPetEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodexPetProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetEvent" ADD CONSTRAINT "CodexPetEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodexPetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexPetEvent" ADD CONSTRAINT "CodexPetEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
