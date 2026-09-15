import { describe, it, expect, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { createAdmin, verifyLogin, getAdminById, listAdmins, updateAdmin } from "./service.js";

const prisma = getPrisma();
const names: string[] = [];

afterAll(async () => {
  await prisma.admin.deleteMany({ where: { username: { in: names } } });
});

describe("admin service", () => {
  it("建管理员后可按用户名+密码验证登录", async () => {
    const uname = `adm_${Date.now()}`;
    names.push(uname);
    const a = await createAdmin(prisma, { username: uname, password: "pw12345678", role: "admin", permissions: ["USER_MANAGE"] });
    const ok = await verifyLogin(prisma, uname, "pw12345678");
    expect(ok?.id).toBe(a.id);
    const bad = await verifyLogin(prisma, uname, "wrong");
    expect(bad).toBeNull();
  });
  it("禁用后验证登录返回 null", async () => {
    const uname = `adm_${Date.now()}_2`;
    names.push(uname);
    const a = await createAdmin(prisma, { username: uname, password: "pw12345678", role: "admin", permissions: [] });
    await updateAdmin(prisma, a.id, { disabled: true });
    expect(await verifyLogin(prisma, uname, "pw12345678")).toBeNull();
  });
  it("getAdminById / listAdmins 不返回 passwordHash", async () => {
    const list = await listAdmins(prisma);
    expect(list.length).toBeGreaterThan(0);
    expect((list[0] as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    const one = await getAdminById(prisma, list[0]!.id);
    expect(one?.id).toBe(list[0]!.id);
    expect((one as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
  });
  it("服务层拒绝给普通管理员显式 ADMIN_MANAGE", async () => {
    await expect(
      createAdmin(prisma, {
        username: `adm_forbidden_${Date.now()}`,
        password: "pw12345678",
        role: "admin",
        permissions: ["ADMIN_MANAGE"],
      }),
    ).rejects.toThrow("ADMIN_MANAGE");
  });
});
