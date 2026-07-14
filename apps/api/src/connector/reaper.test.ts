import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { generateUniqueUid } from "../auth/uid.js";
import { reapStaleSessions } from "./reaper.js";

const prisma = getPrisma();
let userId = "";
let deviceId = "";

beforeAll(async () => {
  const uid = await generateUniqueUid(
    async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } }))
  );
  const u = await prisma.user.create({
    data: { uid, username: `reap_${Date.now()}`, passwordHash: "x" },
  });
  userId = u.id;
  const d = await prisma.device.create({
    data: {
      userId,
      platform: "win",
      tokenHash: `h-${Date.now()}`,
      expiresAt: new Date(Date.now() + 1e6),
      online: true,
      lastSeenAt: new Date(Date.now() - 600_000),
    },
  });
  deviceId = d.id;
});

afterAll(async () => {
  await prisma.deviceSession.deleteMany({ where: { userId } });
  await prisma.device.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("reapStaleSessions", () => {
  it("收尾心跳超时设备的未关会话并置离线", async () => {
    const s = await prisma.deviceSession.create({
      data: {
        deviceId,
        userId,
        appVersion: "1.0.0",
        connectedAt: new Date(Date.now() - 700_000),
      },
    });
    const n = await reapStaleSessions(prisma, 300_000); // 超过 5 分钟未心跳视为掉线
    expect(n).toBeGreaterThanOrEqual(1);
    const closed = await prisma.deviceSession.findUnique({ where: { id: s.id } });
    const dev = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(closed!.disconnectedAt).not.toBeNull();
    expect(closed!.durationSec).toBeGreaterThan(0);
    expect(dev!.online).toBe(false);
  });
});
