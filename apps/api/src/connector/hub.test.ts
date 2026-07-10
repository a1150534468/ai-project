import { describe, it, expect, vi } from "vitest";
import { handleClientMessage, type HubConnCtx, decideKick } from "./hub.js";

function makeCtx(over: Partial<HubConnCtx> = {}): HubConnCtx {
  return {
    send: vi.fn(),
    onRegistered: vi.fn(async () => {}),
    onHeartbeat: vi.fn(async () => {}),
    onClose: vi.fn(async () => {}),
    resolveTool: vi.fn(),
    rejectTool: vi.fn(),
    verifyToken: vi.fn(async () => ({ id: "dev1", userId: "u1" })),
    onWechatInbound: vi.fn(async () => {}),
    onWechatStatus: vi.fn(async () => {}),
    registered: false,
    deviceId: null,
    sessionId: null,
    ...over,
  };
}

describe("hub handleClientMessage", () => {
  it("合法 register 触发 onRegistered 并回 device.ack", async () => {
    const ctx = makeCtx();
    await handleClientMessage(ctx, JSON.stringify({
      type: "device.register", token: "t", deviceId: "dev1", platform: "win", appVersion: "1.0.0", capabilities: [],
    }));
    expect(ctx.onRegistered).toHaveBeenCalledWith("dev1", "u1", "1.0.0", [], []);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: "device.ack", ok: true }));
  });

  it("token 无效则回 ack ok=false 不注册", async () => {
    const ctx = makeCtx({ verifyToken: vi.fn(async () => null) });
    await handleClientMessage(ctx, JSON.stringify({
      type: "device.register", token: "bad", deviceId: "dev1", platform: "win", appVersion: "1.0.0",
    }));
    expect(ctx.onRegistered).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: "device.ack", ok: false }));
  });

  it("token 的设备 id 与声明不符则拒绝", async () => {
    const ctx = makeCtx({ verifyToken: vi.fn(async () => ({ id: "other", userId: "u1" })) });
    await handleClientMessage(ctx, JSON.stringify({
      type: "device.register", token: "t", deviceId: "dev1", platform: "win", appVersion: "1.0.0",
    }));
    expect(ctx.onRegistered).not.toHaveBeenCalled();
  });

  it("未注册前的 tool.result 被忽略", async () => {
    const ctx = makeCtx();
    await handleClientMessage(ctx, JSON.stringify({ type: "tool.result", id: "x", ok: true, data: "out" }));
    expect(ctx.resolveTool).not.toHaveBeenCalled();
  });

  it("注册后的 tool.result 路由到 resolveTool", async () => {
    const ctx = makeCtx({ registered: true, deviceId: "dev1" });
    await handleClientMessage(ctx, JSON.stringify({ type: "tool.result", id: "x", ok: true, data: "out" }));
    expect(ctx.resolveTool).toHaveBeenCalledWith("dev1", "x", "out");
  });

  it("注册后的 tool.result 会等待异步路由完成", async () => {
    const settled: string[] = [];
    const ctx = makeCtx({
      registered: true,
      deviceId: "dev1",
      resolveTool: vi.fn(async (_deviceId, id) => {
        await Promise.resolve();
        settled.push(id);
      }),
    });

    await handleClientMessage(ctx, JSON.stringify({ type: "tool.result", id: "x", ok: true, data: "out" }));

    expect(settled).toEqual(["x"]);
  });

  it("注册后的 tool.error 路由到 rejectTool", async () => {
    const ctx = makeCtx({ registered: true, deviceId: "dev1" });
    await handleClientMessage(ctx, JSON.stringify({ type: "tool.error", id: "x", code: "EXEC_ERROR", message: "boom" }));
    expect(ctx.rejectTool).toHaveBeenCalledWith("dev1", "x", "EXEC_ERROR", "boom");
  });

  it("注册后的 hb.pong 刷新设备在线状态", async () => {
    const ctx = makeCtx({ registered: true, deviceId: "dev1" });
    await handleClientMessage(ctx, JSON.stringify({ type: "hb.pong", ts: Date.now() }));
    expect(ctx.onHeartbeat).toHaveBeenCalledWith("dev1");
  });

  it("畸形 JSON 不抛异常", async () => {
    const ctx = makeCtx();
    await expect(handleClientMessage(ctx, "{bad")).resolves.toBeUndefined();
  });
});

describe("decideKick 踢线路由", () => {
  it("本地有连接 → local", () => {
    expect(decideKick(true, "anything", "inst-1")).toBe("local");
  });
  it("非本地、owner 是别的实例 → remote", () => {
    expect(decideKick(false, "inst-2", "inst-1")).toBe("remote");
  });
  it("非本地、无 owner → noop", () => {
    expect(decideKick(false, null, "inst-1")).toBe("noop");
  });
  it("非本地、owner 是本实例(竞态/陈旧) → noop", () => {
    expect(decideKick(false, "inst-1", "inst-1")).toBe("noop");
  });
});
