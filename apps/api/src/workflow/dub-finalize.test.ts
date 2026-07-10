import { describe, it, expect, vi } from "vitest";
import { finalizeSkyhumanTask } from "./dub-finalize.js";

function deps(overrides: any = {}) {
  const task = { id: "t1", userId: "u1", kind: "video_create", status: "running", operationId: "op1", resourceKey: "dub_video_sec", providerTaskId: "p1", avatarId: "av-row", projectId: null, title: "x", audioObjectKey: null, ...overrides.task };
  const prisma = {
    skyhumanTask: {
      findUnique: vi.fn().mockResolvedValue(task),
      update: vi.fn().mockResolvedValue({}),
    },
    avatar: { create: vi.fn().mockResolvedValue({ id: "new-av" }) },
  };
  const billing = { settleVideoResource: vi.fn().mockResolvedValue({ settled: 10 }), refundResource: vi.fn().mockResolvedValue({ success: true }) };
  return { prisma: prisma as any, billing: billing as any };
}

describe("finalizeSkyhumanTask", () => {
  it("video 完成：转存+按真实 duration settle+标记 completed", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "completed", videoUrl: "https://v/1.mp4", duration: 30 }), getAvatarTask: vi.fn() };
    const storeVideo = vi.fn().mockResolvedValue({ url: "https://our/1.mp4", objectKey: "k" });
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo });
    expect(d.billing.settleVideoResource).toHaveBeenCalledWith({ operationId: "op1", resourceKey: "dub_video_sec", units: 30 });
    expect(d.prisma.skyhumanTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }));
  });

  it("video 失败：refund + 标记 failed", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "failed" }), getAvatarTask: vi.fn() };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(d.billing.refundResource).toHaveBeenCalledWith("op1");
    expect(d.prisma.skyhumanTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
  });

  it("非 running（已终结）直接返回不重复处理", async () => {
    const d = deps({ task: { status: "completed" } });
    const sky = { getVideoTask: vi.fn(), getAvatarTask: vi.fn() };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(sky.getVideoTask).not.toHaveBeenCalled();
  });

  it("仍 running（上游处理中）不落终态", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "running" }), getAvatarTask: vi.fn() };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(d.prisma.skyhumanTask.update).not.toHaveBeenCalled();
  });

  it("video 完成且任务属于项目：调用项目收尾钩子", async () => {
    const d = deps({ task: { projectId: "p1" } });
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "completed", videoUrl: "https://v/1.mp4", duration: 30 }), getAvatarTask: vi.fn() };
    const finalizeProject = vi.fn().mockResolvedValue(undefined);
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn().mockResolvedValue({ url: "https://our/1.mp4", objectKey: "k" }), finalizeProject });
    expect(finalizeProject).toHaveBeenCalledWith({ projectId: "p1", videoUrl: "https://our/1.mp4", videoObjectKey: "k" });
  });

  it("无 projectId 时不调项目收尾钩子", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "completed", videoUrl: "https://v/1.mp4", duration: 30 }), getAvatarTask: vi.fn() };
    const finalizeProject = vi.fn();
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn().mockResolvedValue({ url: "u", objectKey: "k" }), finalizeProject });
    expect(finalizeProject).not.toHaveBeenCalled();
  });

  it("项目收尾钩子抛错不影响任务已 completed", async () => {
    const d = deps({ task: { projectId: "p1" } });
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "completed", videoUrl: "https://v/1.mp4", duration: 30 }), getAvatarTask: vi.fn() };
    const finalizeProject = vi.fn().mockRejectedValue(new Error("mix boom"));
    await expect(finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn().mockResolvedValue({ url: "u", objectKey: "k" }), finalizeProject })).resolves.toBeUndefined();
    expect(d.prisma.skyhumanTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }));
  });

  it("avatar 失败：把飞天的真实原因写进 error，而不是笼统的「克隆失败」", async () => {
    const d = deps({ task: { kind: "avatar_clone", resourceKey: "dub_avatar_clone" } });
    const sky = { getAvatarTask: vi.fn().mockResolvedValue({ status: "failed", message: "视频中未检测到人脸" }), getVideoTask: vi.fn() };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(d.billing.refundResource).toHaveBeenCalledWith("op1");
    expect(d.prisma.skyhumanTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", error: "视频中未检测到人脸" }),
    }));
  });

  it("video 失败：同样透出飞天原因", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "failed", message: "音频时长超限" }), getAvatarTask: vi.fn() };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(d.prisma.skyhumanTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", error: "音频时长超限" }),
    }));
  });

  it("avatar 完成：建 Avatar 行 + 标记 completed", async () => {
    const d = deps({ task: { kind: "avatar_clone", resourceKey: "dub_avatar_clone" } });
    const sky = { getAvatarTask: vi.fn().mockResolvedValue({ status: "completed", avatarCode: "av_abc" }), getVideoTask: vi.fn() };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(d.prisma.avatar.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: "u1", avatarCode: "av_abc" }) }));
  });
});
