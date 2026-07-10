import { describe, it, expect, vi } from "vitest";
import { createBinding, listBindings, deleteBinding, BindingForbiddenError } from "./bindings.js";

function prismaWith(device: unknown, existingBinding: unknown = null) {
  return {
    device: {
      findUnique: vi.fn(async () => device),
      findMany: vi.fn(async () => [{ id: "dev1", online: true }]),
    },
    session: {
      create: vi.fn(async () => ({ id: "sess1" })),
    },
    wechatBinding: {
      create: vi.fn(async (data: unknown) => {
        const createdData = data as any;
        return { id: "b_new", deviceId: createdData.data?.deviceId, sessionId: createdData.data?.sessionId };
      }),
      update: vi.fn(async (data: unknown) => {
        const updateData = data as any;
        return { id: updateData.where?.deviceId === "dev1" ? "b1" : "b_other" };
      }),
      findMany: vi.fn(async () => [{ id: "b1", deviceId: "dev1", targetId: "a1", online: false }]),
      findUnique: vi.fn(async () => existingBinding),
      delete: vi.fn(async () => ({})),
    },
  };
}

describe("createBinding", () => {
  it("绑定不属于自己的设备 → BindingForbiddenError", async () => {
    const prisma = prismaWith({ userId: "u2" }); // 设备属于别人
    await expect(
      createBinding(prisma as never, "u1", {
        deviceId: "dev1",
        targetType: "agent",
        targetId: "a1",
      })
    ).rejects.toBeInstanceOf(BindingForbiddenError);
    // 应该在设备权限校验后就停止，不继续访问 wechatBinding
    expect(prisma.wechatBinding.create).not.toHaveBeenCalled();
    expect(prisma.wechatBinding.update).not.toHaveBeenCalled();
  });

  it("设备不存在 → BindingForbiddenError", async () => {
    const prisma = prismaWith(null);
    await expect(
      createBinding(prisma as never, "u1", {
        deviceId: "devX",
        targetType: "agent",
        targetId: "a1",
      })
    ).rejects.toBeInstanceOf(BindingForbiddenError);
    expect(prisma.wechatBinding.findUnique).not.toHaveBeenCalled();
  });

  it("自己的设备（新绑定） → 建会话+create 绑定，返回 id", async () => {
    const prisma = prismaWith({ userId: "u1" }, null); // 无现有绑定
    const r = await createBinding(prisma as never, "u1", {
      deviceId: "dev1",
      targetType: "agent",
      targetId: "a1",
    });
    expect(r.id).toBe("b_new");
    expect(prisma.session.create).toHaveBeenCalled();
    expect(prisma.wechatBinding.create).toHaveBeenCalled();
    expect(prisma.wechatBinding.update).not.toHaveBeenCalled();
  });

  it("自己的设备（重复绑定） → 不创建会话，仅 update 绑定", async () => {
    const existingBinding = { id: "b1", deviceId: "dev1", userId: "u1", targetId: "a_old", sessionId: "sess_old" };
    const prisma = prismaWith({ userId: "u1" }, existingBinding);
    const r = await createBinding(prisma as never, "u1", {
      deviceId: "dev1",
      targetType: "agent",
      targetId: "a_new",
    });
    expect(r.id).toBe("b1");
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(prisma.wechatBinding.create).not.toHaveBeenCalled();
    expect(prisma.wechatBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: "dev1" },
        data: expect.objectContaining({ targetType: "agent", targetId: "a_new" }),
      })
    );
  });

  it("createBinding 支持 targetType team（新建时建会话线程）", async () => {
    const prisma = prismaWith({ userId: "u1" }, null); // 无现有绑定
    const r = await createBinding(prisma as never, "u1", {
      deviceId: "dev1",
      targetType: "team",
      targetId: "team1",
    });
    expect(r.id).toBe("b_new");
    expect(prisma.session.create).toHaveBeenCalled();
    expect(prisma.wechatBinding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetType: "team",
          targetId: "team1",
        }),
      })
    );
  });
});

describe("deleteBinding", () => {
  it("删他人绑定 → BindingForbiddenError", async () => {
    const prisma = {
      device: { findUnique: vi.fn() },
      session: { create: vi.fn() },
      wechatBinding: {
        create: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(async () => ({ id: "b1", userId: "u2" })),
        delete: vi.fn(),
      },
    };
    await expect(deleteBinding(prisma as never, "u1", "b1")).rejects.toBeInstanceOf(
      BindingForbiddenError
    );
    expect(prisma.wechatBinding.delete).not.toHaveBeenCalled();
  });

  it("删自己的绑定 → ok", async () => {
    const prisma = {
      device: { findUnique: vi.fn() },
      session: { create: vi.fn() },
      wechatBinding: {
        create: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(async () => ({ id: "b1", userId: "u1" })),
        delete: vi.fn(async () => ({})),
      },
    };
    await deleteBinding(prisma as never, "u1", "b1");
    expect(prisma.wechatBinding.delete).toHaveBeenCalled();
  });
});

describe("listBindings", () => {
  it("只列自己的绑定，online 取设备连接器在线状态", async () => {
    const prisma = prismaWith({ userId: "u1" });
    const r = await listBindings(prisma as never, "u1");
    expect(prisma.wechatBinding.findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
    expect(r.length).toBe(1);
    // 绑定表存的 online=false，但设备 dev1 连接器在线 → 显示在线
    expect(r[0].online).toBe(true);
  });
});
