-- CreateTable
CREATE TABLE "TranscriptionTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "audioObjectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "audioDurationSec" INTEGER,
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "model" TEXT NOT NULL DEFAULT 'qwen-audio-3.1-asr-flash-filetrans',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "bailianTaskId" TEXT,
    "transcriptText" TEXT,
    "segmentsJson" TEXT,
    "asrInputTokens" INTEGER,
    "asrOutputTokens" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptionTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptionTask_requestId_key" ON "TranscriptionTask"("requestId");

-- CreateIndex
CREATE INDEX "TranscriptionTask_userId_createdAt_idx" ON "TranscriptionTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TranscriptionTask_status_updatedAt_idx" ON "TranscriptionTask"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "TranscriptionTask" ADD CONSTRAINT "TranscriptionTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
