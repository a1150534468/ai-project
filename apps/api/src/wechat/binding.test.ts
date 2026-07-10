import { describe, it, expect, vi } from "vitest";
import { resolveBindingByDevice } from "./binding.js";

describe("resolveBindingByDevice", () => {
  it("按 deviceId 找到绑定并返回 userId/target/sessionId", async () => {
    const prisma = {
      wechatBinding: {
        findUnique: vi.fn(async () => ({
          userId: "u1",
          deviceId: "dev1",
          targetType: "agent",
          targetId: "a1",
          sessionId: "s1",
        })),
      },
    };
    const b = await resolveBindingByDevice(prisma as never, "dev1");
    expect(b).toMatchObject({
      userId: "u1",
      targetType: "agent",
      targetId: "a1",
      sessionId: "s1",
    });
  });

  it("无绑定返回 null", async () => {
    const prisma = {
      wechatBinding: {
        findUnique: vi.fn(async () => null),
      },
    };
    expect(await resolveBindingByDevice(prisma as never, "devX")).toBeNull();
  });
});
