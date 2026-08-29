/**
 * 拆分 image-routes.ts 时抽出的结算层：把「按实际交付档位算钱 + 落 billingStatus」
 * 和「扫出漏账的行补结算」两件事收在一起。
 *
 * 只依赖类型层与 image-shared 的常量，不 import helpers / task-runner；
 * task-runner 与插件都从这里 import，方向单向。
 */

import type { PrismaClient } from "@prisma/client";
import {
  imageGenerationResourceKey,
  imageResolutionFromSize,
  imageSizeForResolution,
} from "../_shared/image-upstream-options.js";
import { deliveredImageResolution, minDeliveredPixels, pixelsFromSize } from "../_shared/image-delivered-tier.js";
import { resolveImageChargeRow } from "../_shared/workflow-pricing.js";
import { IMAGE_TASK_STATUS, SETTLING_STALE_MS, type ImageGenerationTaskRow } from "./image-shared.js";
import type { BillingForImages } from "./image-route-types.js";

export type ImageTaskTerminalReason = "completed" | "failed" | "cancelled";

/**
 * 任务终态统一结算（完成 / 失败 / 取消共用）：
 * - reserve 任务：先原子认领（reserved/settle_failed → settling），并发调用只有 count===1 的一方真正结算；
 *   按实际入库张数结算；0 张则整单退款；计费接口出错记 settle_failed，由对账重试。
 * - legacy charge 任务（升级前创建、已先扣费）：完全保留旧语义——失败全额退款，取消仅在 0 张时退款。
 */
/**
 * 按实际交付像素定结算档位：中转上游常常只认宽高比、忽略绝对像素，
 * 请求 2K 却回 1K 尺寸时若按请求档收就是多收一倍。取一批图里最小的那张，宁可少收。
 */
export async function resolveImageSettleKey(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
  readonly task: ImageGenerationTaskRow;
  readonly outputs: readonly { readonly width: number | null; readonly height: number | null }[];
  readonly requestedKey: string;
}): Promise<{ readonly resourceKey: string }> {
  const fallback = { resourceKey: args.requestedKey };
  try {
    const requested = imageResolutionFromSize(args.task.size);
    const settled = deliveredImageResolution({
      requested,
      deliveredPixels: minDeliveredPixels(args.outputs.map((output) => `${output.width ?? 0}x${output.height ?? 0}`)),
      pixelsForResolution: (resolution) => pixelsFromSize(imageSizeForResolution(args.task.size, resolution)),
    });
    if (settled === requested) return fallback;
    const rows = args.billing.listResourcePrices ? (await args.billing.listResourcePrices()).data ?? [] : [];
    const row = resolveImageChargeRow(rows, { resolution: settled, model: args.task.model });
    return { resourceKey: row.resourceKey };
  } catch {
    return fallback;
  }
}

export async function settleImageTaskBilling(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
  readonly taskId: string;
  readonly reason: ImageTaskTerminalReason;
  readonly onBillingError?: (error: unknown, operationId: string) => void;
}): Promise<void> {
  const { prisma, billing } = args;
  const current = await prisma.imageGenerationTask.findUnique({ where: { id: args.taskId } }) as unknown as ImageGenerationTaskRow | null;
  if (!current) return;
  const operationId = `image:${current.requestId}`;
  if (current.billingMode !== "reserve") {
    const legacyStored = await prisma.imageAsset.findMany({
      where: { userId: current.userId, requestId: current.requestId },
      select: { id: true },
    });
    if (args.reason === "failed" || (args.reason === "cancelled" && legacyStored.length === 0)) {
      await billing.refundResource(operationId).catch((error) => args.onBillingError?.(error, operationId));
    }
    return;
  }
  const claimed = await prisma.imageGenerationTask.updateMany({
    where: { id: current.id, billingStatus: { in: ["reserved", "settle_failed"] } },
    data: { billingStatus: "settling" },
  });
  if (claimed.count !== 1) return;
  try {
    // 以真实入库的图片数为准，不信任内存里的 completedCount
    const storedImages = await prisma.imageAsset.findMany({
      where: { userId: current.userId, requestId: current.requestId },
      select: { id: true, width: true, height: true },
    });
    const completedCount = storedImages.length;
    if (completedCount > 0) {
      const requestedKey = current.billingResourceKey
        ?? imageGenerationResourceKey(imageResolutionFromSize(current.size));
      const settle = await resolveImageSettleKey({ prisma, billing, task: current, outputs: storedImages, requestedKey });
      await billing.settleResource({ operationId, resourceKey: settle.resourceKey, units: completedCount });
      await prisma.imageGenerationTask.update({
        where: { id: current.id },
        data: { billingStatus: "settled", billingSettledUnits: completedCount, billingResourceKey: settle.resourceKey },
      });
    } else {
      await billing.refundResource(operationId);
      await prisma.imageGenerationTask.update({
        where: { id: current.id },
        data: { billingStatus: "refunded", billingSettledUnits: 0 },
      });
    }
  } catch (error) {
    args.onBillingError?.(error, operationId);
    await prisma.imageGenerationTask.update({
      where: { id: current.id },
      data: { billingStatus: "settle_failed" },
    }).catch(() => undefined);
  }
}

export function terminalReasonOf(status: string): ImageTaskTerminalReason | null {
  if (status === IMAGE_TASK_STATUS.completed) return "completed";
  if (status === IMAGE_TASK_STATUS.failed) return "failed";
  if (status === IMAGE_TASK_STATUS.cancelled) return "cancelled";
  return null;
}

/**
 * 对账：终态但预留未落地的任务（settle_failed / 崩在 settling / 状态已写但结算前进程挂掉留下的 reserved）
 * 重跑一次统一结算。operationId 由 requestId 决定，重放对计费侧是幂等的。
 */
export async function reconcilePendingImageBilling(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
  readonly tasks: readonly ImageGenerationTaskRow[];
  readonly nowMs?: number;
  readonly onReconcile?: (task: ImageGenerationTaskRow) => void;
  readonly onBillingError?: (task: ImageGenerationTaskRow, error: unknown, operationId: string) => void;
}): Promise<number> {
  const nowMs = args.nowMs ?? Date.now();
  const pending = args.tasks.filter((task) => {
    if (task.billingMode !== "reserve") return false;
    if (!terminalReasonOf(task.status)) return false;
    if (task.billingStatus === "reserved" || task.billingStatus === "settle_failed") return true;
    return task.billingStatus === "settling" && nowMs - task.updatedAt.getTime() >= SETTLING_STALE_MS;
  });
  if (pending.length === 0) return 0;
  const reconciled = await Promise.all(pending.map(async (task) => {
    if (task.billingStatus === "settling") {
      // 只有确实卡住的 settling 才回退，避免抢走仍在结算的调用方
      const released = await args.prisma.imageGenerationTask.updateMany({
        where: {
          id: task.id,
          billingStatus: "settling",
          updatedAt: { lt: new Date(nowMs - SETTLING_STALE_MS) },
        },
        data: { billingStatus: "reserved" },
      });
      if (released.count !== 1) return 0;
    }
    args.onReconcile?.(task);
    await settleImageTaskBilling({
      prisma: args.prisma,
      billing: args.billing,
      taskId: task.id,
      reason: terminalReasonOf(task.status) ?? "failed",
      onBillingError: (error, operationId) => args.onBillingError?.(task, error, operationId),
    }).catch(() => undefined);
    return 1;
  }));
  return reconciled.reduce<number>((sum, value) => sum + value, 0);
}
