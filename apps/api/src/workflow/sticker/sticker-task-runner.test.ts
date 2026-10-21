/**
 * executionToken 归属协议断言（防重复付费的核心，此前零覆盖）：
 * - 抢不到租约（pack 已被另一轮认领）→ StickerPackStoppedError 直接退出，不做任何生成工作
 * - 认领后执行权被撤销（reaper / /retry 清 token）→ 第一次归属写就失败并退出
 * - 资产已全部落盘时重跑 → 只走参考图读取、零模型调用、零资产写入（不重复付费）
 * - 已完成的 pack 再次 run → 抢不到租约退出
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getObject: vi.fn(),
  getS3: vi.fn(() => ({})),
}));

vi.mock("../../storage/s3.js", () => ({
  getObject: mocks.getObject,
  getS3: mocks.getS3,
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));

import { runStickerPack, StickerPackStoppedError } from "./sticker-task-runner.js";
import { STICKER_PRESETS } from "./sticker-shared.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface FakePackState {
  id: string;
  userId: string;
  requestId: string;
  characterPrompt: string;
  style: string;
  referenceObjectKey: string | null;
  baseImageRequestId: string | null;
  presetKeys: string[];
  status: string;
  completedCount: number;
  failedCount: number;
  executionToken: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makePack(overrides: Partial<FakePackState> = {}): FakePackState {
  return {
    id: "pack-1",
    userId: "user-1",
    requestId: "sticker_req1",
    characterPrompt: "一只猫",
    style: "cute",
    referenceObjectKey: "workflow/stickers/user-1/reference-a.png",
    baseImageRequestId: null,
    presetKeys: STICKER_PRESETS.slice(0, 2).map((preset) => preset.key),
    status: "queued",
    completedCount: 0,
    failedCount: 0,
    executionToken: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * 内存版 prisma：updateMany 严格按 where 的 status / executionToken 条件匹配，
 * 与真库的归属语义一致。revokeAfterClaim=true 时在认领成功后立刻清掉 token，
 * 模拟 reaper 在认领与第一次归属写之间撤销执行权。
 */
function makeFakePrisma(pack: FakePackState, assetIndexes: number[], options: { revokeAfterClaim?: boolean } = {}) {
  const state = { pack: { ...pack } };
  const updateMany = vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const current = state.pack;
    if (current.id !== where.id) return { count: 0 };
    if (where.status !== undefined && current.status !== where.status) return { count: 0 };
    if (where.executionToken !== undefined && current.executionToken !== where.executionToken) return { count: 0 };
    Object.assign(current, data);
    if (options.revokeAfterClaim && typeof data.executionToken === "string") {
      current.executionToken = null;
    }
    return { count: 1 };
  });
  const prisma = {
    stickerPack: {
      updateMany,
      findUnique: vi.fn(async () => ({ ...state.pack, presetKeys: [...state.pack.presetKeys] })),
    },
    imageAsset: {
      findMany: vi.fn(async () => assetIndexes.map((requestIndex) => ({ requestIndex }))),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (fn: (tx: never) => Promise<void>) => fn(prisma as never)),
  };
  return { prisma, state, updateMany };
}

const fetchFn = vi.fn(async () => {
  throw new Error("fetch 不应被调用：本用例不该触发任何模型/下载请求");
}) as unknown as typeof fetch;

describe("executionToken 归属协议", () => {
  it("pack 已被另一轮认领（非 queued）→ 抢不到就退出，不查资产、不生成", async () => {
    const { prisma } = makeFakePrisma(makePack({ status: "running", executionToken: "other-run" }), []);
    mocks.getObject.mockResolvedValue(PNG_BYTES);
    await expect(runStickerPack({ prisma: prisma as never, packId: "pack-1", fetchFn })).rejects.toBeInstanceOf(
      StickerPackStoppedError,
    );
    expect(prisma.imageAsset.findMany).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("认领后执行权被撤销 → 第一次归属写失败即退出", async () => {
    const { prisma } = makeFakePrisma(makePack(), [], { revokeAfterClaim: true });
    mocks.getObject.mockResolvedValue(PNG_BYTES);
    await expect(runStickerPack({ prisma: prisma as never, packId: "pack-1", fetchFn })).rejects.toBeInstanceOf(
      StickerPackStoppedError,
    );
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("资产已全部落盘：重跑零模型调用、零资产写入，直接 completed（不重复付费）", async () => {
    const { prisma, state } = makeFakePrisma(makePack(), [0, 1]);
    mocks.getObject.mockResolvedValue(PNG_BYTES);
    const result = await runStickerPack({ prisma: prisma as never, packId: "pack-1", fetchFn });
    expect(result.status).toBe("completed");
    expect(state.pack.status).toBe("completed");
    // 只读了参考图（S3 getObject），没有走 fetch（模型调用/下载都经 fetchFn）
    expect(mocks.getObject).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(prisma.imageAsset.upsert).not.toHaveBeenCalled();
  });

  it("已完成的 pack 再次 run → 抢不到租约退出（重复提交不重复计费）", async () => {
    const { prisma } = makeFakePrisma(makePack({ status: "completed", executionToken: null }), [0, 1]);
    await expect(runStickerPack({ prisma: prisma as never, packId: "pack-1", fetchFn })).rejects.toBeInstanceOf(
      StickerPackStoppedError,
    );
    expect(prisma.imageAsset.upsert).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
