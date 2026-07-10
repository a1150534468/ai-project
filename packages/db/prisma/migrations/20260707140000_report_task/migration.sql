-- CreateTable
CREATE TABLE "ReportTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'pending',
    "sourceType" TEXT NOT NULL,
    "sourceName" TEXT,
    "intent" TEXT,
    "model" TEXT NOT NULL,
    "htmlKey" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportTask_userId_createdAt_idx" ON "ReportTask"("userId", "createdAt");
