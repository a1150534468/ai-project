import type { PrismaClient } from "@yc/db";
import type { ConnectorTool } from "@yc/connector-protocol";
import type { Prisma } from "@prisma/client";
import { generateDeviceToken, hashToken } from "./token.js";

export const DEVICE_TTL_MS = 90 * 24 * 3600_000; // 闲置 90 天失效

export interface DeviceSummary {
  id: string;
  name: string | null;
  platform: string;
  appVersion: string;
  online: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export async function pairDevice(
  prisma: PrismaClient,
  userId: string,
  name: string,
  platform: string,
): Promise<{ deviceId: string; token: string }> {
  const { token, tokenHash } = generateDeviceToken();
  const dev = await prisma.device.create({
    data: {
      userId,
      name,
      platform,
      tokenHash,
      expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
    },
  });
  return { deviceId: dev.id, token };
}

export async function verifyDeviceToken(prisma: PrismaClient, token: string) {
  const dev = await prisma.device.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!dev) return null;
  if (dev.revokedAt) return null;
  if (dev.expiresAt.getTime() < Date.now()) return null;
  // 属主被封 → 拒绝注册/重连（在 WS 注册唯一入口堵住）
  const u = await prisma.user.findUnique({ where: { id: dev.userId }, select: { bannedAt: true } });
  if (u?.bannedAt) return null;
  return dev;
}

function toInputJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toInputJsonValue);
  if (typeof value === "object") return toInputJsonObject(value);
  return null;
}

function toInputJsonObject(value: object): Prisma.InputJsonObject {
  const output: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = toInputJsonValue(item);
  }
  return output;
}

function normalizeDeviceTools(tools: readonly ConnectorTool[]): Prisma.InputJsonArray {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toInputJsonObject(tool.input_schema),
  }));
}

export async function touchDevice(
  prisma: PrismaClient,
  deviceId: string,
  appVersion: string,
  capabilities: readonly string[] = [],
  tools: readonly ConnectorTool[] = [],
) {
  await prisma.device.updateMany({
    where: { id: deviceId, revokedAt: null },
    data: {
      appVersion,
      online: true,
      capabilities: [...capabilities],
      tools: normalizeDeviceTools(tools),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
    },
  });
}

export async function refreshDeviceHeartbeat(prisma: PrismaClient, deviceId: string): Promise<void> {
  await prisma.device.updateMany({
    where: { id: deviceId, revokedAt: null },
    data: {
      online: true,
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
    },
  });
}

async function closeOpenSessionsForDevices(
  prisma: PrismaClient,
  userId: string,
  deviceIds: readonly string[],
  disconnectedAt: Date,
): Promise<void> {
  const sessions = await prisma.deviceSession.findMany({
    where: { userId, deviceId: { in: [...deviceIds] }, disconnectedAt: null },
    select: { id: true, connectedAt: true },
  });
  for (const session of sessions) {
    const durationSec = Math.max(
      0,
      Math.round((disconnectedAt.getTime() - session.connectedAt.getTime()) / 1000),
    );
    await prisma.deviceSession.updateMany({
      where: { id: session.id, disconnectedAt: null },
      data: { disconnectedAt, durationSec },
    });
  }
}

export async function replaceOtherUserDevices(
  prisma: PrismaClient,
  userId: string,
  activeDeviceId: string,
): Promise<string[]> {
  const otherDevices = await prisma.device.findMany({
    where: {
      userId,
      revokedAt: null,
      id: { not: activeDeviceId },
    },
    select: { id: true },
  });
  const otherDeviceIds = otherDevices.map((device) => device.id);
  if (otherDeviceIds.length === 0) return [];

  const now = new Date();
  await prisma.device.updateMany({
    where: { userId, id: { in: otherDeviceIds } },
    data: { revokedAt: now, online: false },
  });
  await closeOpenSessionsForDevices(prisma, userId, otherDeviceIds, now);
  return otherDeviceIds;
}

export async function revokeDevice(prisma: PrismaClient, userId: string, deviceId: string): Promise<boolean> {
  // 限定 userId 防越权吊销他人设备；返回是否确实吊销了（影响行数 > 0）
  const res = await prisma.device.updateMany({
    where: { id: deviceId, userId },
    data: { revokedAt: new Date(), online: false },
  });
  return res.count > 0;
}

// admin 吊销任意设备：不带 userId 限定（门禁在 admin 路由层）。返回是否真吊销。
export async function revokeDeviceByAdmin(prisma: PrismaClient, deviceId: string): Promise<boolean> {
  const res = await prisma.device.updateMany({
    where: { id: deviceId },
    data: { revokedAt: new Date(), online: false },
  });
  return res.count > 0;
}

// admin 视角列某用户全部设备（含已吊销）。
export async function listDevicesForAdmin(prisma: PrismaClient, userId: string) {
  return prisma.device.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      name: true,
      platform: true,
      appVersion: true,
      online: true,
      lastSeenAt: true,
      revokedAt: true,
      capabilities: true,
      createdAt: true,
    },
  });
}

export async function listDevices(prisma: PrismaClient, userId: string): Promise<DeviceSummary[]> {
  const rows = await prisma.device.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      name: true,
      platform: true,
      appVersion: true,
      online: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  return rows;
}

export async function openSession(
  prisma: PrismaClient,
  deviceId: string,
  userId: string,
  appVersion: string,
) {
  return prisma.deviceSession.create({
    data: { deviceId, userId, appVersion, connectedAt: new Date() },
  });
}

export async function closeSession(
  prisma: PrismaClient,
  sessionId: string,
  deviceId: string,
  options: { markOffline?: boolean } = {},
) {
  const s = await prisma.deviceSession.findUnique({ where: { id: sessionId } });
  if (!s || s.disconnectedAt) return;
  const now = new Date();
  const durationSec = Math.max(0, Math.round((now.getTime() - s.connectedAt.getTime()) / 1000));
  await prisma.deviceSession.update({
    where: { id: sessionId },
    data: { disconnectedAt: now, durationSec },
  });
  if (options.markOffline ?? true) {
    await prisma.device.updateMany({ where: { id: deviceId, userId: s.userId }, data: { online: false } });
  }
}
