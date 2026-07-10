import { describe, it, expect, vi } from "vitest";
import { listAvatars, removeAvatar, setAvatarFavorite } from "./dub-avatar-service.js";

describe("dub-avatar-service", () => {
  it("listAvatars 只返回本人形象", async () => {
    const prisma = { avatar: { findMany: vi.fn().mockResolvedValue([{ id: "a1", userId: "u1" }]) } } as any;
    await listAvatars(prisma, "u1");
    expect(prisma.avatar.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
  });

  it("setAvatarFavorite 按 userId 限定，命中返回 true", async () => {
    const prisma = { avatar: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } } as any;
    const ok = await setAvatarFavorite(prisma, "u1", "a1", true);
    expect(ok).toBe(true);
    expect(prisma.avatar.updateMany).toHaveBeenCalledWith({ where: { id: "a1", userId: "u1" }, data: { isFavorite: true } });
  });

  it("removeAvatar 越权（非本人）不删、返回 false", async () => {
    const prisma = { avatar: { findFirst: vi.fn().mockResolvedValue(null), delete: vi.fn() } } as any;
    const sky = { deleteAvatar: vi.fn() };
    const ok = await removeAvatar({ prisma, cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, userId: "u1", avatarId: "a1" });
    expect(ok).toBe(false);
    expect(prisma.avatar.delete).not.toHaveBeenCalled();
    expect(sky.deleteAvatar).not.toHaveBeenCalled();
  });

  it("removeAvatar 本人：先飞天删再删行", async () => {
    const prisma = { avatar: { findFirst: vi.fn().mockResolvedValue({ id: "a1", userId: "u1", avatarCode: "av_x" }), delete: vi.fn().mockResolvedValue({}) } } as any;
    const sky = { deleteAvatar: vi.fn().mockResolvedValue(undefined) };
    const ok = await removeAvatar({ prisma, cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, userId: "u1", avatarId: "a1" });
    expect(ok).toBe(true);
    expect(sky.deleteAvatar).toHaveBeenCalledWith({}, expect.any(Function), "av_x");
    expect(prisma.avatar.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
  });
});
