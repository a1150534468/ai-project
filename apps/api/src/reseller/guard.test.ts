import { describe, it, expect } from "vitest";
import { checkReseller } from "./guard.js";

const chan = { id: "ch1", enabled: true, resellerId: "adm1" };
const loadAdmin = async (id: string) =>
  id === "adm1" ? { id, role: "reseller", disabled: false } :
  id === "adm2" ? { id, role: "admin", disabled: false } :
  id === "adm3" ? { id, role: "reseller", disabled: true } : null;
const loadChannel = async (rid: string) => (rid === "adm1" ? chan : null);

describe("checkReseller", () => {
  it("无 token → 401", async () => {
    expect((await checkReseller(null, loadAdmin, loadChannel)).code).toBe(401);
  });
  it("非 reseller 角色 → 403", async () => {
    expect((await checkReseller("adm2", loadAdmin, loadChannel)).code).toBe(403);
  });
  it("已禁用 reseller → 401", async () => {
    expect((await checkReseller("adm3", loadAdmin, loadChannel)).code).toBe(401);
  });
  it("正常 reseller → ok 且返回 channelId", async () => {
    const r = await checkReseller("adm1", loadAdmin, loadChannel);
    expect(r.ok).toBe(true);
    expect(r.channelId).toBe("ch1");
  });
  it("reseller 无对应渠道 → 403", async () => {
    const r = await checkReseller("adm1", loadAdmin, async () => null);
    expect(r.code).toBe(403);
  });
});
