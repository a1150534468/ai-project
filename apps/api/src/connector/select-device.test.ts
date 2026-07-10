import { describe, it, expect } from "vitest";
import { pickActiveDevice } from "./select-device.js";

describe("pickActiveDevice", () => {
  it("无在线设备返回 null", () => {
    expect(pickActiveDevice([])).toBeNull();
  });

  it("只有一台在线设备时返回该设备", () => {
    const d = pickActiveDevice([
      { id: "a", userId: "u1", lastSeenAt: new Date(1000) },
    ]);
    expect(d?.id).toBe("a");
  });

  it("指定 deviceId 且在线时派给指定的那台（多设备按当前设备路由）", () => {
    const d = pickActiveDevice(
      [
        { id: "a", userId: "u1", lastSeenAt: new Date(2000) },
        { id: "b", userId: "u1", lastSeenAt: new Date(1000) },
      ],
      "b",
    );
    expect(d?.id).toBe("b");
  });

  it("多台在线且未指定时退化为最近活跃的一台（不再禁用工具）", () => {
    const d = pickActiveDevice([
      { id: "a", userId: "u1", lastSeenAt: new Date(1000) },
      { id: "b", userId: "u1", lastSeenAt: new Date(2000) },
    ]);
    expect(d?.id).toBe("b");
  });

  it("指定的 deviceId 不在线时退化为最近活跃的一台", () => {
    const d = pickActiveDevice(
      [
        { id: "a", userId: "u1", lastSeenAt: new Date(3000) },
        { id: "b", userId: "u1", lastSeenAt: new Date(1000) },
      ],
      "offline-x",
    );
    expect(d?.id).toBe("a");
  });
});
