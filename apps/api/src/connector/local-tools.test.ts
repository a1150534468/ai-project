import { describe, it, expect } from "vitest";
import { makeLocalExecTool } from "./local-tools.js";

describe("makeLocalExecTool", () => {
  it("成功时返回设备结果字符串", async () => {
    const exec = makeLocalExecTool({
      dispatchTool: async () => "hello\n",
    } as never, "u1", "dev1", "u1");
    expect(await exec("terminal_exec", { command: "echo hello" })).toBe("hello\n");
  });

  it("默认给桌面工具 10 分钟执行窗口", async () => {
    let timeoutMs = 0;
    const exec = makeLocalExecTool({
      dispatchTool: async (args: { timeoutMs: number }) => {
        timeoutMs = args.timeoutMs;
        return "ok";
      },
    } as never, "u1", "dev1", "u1");

    await exec("terminal_exec", { command: "echo ok" });

    expect(timeoutMs).toBe(600_000);
  });

  it("失败时返回错误描述给模型（不抛）", async () => {
    const exec = makeLocalExecTool({
      dispatchTool: async () => { throw new Error("CONNECTION_LOST: 设备连接中断，结果未知"); },
    } as never, "u1", "dev1", "u1");
    const out = await exec("terminal_exec", { command: "x" });
    expect(out).toContain("工具执行失败");
    expect(out).toContain("CONNECTION_LOST");
  });
});
