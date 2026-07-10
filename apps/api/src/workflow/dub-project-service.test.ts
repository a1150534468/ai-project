import { describe, it, expect, vi } from "vitest";
import { listProjects, getProject, patchProject, deleteProject, finalizeProjectVideo, assertReadyForGenerate } from "./dub-project-service.js";

describe("dub-project-service 隔离", () => {
  it("listProjects 只查本人", async () => {
    const prisma = { dubProject: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await listProjects(prisma, "u1");
    expect(prisma.dubProject.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
  });
  it("getProject 越权返回 null", async () => {
    const prisma = { dubProject: { findFirst: vi.fn().mockResolvedValue(null) } } as any;
    expect(await getProject(prisma, "u1", "p1")).toBeNull();
    expect(prisma.dubProject.findFirst).toHaveBeenCalledWith({ where: { id: "p1", userId: "u1" } });
  });
  it("patchProject 越权 count=0 返回 false", async () => {
    const prisma = { dubProject: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } } as any;
    expect(await patchProject(prisma, "u1", "p1", { script: "x" })).toBe(false);
  });
  it("patchProject 丢弃白名单外字段（防注入 userId/finalVideoUrl）", async () => {
    const prisma = { dubProject: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } } as any;
    await patchProject(prisma, "u1", "p1", { script: "x", userId: "hacker", finalVideoUrl: "evil" } as any);
    const data = prisma.dubProject.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({ script: "x" });
  });
  it("patchProject 无可更新字段返回 false", async () => {
    const prisma = { dubProject: { updateMany: vi.fn() } } as any;
    expect(await patchProject(prisma, "u1", "p1", { userId: "x" } as any)).toBe(false);
    expect(prisma.dubProject.updateMany).not.toHaveBeenCalled();
  });
  it("deleteProject 按 userId 限定", async () => {
    const prisma = { dubProject: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) } } as any;
    expect(await deleteProject(prisma, "u1", "p1")).toBe(true);
    expect(prisma.dubProject.deleteMany).toHaveBeenCalledWith({ where: { id: "p1", userId: "u1" } });
  });
});

describe("assertReadyForGenerate", () => {
  it("缺音频抛错", () => {
    expect(() => assertReadyForGenerate({ audioObjectKey: null, avatarId: "a" })).toThrow(/配音/);
  });
  it("缺形象抛错", () => {
    expect(() => assertReadyForGenerate({ audioObjectKey: "k", avatarId: null })).toThrow(/形象/);
  });
  it("齐备不抛错", () => {
    expect(() => assertReadyForGenerate({ audioObjectKey: "k", avatarId: "a" })).not.toThrow();
  });
});

describe("finalizeProjectVideo", () => {
  function deps(project: any) {
    return { prisma: { dubProject: { findUnique: vi.fn().mockResolvedValue(project), update: vi.fn().mockResolvedValue({}) } } as any };
  }
  const base = { id: "p1", userId: "u1", bgmObjectKey: null, bgmPresetId: null, bgmVolume: 0.3 };

  it("无 BGM：finalVideoUrl = 原片，stage=done，不调 ffmpeg", async () => {
    const d = deps(base);
    const mix = vi.fn();
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "https://v/1.mp4", videoObjectKey: "k",
      resolveBgmKey: vi.fn().mockResolvedValue(null), getObject: vi.fn(), storeVideoBuffer: vi.fn(), mixFn: mix });
    expect(mix).not.toHaveBeenCalled();
    expect(d.prisma.dubProject.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "done", finalVideoUrl: "https://v/1.mp4" }),
    }));
  });

  it("有 BGM：下载→混流→转存→stage=done", async () => {
    const d = deps({ ...base, bgmObjectKey: "bgm/k.mp3" });
    const mix = vi.fn().mockResolvedValue(Buffer.from("mixed"));
    const store = vi.fn().mockResolvedValue({ url: "https://our/final.mp4", objectKey: "fk" });
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "https://v/1.mp4", videoObjectKey: "k",
      resolveBgmKey: vi.fn().mockResolvedValue("bgm/k.mp3"), getObject: vi.fn().mockResolvedValue(Buffer.from("x")), storeVideoBuffer: store, mixFn: mix });
    expect(mix).toHaveBeenCalled();
    expect(d.prisma.dubProject.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "done", finalVideoUrl: "https://our/final.mp4" }),
    }));
  });

  it("混流失败：stage=failed，保留无 BGM 原片可下载，不抛出", async () => {
    const d = deps({ ...base, bgmObjectKey: "bgm/k.mp3" });
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "https://v/1.mp4", videoObjectKey: "k",
      resolveBgmKey: vi.fn().mockResolvedValue("bgm/k.mp3"), getObject: vi.fn().mockResolvedValue(Buffer.from("x")),
      storeVideoBuffer: vi.fn(), mixFn: vi.fn().mockRejectedValue(new Error("ffmpeg boom")) });
    const data = d.prisma.dubProject.update.mock.calls[0][0].data;
    expect(data.stage).toBe("failed");
    expect(data.resultVideoUrl).toBe("https://v/1.mp4");
    expect(String(data.error)).toContain("ffmpeg boom");
  });

  it("项目不存在直接返回，不更新", async () => {
    const d = deps(null);
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "u", videoObjectKey: "k",
      resolveBgmKey: vi.fn(), getObject: vi.fn(), storeVideoBuffer: vi.fn(), mixFn: vi.fn() });
    expect(d.prisma.dubProject.update).not.toHaveBeenCalled();
  });
});
