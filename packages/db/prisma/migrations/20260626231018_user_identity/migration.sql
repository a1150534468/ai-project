-- 上线前重置旧用户体系测试数据（已确认无真实用户），以便加 NOT NULL 唯一列
DELETE FROM "Memory";
DELETE FROM "DeviceSession";
DELETE FROM "Device";
DELETE FROM "Message";
DELETE FROM "Session";
DELETE FROM "User";

-- 重构 User：去 email，加 uid/username/bannedAt
ALTER TABLE "User" DROP COLUMN "email";
ALTER TABLE "User" ADD COLUMN "uid" TEXT NOT NULL;
ALTER TABLE "User" ADD COLUMN "username" TEXT NOT NULL;
ALTER TABLE "User" ADD COLUMN "bannedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_uid_key" ON "User"("uid");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
