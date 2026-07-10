import type { PrismaClient } from "@yc/db";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import * as skyClient from "./dub-skyhuman-client.js";
import { DUB_TASK_STATUS, DUB_TASK_KIND } from "./dub-constants.js";

export interface FinalizeBilling {
  settleVideoResource: (a: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}
export interface StoredVideo { url: string; objectKey: string }

export interface FinalizeArgs {
  prisma: PrismaClient;
  billing: FinalizeBilling;
  cfg: SkyhumanConfig;
  fetchFn: FetchLike;
  taskId: string;
  sky?: Pick<typeof skyClient, "getVideoTask" | "getAvatarTask">; // 测试注入
  storeVideo: (args: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>;
  // 任务隶属某个 DubProject 时的收尾（叠 BGM）。内部自吞异常，绝不影响任务终态与计费。
  finalizeProject?: (a: { projectId: string; videoUrl: string; videoObjectKey: string }) => Promise<void>;
}

// 幂等：仅当 status=running 才推进；完成/失败已是终态直接返回。
export async function finalizeSkyhumanTask(args: FinalizeArgs): Promise<void> {
  const sky = args.sky ?? skyClient;
  const task = await args.prisma.skyhumanTask.findUnique({ where: { id: args.taskId } });
  if (!task || task.status !== DUB_TASK_STATUS.running) return;
  if (!task.providerTaskId) return; // 尚未提交上游，交给后台/下一轮

  if (task.kind === DUB_TASK_KIND.avatarClone) {
    const st = await sky.getAvatarTask(args.cfg, args.fetchFn, task.providerTaskId);
    if (st.status === "running") return;
    if (st.status === "failed" || !st.avatarCode) {
      await args.billing.refundResource(task.operationId).catch(() => undefined);
      await markFailed(args.prisma, task.id, st.message || "数字人克隆失败");
      return;
    }
    const avatar = await args.prisma.avatar.create({
      data: { userId: task.userId, avatarCode: st.avatarCode, title: task.title, sourceObjectKey: task.audioObjectKey ?? null },
    });
    await args.prisma.skyhumanTask.update({
      where: { id: task.id },
      data: { status: DUB_TASK_STATUS.completed, avatarId: avatar.id, resultPayload: { avatarCode: st.avatarCode }, completedAt: new Date(), error: null },
    });
    return;
  }

  // video_create
  const st = await sky.getVideoTask(args.cfg, args.fetchFn, task.providerTaskId);
  if (st.status === "running") return;
  if (st.status === "failed" || !st.videoUrl) {
    await args.billing.refundResource(task.operationId).catch(() => undefined);
    await markFailed(args.prisma, task.id, st.message || "视频生成失败");
    return;
  }
  const stored = await args.storeVideo({ url: st.videoUrl, userId: task.userId, taskId: task.id });
  if (st.duration && st.duration > 0) {
    await args.billing.settleVideoResource({ operationId: task.operationId, resourceKey: task.resourceKey, units: st.duration }).catch(() => undefined);
  }
  await args.prisma.skyhumanTask.update({
    where: { id: task.id },
    data: { status: DUB_TASK_STATUS.completed, resultPayload: { videoUrl: stored.url, objectKey: stored.objectKey, duration: st.duration ?? 0, cost: st.cost ?? 0 }, completedAt: new Date(), error: null },
  });
  // 属于某个项目：交给项目收尾（叠 BGM）。失败不回滚任务终态，也不退款（视频已交付并结算）。
  if (task.projectId && args.finalizeProject) {
    await args.finalizeProject({ projectId: task.projectId, videoUrl: stored.url, videoObjectKey: stored.objectKey }).catch(() => undefined);
  }
}

async function markFailed(prisma: PrismaClient, id: string, error: string): Promise<void> {
  await prisma.skyhumanTask.update({ where: { id }, data: { status: DUB_TASK_STATUS.failed, error } }).catch(() => undefined);
}
