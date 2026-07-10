import { describe, it, expect, vi } from "vitest";
import { listEnabledBgmPresets, listAllBgmPresets, createBgmPreset, deleteBgmPreset, resolveBgmObjectKey } from "./dub-bgm-service.js";

describe("dub-bgm-service", () => {
  it("用户端只列启用的预制，按 sortOrder", async () => {
    const prisma = { dubBgmPreset: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await listEnabledBgmPresets(prisma);
    expect(prisma.dubBgmPreset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    }));
  });

  it("admin 列全部（含停用）", async () => {
    const prisma = { dubBgmPreset: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await listAllBgmPresets(prisma);
    expect(prisma.dubBgmPreset.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("createBgmPreset 落库", async () => {
    const prisma = { dubBgmPreset: { create: vi.fn().mockResolvedValue({ id: "b1" }) } } as any;
    const r = await createBgmPreset(prisma, { title: "轻快", url: "u", objectKey: "k", sortOrder: 1 });
    expect(r.id).toBe("b1");
  });

  it("deleteBgmPreset 不存在返回 false", async () => {
    const prisma = { dubBgmPreset: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } } as any;
    expect(await deleteBgmPreset(prisma, "x")).toBe(false);
  });

  describe("resolveBgmObjectKey", () => {
    it("优先用用户上传的 objectKey", async () => {
      const prisma = { dubBgmPreset: { findUnique: vi.fn() } } as any;
      const k = await resolveBgmObjectKey(prisma, { bgmObjectKey: "user/k.mp3", bgmPresetId: "p1" });
      expect(k).toBe("user/k.mp3");
      expect(prisma.dubBgmPreset.findUnique).not.toHaveBeenCalled();
    });
    it("否则查预制；预制停用视为无 BGM", async () => {
      const prisma = { dubBgmPreset: { findUnique: vi.fn().mockResolvedValue({ objectKey: "p.mp3", enabled: false }) } } as any;
      expect(await resolveBgmObjectKey(prisma, { bgmObjectKey: null, bgmPresetId: "p1" })).toBeNull();
    });
    it("启用的预制返回其 objectKey", async () => {
      const prisma = { dubBgmPreset: { findUnique: vi.fn().mockResolvedValue({ objectKey: "p.mp3", enabled: true }) } } as any;
      expect(await resolveBgmObjectKey(prisma, { bgmObjectKey: null, bgmPresetId: "p1" })).toBe("p.mp3");
    });
    it("都没有返回 null", async () => {
      const prisma = { dubBgmPreset: { findUnique: vi.fn() } } as any;
      expect(await resolveBgmObjectKey(prisma, { bgmObjectKey: null, bgmPresetId: null })).toBeNull();
    });
  });
});
