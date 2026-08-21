import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@ai-assistant/db";
import type { Redis } from "ioredis";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import * as skyClient from "./dub-skyhuman-client.js";
import { pollFinalize, type AvatarBilling, type StoreVideoFn } from "./dub-avatar-service.js";
import { acquireSkySlot, releaseSkySlot } from "./dub-concurrency.js";
import { DUB_VIDEO_SEC_KEY, DUB_TASK_KIND, DUB_TASK_STATUS, DUB_SKY_MAX_INFLIGHT } from "./dub-constants.js";

export interface StartVideoCreateArgs {
  prisma: PrismaClient; redis: Redis; billing: AvatarBilling; cfg: SkyhumanConfig; fetchFn: FetchLike;
  userId: string; avatarId: string; title: string; audioBuffer: Buffer; audioMime: string;
  projectId?: string;
  probeDurationSec: (buf: Buffer) => Promise<number>;
  storeVideo: StoreVideoFn;
  finalizeProject?: (a: { projectId: string; videoUrl: string; videoObjectKey: string }) => Promise<void>;
  scheduleTask: (fn: () => Promise<void>) => void;
}

export async function startVideoCreate(args: StartVideoCreateArgs) {
  const avatar = await args.prisma.avatar.findFirst({ where: { id: args.avatarId, userId: args.userId } });
  if (!avatar) throw new Error("形象不存在或无权使用");
  const seconds = Math.max(1, Math.ceil(await args.probeDurationSec(args.audioBuffer)));
  const operationId = `dub-video:${randomUUID()}`;
  const charged = await args.billing.chargeResource({ operationId, userId: args.userId, resourceKey: DUB_VIDEO_SEC_KEY, units: seconds, accountType: "video" });
  let task;
  try {
    task = await args.prisma.skyhumanTask.create({
      data: { userId: args.userId, kind: DUB_TASK_KIND.videoCreate, avatarId: avatar.id, status: DUB_TASK_STATUS.running, resourceKey: DUB_VIDEO_SEC_KEY, operationId, chargedPoints: charged.charged, title: args.title, ...(args.projectId ? { projectId: args.projectId } : {}) },
    });
  } catch (e) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw e;
  }
  args.scheduleTask(() => runVideoCreate({ ...args, task, avatarCode: avatar.avatarCode }));
  return task;
}

async function runVideoCreate(args: StartVideoCreateArgs & { task: { id: string }; avatarCode: string }): Promise<void> {
  if (!(await acquireSkySlot(args.redis, DUB_SKY_MAX_INFLIGHT))) return; // 触顶留 running，reaper 补
  try {
    const ext = args.audioMime.includes("wav") ? "wav" : "mp3";
    const up = await skyClient.createUploadUrl(args.cfg, args.fetchFn, ext);
    await skyClient.putToPresigned(args.fetchFn, up.uploadUrl, up.contentType, args.audioBuffer);
    const submitted = await skyClient.createVideoByAudio(args.cfg, args.fetchFn, { avatar: args.avatarCode, fileId: up.fileId, title: args.task.id });
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { providerTaskId: submitted.taskId } });
    await pollFinalize({ prisma: args.prisma, billing: args.billing, cfg: args.cfg, fetchFn: args.fetchFn, taskId: args.task.id, storeVideo: args.storeVideo, finalizeProject: args.finalizeProject });
  } catch (e) {
    const row = await args.prisma.skyhumanTask.findUnique({ where: { id: args.task.id }, select: { operationId: true } });
    if (row) await args.billing.refundResource(row.operationId).catch(() => undefined);
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { status: DUB_TASK_STATUS.failed, error: (e as Error).message } }).catch(() => undefined);
  } finally {
    await releaseSkySlot(args.redis);
  }
}
