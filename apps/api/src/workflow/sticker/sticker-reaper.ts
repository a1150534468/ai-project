/**
 * 表情包工坊：卡单 reaper。
 *
 * running 超过阈值未更新心跳 → 置 failed（可由客户端重新触发继续跑，
 * 已落盘的贴纸会跳过）。
 */
import type { PrismaClient } from "@prisma/client";
import { loadStickerStaleTaskMs, STICKER_PACK_STATUS } from "./sticker-shared.js";
import { createStaleScanner } from "../_shared/stale-scanner.js";

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
  // 原子二次校验：查询与更新之间刷过心跳（updatedAt 已更新）的 pack 不会被误杀。
  // 撤销执行权时清空 executionToken：旧 runner 的归属写（要求 running + token）
  // 必然失败，直接退出，不会把 failed 覆盖写回。
  const updated = await prisma.stickerPack.updateMany({
    where: {
      id: { in: stale.map((pack) => pack.id) },
      status: STICKER_PACK_STATUS.running,
      updatedAt: { lt: cutoff },
    },
    data: {
      status: STICKER_PACK_STATUS.failed,
      executionToken: null,
      error: "生成超时未响应，已终止；可重新发起，已完成的贴纸不会重复生成",
      updatedAt: new Date(),
    },
  });
  return { reaped: updated.count, packIds: stale.map((pack) => pack.id) };
}

/**
 * 启动常驻 reaper：进程重启、runner 崩溃后卡在 running 的 pack 由它收尸。
 * 状态机转换是幂等的（updateMany 带 status=running 守卫），多实例同时跑也不会
 * 把同一个 pack 标记两次，所以这里不用 redis 分布式锁。
 */
export function startStickerReaper(args: {
  readonly prisma: PrismaClient;
  readonly env?: NodeJS.ProcessEnv;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}): NodeJS.Timeout {
  // 无锁是刻意的：状态机转换幂等（见上方 reapStickerPacks 的论证），scanner 用 lockKey: null 表达
  return createStaleScanner({
    lockKey: null,
    intervalMs: args.intervalMs ?? 5 * 60 * 1000,
    scan: () => reapStickerPacks(args.prisma, args.env),
    onError: args.onError,
  }).start();
}
