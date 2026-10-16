/**
 * 表情包工坊：卡单 reaper。
 *
 * running 超过阈值未更新心跳 → 置 failed（可由客户端重新触发继续跑，
 * 已落盘的贴纸会跳过）。
 */
import type { PrismaClient } from "@prisma/client";
import { loadStickerStaleTaskMs, STICKER_PACK_STATUS } from "./sticker-shared.js";

export interface ReapStickerPacksResult {
  readonly reaped: number;
  readonly packIds: readonly string[];
}

export async function reapStickerPacks(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReapStickerPacksResult> {
  const staleMs = loadStickerStaleTaskMs(env);
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await prisma.stickerPack.findMany({
    where: { status: STICKER_PACK_STATUS.running, updatedAt: { lt: cutoff } },
    select: { id: true },
    take: 50,
  });
  if (stale.length === 0) return { reaped: 0, packIds: [] };
  await prisma.stickerPack.updateMany({
    where: { id: { in: stale.map((pack) => pack.id) }, status: STICKER_PACK_STATUS.running },
    data: {
      status: STICKER_PACK_STATUS.failed,
      error: "生成超时未响应，已终止；可重新发起，已完成的贴纸不会重复生成",
      updatedAt: new Date(),
    },
  });
  return { reaped: stale.length, packIds: stale.map((pack) => pack.id) };
}
