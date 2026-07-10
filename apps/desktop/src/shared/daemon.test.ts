import { describe, it, expect, vi } from "vitest";
import { handleHubMessage, nextBackoffMs } from "./daemon.js";

function ctx(over = {}) {
  return {
    send: vi.fn(),
    executeTool: vi.fn(async () => "ok-output"),
    confirm: vi.fn(async () => true),
    onRegistered: vi.fn(),
    ...over,
  };
}

describe("nextBackoffMs", () => {
  it("指数增长封顶 30s", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});

describe("handleHubMessage", () => {
  it("hb.ping→hb.pong", async () => {
    const c = ctx();
    await handleHubMessage(c, { type: "hb.ping", ts: 1 });
    expect(c.send).toHaveBeenCalledWith(expect.objectContaining({ type: "hb.pong" }));
  });

  it("device.ack ok→onRegistered", async () => {
    const c = ctx();
    await handleHubMessage(c, { type: "device.ack", ok: true, serverTime: 1 });
    expect(c.onRegistered).toHaveBeenCalled();
  });

  it("tool.invoke 成功→tool.result", async () => {
    const c = ctx();
    await handleHubMessage(c, {
      type: "tool.invoke",
      id: "x",
      tool: "terminal_exec",
      args: { command: "echo hi" },
      timeoutMs: 1000,
    });
    expect(c.executeTool).toHaveBeenCalledWith("terminal_exec", { command: "echo hi" }, expect.anything());
    expect(c.send).toHaveBeenCalledWith({ type: "tool.result", id: "x", ok: true, data: "ok-output" });
  });

  it("tool.invoke 失败→tool.error 带码", async () => {
    const c = ctx({ executeTool: vi.fn(async () => { throw new Error("BLOCKED: 拒绝"); }) });
    await handleHubMessage(c, {
      type: "tool.invoke",
      id: "y",
      tool: "terminal_exec",
      args: {},
      timeoutMs: 1000,
    });
    expect(c.send).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.error", id: "y", code: "BLOCKED" }));
  });

  it("tool.invoke skipConfirm=true 时自动放行不调 ctx.confirm", async () => {
    let usedConfirm: ((r: string) => Promise<boolean>) | undefined;
    const c = ctx({
      executeTool: vi.fn(async (_n: string, _a: unknown, opts: { confirm: (r: string) => Promise<boolean> }) => {
        usedConfirm = opts.confirm;
        return "auto-allowed";
      }),
    });
    await handleHubMessage(c, {
      type: "tool.invoke",
      id: "skip-confirm-test",
      tool: "terminal_exec",
      args: { command: "rm -rf /" },
      timeoutMs: 1000,
      skipConfirm: true,
    });
    expect(await usedConfirm!("高危操作")).toBe(true);
    expect(c.confirm).not.toHaveBeenCalled();
    expect(c.send).toHaveBeenCalledWith({
      type: "tool.result",
      id: "skip-confirm-test",
      ok: true,
      data: "auto-allowed",
    });
  });

  it("tool.invoke 无 skipConfirm 时仍用 ctx.confirm", async () => {
    let usedConfirm: ((r: string) => Promise<boolean>) | undefined;
    const c = ctx({
      executeTool: vi.fn(async (_n: string, _a: unknown, opts: { confirm: (r: string) => Promise<boolean> }) => {
        usedConfirm = opts.confirm;
        const res = await opts.confirm("测试确认");
        return res ? "confirmed" : "rejected";
      }),
    });
    await handleHubMessage(c, {
      type: "tool.invoke",
      id: "normal-confirm-test",
      tool: "terminal_exec",
      args: { command: "ls" },
      timeoutMs: 1000,
    });
    expect(c.confirm).toHaveBeenCalledWith("测试确认");
    expect(c.send).toHaveBeenCalledWith({
      type: "tool.result",
      id: "normal-confirm-test",
      ok: true,
      data: "confirmed",
    });
  });
});
