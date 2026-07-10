import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@yc/db";
import { createReseller, listResellers, updateChannel, getVisibilityConfig, setVisibilityConfig } from "./service.js";

const prisma = getPrisma();
const codes = ["QA", "QB"];
const usernames = ["res_ab", "res_ab2", "res_rate"];

async function cleanup() {
  // 先删渠道（引用 admin），再删 admin
  await prisma.channel.deleteMany({ where: { code: { in: codes } } });
  await prisma.admin.deleteMany({ where: { username: { in: usernames } } });
}

// 建前清残留（前次运行若中断可能留下固定渠道码/用户名，避免唯一约束冲突）
beforeAll(cleanup);
afterAll(cleanup);

describe("reseller service", () => {
  it("createReseller 原子建 admin(role=reseller)+channel，渠道码唯一", async () => {
    const r = await createReseller(prisma, { username: "res_ab", password: "password123", code: "QA", commissionRate: 0.1 });
    expect(r.channel.code).toBe("QA");
    expect(r.channel.ownerType).toBe("RESELLER");
    expect(r.channel.resellerId).toBe(r.admin.id);
    expect(r.admin.role).toBe("reseller");
    // 撞码应失败
    await expect(
      createReseller(prisma, { username: "res_ab2", password: "password123", code: "QA", commissionRate: 0.1 }),
    ).rejects.toThrow();
  });

  it("updateChannel 改比例与启停", async () => {
    const r = await createReseller(prisma, { username: "res_rate", password: "password123", code: "QB", commissionRate: 0.1 });
    const u = await updateChannel(prisma, r.channel.id, { commissionRate: 0.25, enabled: false });
    expect(u.commissionRate).toBeCloseTo(0.25);
    expect(u.enabled).toBe(false);
  });

  it("可见项配置默认全开、可更新", async () => {
    const cfg = await getVisibilityConfig(prisma);
    expect(cfg.showRecharge).toBe(true);
    const upd = await setVisibilityConfig(prisma, { showConsumption: false });
    expect(upd.showConsumption).toBe(false);
    // 复原，避免影响其它测试
    await setVisibilityConfig(prisma, { showConsumption: true });
  });
});
