-- AlterTable
ALTER TABLE "User" ADD COLUMN     "channelId" TEXT;

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "resellerId" TEXT,
    "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerVisibilityConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "showRecharge" BOOLEAN NOT NULL DEFAULT true,
    "showConsumption" BOOLEAN NOT NULL DEFAULT true,
    "showMembership" BOOLEAN NOT NULL DEFAULT true,
    "showLastActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ResellerVisibilityConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Channel_code_key" ON "Channel"("code");

-- CreateIndex
CREATE INDEX "Channel_resellerId_idx" ON "Channel"("resellerId");

-- CreateIndex
CREATE INDEX "User_channelId_idx" ON "User"("channelId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
