import { describe, it, expect, vi } from "vitest";
import { startVideoCreate } from "./dub-video-service.js";

function base() {
  const prisma = {
    avatar: { findFirst: vi.fn().mockResolvedValue({ id: "av-row", userId: "u1", avatarCode: "av_x" }) },
    skyhumanTask: { create: vi.fn().mockResolvedValue({ id: "t1" }), findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
  } as any;
  const billing = { chargeResource: vi.fn().mockResolvedValue({ charged: 100 }), settleVideoResource: vi.fn(), refundResource: vi.fn() } as any;
  return { prisma, billing };
}

describe("dub-video-service", () => {
  it("avatar 非本人 → 抛错，不收费", async () => {
    const { prisma, billing } = base();
    prisma.avatar.findFirst.mockResolvedValue(null);
    await expect(startVideoCreate({
      prisma, billing, redis: {} as any, cfg: {} as any, fetchFn: vi.fn(),
      userId: "u1", avatarId: "av-row", title: "t", audioBuffer: Buffer.from("x"), audioMime: "audio/mpeg",
      probeDurationSec: vi.fn().mockResolvedValue(30), storeVideo: vi.fn(), scheduleTask: vi.fn(),
    })).rejects.toThrow(/形象不存在/);
    expect(billing.chargeResource).not.toHaveBeenCalled();
  });

  it("按音频秒数收费·视频点，建任务并排后台", async () => {
    const { prisma, billing } = base();
    const scheduleTask = vi.fn();
    const task = await startVideoCreate({
      prisma, billing, redis: {} as any, cfg: {} as any, fetchFn: vi.fn(),
      userId: "u1", avatarId: "av-row", title: "t", audioBuffer: Buffer.from("x"), audioMime: "audio/mpeg",
      probeDurationSec: vi.fn().mockResolvedValue(30), storeVideo: vi.fn(), scheduleTask,
    });
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "dub_video_sec", units: 30, accountType: "video" }));
    expect(task.id).toBe("t1");
    expect(scheduleTask).toHaveBeenCalled();
  });
});
