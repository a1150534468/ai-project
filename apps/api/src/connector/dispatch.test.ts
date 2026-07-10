import { describe, it, expect, vi } from "vitest";
import { createDispatcher } from "./dispatch.js";

describe("dispatcher", () => {
  it("收到 result 后 dispatchTool 解析为数据", async () => {
    const sent: Array<{ deviceId: string; id: string }> = [];
    const d = createDispatcher({
      send: async (deviceId, inv) => { sent.push({ deviceId, id: inv.id }); },
    });
    const p = d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", args: { command: "echo hi" }, timeoutMs: 1000 });
    await Promise.resolve();
    // 模拟设备回结果
    expect(sent.length).toBe(1);
    expect(d.resolve("dev1", sent[0].id, "hi\n")).toBe(true);
    await expect(p).resolves.toBe("hi\n");
  });

  it("未知 result / error 返回 false，便于跨实例转发", () => {
    const d = createDispatcher({ send: async () => {} });
    expect(d.resolve("dev1", "missing", "out")).toBe(false);
    expect(d.reject("dev1", "missing", "EXEC_ERROR", "boom")).toBe(false);
  });

  it("在途调用创建和结算时通知 owner registry", async () => {
    const created: Array<{ id: string; deviceId: string; timeoutMs: number }> = [];
    const settled: string[] = [];
    const sent: string[] = [];
    const d = createDispatcher({
      send: async (_deviceId, inv) => { sent.push(inv.id); },
      onPendingCreated: async (id, deviceId, timeoutMs) => {
        created.push({ id, deviceId, timeoutMs });
      },
      onPendingSettled: async (id) => {
        settled.push(id);
      },
    });

    const p = d.dispatchTool({
      deviceId: "dev1",
      userId: "u1",
      deviceUserId: "u1",
      tool: "terminal_exec",
      args: {},
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(created).toEqual([{ id: sent[0], deviceId: "dev1", timeoutMs: 1000 }]);
    d.resolve("dev1", sent[0], "ok");
    await expect(p).resolves.toBe("ok");
    expect(settled).toEqual([sent[0]]);
  });

  it("超时则 reject TIMEOUT", async () => {
    const d = createDispatcher({ send: async () => {} });
    await expect(
      d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", args: {}, timeoutMs: 20 }),
    ).rejects.toThrow("TIMEOUT");
  });

  it("failDevice 把在途调用以 CONNECTION_LOST 失败（不重跑）", async () => {
    const d = createDispatcher({ send: async () => {} });
    const p = d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", args: {}, timeoutMs: 5000 });
    d.failDevice("dev1", "CONNECTION_LOST");
    await expect(p).rejects.toThrow("CONNECTION_LOST");
  });

  it("租户不匹配直接 reject，不下发", async () => {
    const send = vi.fn(async () => {});
    const d = createDispatcher({ send });
    await expect(
      d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u2", tool: "terminal_exec", args: {}, timeoutMs: 1000 }),
    ).rejects.toThrow("TENANT_MISMATCH");
    expect(send).not.toHaveBeenCalled();
  });

  it("send 失败则 reject SEND_FAILED", async () => {
    const d = createDispatcher({
      send: async () => { throw new Error("Network error"); },
    });
    await expect(
      d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", args: {}, timeoutMs: 5000 }),
    ).rejects.toThrow("SEND_FAILED: Network error");
  });

  it("failDevice 只清理指定设备的待处理调用", async () => {
    const d = createDispatcher({ send: async () => {} });
    const p1 = d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "tool1", args: {}, timeoutMs: 5000 });
    const p2 = d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "tool2", args: {}, timeoutMs: 5000 });
    const p3 = d.dispatchTool({ deviceId: "dev2", userId: "u1", deviceUserId: "u1", tool: "tool3", args: {}, timeoutMs: 5000 });

    d.failDevice("dev1", "CONNECTION_LOST");

    await expect(p1).rejects.toThrow("CONNECTION_LOST");
    await expect(p2).rejects.toThrow("CONNECTION_LOST");
    // dev2 应该不受影响，超时失败
    await expect(p3).rejects.toThrow("TIMEOUT");
  });

  it("竞态：超时与 resolve 同时触发时只一个成功", async () => {
    const sent: Array<{ deviceId: string; id: string }> = [];
    const d = createDispatcher({
      send: async (deviceId, inv) => { sent.push({ deviceId, id: inv.id }); },
    });
    const p = d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", args: {}, timeoutMs: 50 });
    // 立即 resolve，然后等待（可能超时也可能被 resolve）
    setTimeout(() => {
      d.resolve("dev1", sent[0].id, "result");
    }, 10);
    // promise 应该被 resolve 或超时，但不会双重结算
    const result = await Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Never settled")), 200)),
    ]);
    expect(result).toBe("result");
  });

  it("dispatchTool 透传 skipConfirm 到 ToolInvoke", async () => {
    const sent: any[] = [];
    const d = createDispatcher({ send: async (deviceId: string, inv: any) => { sent.push(inv); } });
    const p = d.dispatchTool({ deviceId: "dev1", userId: "u1", deviceUserId: "u1", tool: "terminal_exec", args: { command: "ls" }, timeoutMs: 1000, skipConfirm: true });
    await Promise.resolve();
    expect(sent[0]).toMatchObject({ type: "tool.invoke", tool: "terminal_exec", skipConfirm: true });
    expect(d.resolve("dev1", sent[0].id, "ok")).toBe(true);
    await expect(p).resolves.toBe("ok");
  });
});
