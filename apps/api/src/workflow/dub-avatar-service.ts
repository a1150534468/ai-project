import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@yc/db";
import type { Redis } from "ioredis";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import * as skyClient from "./dub-skyhuman-client.js";
import { finalizeSkyhumanTask, type FinalizeBilling, type StoredVideo } from "./dub-finalize.js";
import { acquireSkySlot, releaseSkySlot } from "./dub-concurrency.js";
import { DUB_AVATAR_CLONE_KEY, DUB_TASK_KIND, DUB_TASK_STATUS, DUB_SKY_MAX_INFLIGHT } from "./dub-constants.js";

export interface AvatarBilling extends FinalizeBilling {
  chargeResource: (a: { operationId: string; userId: string; resourceKey: string; units: number; accountType: "points" | "video" }) => Promise<{ charged: number }>;
}

export type StoreVideoFn = (a: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>;

export async function listAvatars(prisma: PrismaClient, userId: string) {
  return prisma.avatar.findMany({ where: { userId }, orderBy: [{ isFavorite: "desc" }, { createdAt: "desc" }] });
}

export async function setAvatarFavorite(prisma: PrismaClient, userId: string, avatarId: string, favorite: boolean): Promise<boolean> {
  const r = await prisma.avatar.updateMany({ where: { id: avatarId, userId }, data: { isFavorite: favorite } });
  return r.count > 0;
}

export async function removeAvatar(args: { prisma: PrismaClient; cfg: SkyhumanConfig; fetchFn: FetchLike; sky?: Pick<typeof skyClient, "deleteAvatar">; userId: string; avatarId: string }): Promise<boolean> {
  const sky = args.sky ?? skyClient;
  const row = await args.prisma.avatar.findFirst({ where: { id: args.avatarId, userId: args.userId } });
  if (!row) return false;
  await sky.deleteAvatar(args.cfg, args.fetchFn, row.avatarCode).catch(() => undefined); // 飞天删失败不阻断本地清理
  await args.prisma.avatar.delete({ where: { id: row.id } });
  return true;
}

export interface StartAvatarCloneArgs {
  prisma: PrismaClient; redis: Redis; billing: AvatarBilling; cfg: SkyhumanConfig; fetchFn: FetchLike;
  userId: string; title: string; buffer: Buffer; mime: string;
  storeVideo: StoreVideoFn;
  scheduleTask: (fn: () => Promise<void>) => void;
}

// 收费(按次·视频点)→建任务→后台执行。返回任务行供路由 202 响应。
export async function startAvatarClone(args: StartAvatarCloneArgs) {
  const operationId = `dub-avatar:${randomUUID()}`;
  const charged = await args.billing.chargeResource({ operationId, userId: args.userId, resourceKey: DUB_AVATAR_CLONE_KEY, units: 1, accountType: "video" });
  let task;
  try {
    task = await args.prisma.skyhumanTask.create({
      data: { userId: args.userId, kind: DUB_TASK_KIND.avatarClone, status: DUB_TASK_STATUS.running, resourceKey: DUB_AVATAR_CLONE_KEY, operationId, chargedPoints: charged.charged, title: args.title },
    });
  } catch (e) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw e;
  }
  args.scheduleTask(() => runAvatarClone({ ...args, task }));
  return task;
}

async function runAvatarClone(args: StartAvatarCloneArgs & { task: { id: string } }): Promise<void> {
  const ext = args.mime.includes("quicktime") ? "mov" : "mp4";
  if (!(await acquireSkySlot(args.redis, DUB_SKY_MAX_INFLIGHT))) {
    // 触顶：留 running，交给 reaper 下轮重试提交（此处直接返回不占位）
    return;
  }
  try {
    const up = await skyClient.createUploadUrl(args.cfg, args.fetchFn, ext);
    await skyClient.putToPresigned(args.fetchFn, up.uploadUrl, up.contentType, args.buffer);
    const submitted = await skyClient.createAvatarByVideo(args.cfg, args.fetchFn, { title: args.title, fileId: up.fileId });
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { providerTaskId: submitted.taskId } });
    await pollFinalize({ prisma: args.prisma, billing: args.billing, cfg: args.cfg, fetchFn: args.fetchFn, taskId: args.task.id, storeVideo: args.storeVideo });
  } catch (e) {
    const row = await args.prisma.skyhumanTask.findUnique({ where: { id: args.task.id }, select: { operationId: true } });
    if (row) await args.billing.refundResource(row.operationId).catch(() => undefined);
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { status: DUB_TASK_STATUS.failed, error: (e as Error).message } }).catch(() => undefined);
  } finally {
    await releaseSkySlot(args.redis);
  }
}

// 有界轮询，每次调幂等 finalize；到终态即停。留 reaper 兜底超时。
export async function pollFinalize(args: { prisma: PrismaClient; billing: FinalizeBilling; cfg: SkyhumanConfig; fetchFn: FetchLike; taskId: string; storeVideo: StoreVideoFn; finalizeProject?: (a: { projectId: string; videoUrl: string; videoObjectKey: string }) => Promise<void>; maxAttempts?: number; intervalMs?: number }): Promise<void> {
  const maxAttempts = args.maxAttempts ?? 60;
  const intervalMs = args.intervalMs ?? 10_000;
  for (let i = 0; i < maxAttempts; i++) {
    await finalizeSkyhumanTask(args);
    const t = await args.prisma.skyhumanTask.findUnique({ where: { id: args.taskId }, select: { status: true } });
    if (!t || t.status !== DUB_TASK_STATUS.running) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
