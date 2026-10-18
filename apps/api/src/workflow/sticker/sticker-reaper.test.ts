import { describe, expect, it, vi } from "vitest";
import { reapStickerPacks } from "./sticker-reaper.js";

function fakePrisma(ids: string[], updateCount = 1) {
  const stickerPack = {
    findMany: vi.fn(async (_args: { where: unknown; select: unknown; take: number }) =>
      ids.map((id) => ({ id })),
    ),
    updateMany: vi.fn(async (_args: { where: unknown; data: unknown }) => ({ count: updateCount })),
  };
  return { prisma: { stickerPack } as never, stickerPack };
}

describe("reapStickerPacks", () => {
  it("更新时带上 updatedAt < cutoff 二次校验，避免误杀刚刷过心跳的任务", async () => {
    const { prisma, stickerPack } = fakePrisma(["p1"]);
    const env = { STICKER_STALE_TASK_MS: "60000" } as NodeJS.ProcessEnv;

    await reapStickerPacks(prisma, env);

    const updateWhere = stickerPack.updateMany.mock.calls[0]![0].where as {
      id: { in: string[] };
      status: string;
      updatedAt: { lt: Date };
    };
    expect(updateWhere.id).toEqual({ in: ["p1"] });
    expect(updateWhere.status).toBe("running");
    // 关键：更新语句里必须有 updatedAt < cutoff，否则查询与更新之间的心跳会被误杀
    expect(updateWhere.updatedAt.lt).toBeInstanceOf(Date);
    const findWhere = stickerPack.findMany.mock.calls[0]![0].where as {
      updatedAt: { lt: Date };
    };
    expect(updateWhere.updatedAt.lt.getTime()).toBe(findWhere.updatedAt.lt.getTime());
  });

  it("返回实际更新的行数，而非候选数", async () => {
    const { prisma } = fakePrisma(["p1", "p2"], 1);
    const result = await reapStickerPacks(prisma, { STICKER_STALE_TASK_MS: "60000" } as NodeJS.ProcessEnv);
    expect(result.reaped).toBe(1);
  });

  it("没有超期任务时不写库", async () => {
    const { prisma, stickerPack } = fakePrisma([]);
    const result = await reapStickerPacks(prisma, { STICKER_STALE_TASK_MS: "60000" } as NodeJS.ProcessEnv);
    expect(result.reaped).toBe(0);
    expect(stickerPack.updateMany).not.toHaveBeenCalled();
  });
});
