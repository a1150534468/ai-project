import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@yc/db";
import { generateUniqueUid } from "../auth/uid.js";
import {
  pairDevice,
  verifyDeviceToken,
  revokeDevice,
  revokeDeviceByAdmin,
  listDevices,
  touchDevice,
  refreshDeviceHeartbeat,
  replaceOtherUserDevices,
  openSession,
  closeSession,
  DEVICE_TTL_MS,
} from "./service.js";

const prisma = getPrisma();
let userId = "";
let otherId = "";

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  if (value === null || value === undefined) throw new Error("Expected value to be present");
  return value;
}

beforeAll(async () => {
  const uid = await generateUniqueUid(
    async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } }))
  );
  const u = await prisma.user.create({
    data: { uid, username: `dev_${Date.now()}`, passwordHash: "x" },
  });
  userId = u.id;
  const uid2 = await generateUniqueUid(
    async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } }))
  );
  const u2 = await prisma.user.create({
    data: { uid: uid2, username: `t8b_b_${Date.now()}`, passwordHash: "x" },
  });
  otherId = u2.id;
});

afterAll(async () => {
  await prisma.deviceSession.deleteMany({ where: { userId: { in: [userId, otherId] } } });
  await prisma.device.deleteMany({ where: { userId: { in: [userId, otherId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
});

describe("device service", () => {
  it("配对返回明文 token，且可验证到设备", async () => {
    const { deviceId, token } = await pairDevice(prisma, userId, "我的电脑", "win");
    const dev = await verifyDeviceToken(prisma, token);
    expect(dev?.id).toBe(deviceId);
    expect(dev?.userId).toBe(userId);
  });

  it("吊销后无法验证", async () => {
    const { deviceId, token } = await pairDevice(prisma, userId, "笔记本", "mac");
    await revokeDevice(prisma, userId, deviceId);
    expect(await verifyDeviceToken(prisma, token)).toBeNull();
  });

  it("过期后无法验证", async () => {
    const { deviceId, token } = await pairDevice(prisma, userId, "旧机", "linux");
    await prisma.device.update({
      where: { id: deviceId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await verifyDeviceToken(prisma, token)).toBeNull();
  });

  it("touch 滑动续期并刷新版本/在线", async () => {
    const { deviceId } = await pairDevice(prisma, userId, "续期机", "win");
    const before = await prisma.device.findUnique({ where: { id: deviceId } });
    await prisma.device.update({
      where: { id: deviceId },
      data: { expiresAt: new Date(Date.now() + 1000) },
    });
    await touchDevice(prisma, deviceId, "2.0.0");
    const after = await prisma.device.findUnique({ where: { id: deviceId } });
    const beforeDevice = expectPresent(before);
    const afterDevice = expectPresent(after);
    expect(afterDevice.appVersion).toBe("2.0.0");
    expect(afterDevice.online).toBe(true);
    expect(afterDevice.expiresAt.getTime()).toBeGreaterThan(beforeDevice.expiresAt.getTime());
    expect(afterDevice.expiresAt.getTime()).toBeGreaterThan(Date.now() + DEVICE_TTL_MS - 60_000);
  });

  it("heartbeat 刷新在线状态、lastSeenAt 和滑动过期时间", async () => {
    const { deviceId } = await pairDevice(prisma, userId, "心跳机", "win");
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        online: false,
        lastSeenAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 1000),
      },
    });

    await refreshDeviceHeartbeat(prisma, deviceId);

    const after = await prisma.device.findUnique({ where: { id: deviceId } });
    const afterDevice = expectPresent(after);
    const lastSeenAt = expectPresent(afterDevice.lastSeenAt);
    expect(afterDevice.online).toBe(true);
    expect(lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
    expect(afterDevice.expiresAt.getTime()).toBeGreaterThan(Date.now() + DEVICE_TTL_MS - 60_000);
  });

  it("新设备接管时吊销同用户其它设备并关闭其未结束会话", async () => {
    const uid = await generateUniqueUid(
      async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } }))
    );
    const takeoverUser = await prisma.user.create({
      data: { uid, username: `takeover_${Date.now()}`, passwordHash: "x" },
    });
    try {
      const active = await pairDevice(prisma, takeoverUser.id, "当前设备", "win");
      const oldOnline = await pairDevice(prisma, takeoverUser.id, "旧在线设备", "mac");
      const oldOffline = await pairDevice(prisma, takeoverUser.id, "旧离线设备", "linux");
      const otherUserDevice = await pairDevice(prisma, otherId, "他人设备", "win");
      await touchDevice(prisma, oldOnline.deviceId, "1.0.0");
      const open = await openSession(prisma, oldOnline.deviceId, takeoverUser.id, "1.0.0");
      await prisma.deviceSession.update({
        where: { id: open.id },
        data: { connectedAt: new Date(Date.now() - 5000) },
      });

      const replaced = await replaceOtherUserDevices(prisma, takeoverUser.id, active.deviceId);

      expect(replaced.sort()).toEqual([oldOnline.deviceId, oldOffline.deviceId].sort());
      expect(await verifyDeviceToken(prisma, active.token)).not.toBeNull();
      expect(await verifyDeviceToken(prisma, oldOnline.token)).toBeNull();
      expect(await verifyDeviceToken(prisma, oldOffline.token)).toBeNull();
      expect(await verifyDeviceToken(prisma, otherUserDevice.token)).not.toBeNull();
      const closed = await prisma.deviceSession.findUnique({ where: { id: open.id } });
      const closedSession = expectPresent(closed);
      expect(closedSession.disconnectedAt).not.toBeNull();
      expect(closedSession.durationSec).toBeGreaterThanOrEqual(4);
    } finally {
      await prisma.deviceSession.deleteMany({ where: { userId: takeoverUser.id } });
      await prisma.device.deleteMany({ where: { userId: takeoverUser.id } });
      await prisma.user.delete({ where: { id: takeoverUser.id } });
    }
  });

  it("listDevices 不泄露 tokenHash", async () => {
    const list = await listDevices(prisma, userId);
    expect(list.length).toBeGreaterThan(0);
    const first = expectPresent(list[0]);
    expect("tokenHash" in first).toBe(false);
  });

  it("会话开合结算 durationSec 并置离线", async () => {
    const { deviceId } = await pairDevice(prisma, userId, "会话机", "win");
    const s = await openSession(prisma, deviceId, userId, "1.0.0");
    await prisma.deviceSession.update({
      where: { id: s.id },
      data: { connectedAt: new Date(Date.now() - 5000) },
    });
    await closeSession(prisma, s.id, deviceId);
    const closed = await prisma.deviceSession.findUnique({ where: { id: s.id } });
    const dev = await prisma.device.findUnique({ where: { id: deviceId } });
    const closedSession = expectPresent(closed);
    const device = expectPresent(dev);
    expect(closedSession.disconnectedAt).not.toBeNull();
    expect(closedSession.durationSec).toBeGreaterThanOrEqual(4);
    expect(device.online).toBe(false);
  });

  it("关闭旧连接 session 时可保留设备在线状态", async () => {
    const { deviceId } = await pairDevice(prisma, userId, "重连机", "win");
    await prisma.device.update({ where: { id: deviceId }, data: { online: true } });
    const s = await openSession(prisma, deviceId, userId, "1.0.0");

    await closeSession(prisma, s.id, deviceId, { markOffline: false });

    const closed = await prisma.deviceSession.findUnique({ where: { id: s.id } });
    const dev = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(closed?.disconnectedAt).not.toBeNull();
    expect(dev?.online).toBe(true);
  });
});

describe("revokeDevice 返回是否真吊销", () => {
  it("本人设备 → true 且置 revokedAt", async () => {
    const { deviceId } = await pairDevice(prisma, userId, "dev", "win");
    const ok = await revokeDevice(prisma, userId, deviceId);
    expect(ok).toBe(true);
    const d = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(d?.revokedAt).not.toBeNull();
  });
  it("他人设备 → false 且不改库（防越权）", async () => {
    const { deviceId } = await pairDevice(prisma, userId, "dev2", "win");
    const ok = await revokeDevice(prisma, otherId, deviceId); // otherId 试图吊销 userId 的设备
    expect(ok).toBe(false);
    const d = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(d?.revokedAt).toBeNull();
  });
});

describe("封禁属主的设备 verifyDeviceToken 拒绝", () => {
  it("属主被封 → 返回 null；解封后 → 返回设备", async () => {
    const { deviceId, token } = await pairDevice(prisma, userId, "bandev", "win");
    // 正常可验证
    expect(await verifyDeviceToken(prisma, token)).not.toBeNull();
    // 封禁属主
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: new Date() } });
    expect(await verifyDeviceToken(prisma, token)).toBeNull();
    // 解封恢复
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: null } });
    const ok = await verifyDeviceToken(prisma, token);
    expect(ok?.id).toBe(deviceId);
  });
});

describe("revokeDeviceByAdmin 不限属主", () => {
  it("吊销他人设备 → true 且置 revokedAt", async () => {
    const { deviceId } = await pairDevice(prisma, userId, "admindev", "win");
    const ok = await revokeDeviceByAdmin(prisma, deviceId); // 不传 userId
    expect(ok).toBe(true);
    const d = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(d?.revokedAt).not.toBeNull();
  });
  it("不存在设备 → false", async () => {
    expect(await revokeDeviceByAdmin(prisma, "nonexistent")).toBe(false);
  });
});
