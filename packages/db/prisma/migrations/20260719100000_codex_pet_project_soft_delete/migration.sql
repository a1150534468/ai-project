ALTER TABLE "CodexPetProject"
ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "CodexPetProject_userId_deletedAt_updatedAt_idx"
ON "CodexPetProject"("userId", "deletedAt", "updatedAt");
