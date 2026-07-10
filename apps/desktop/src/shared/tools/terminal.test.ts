import { describe, it, expect } from "vitest";
import { pickShell, runTerminal } from "./terminal.js";

describe("pickShell", () => {
  it("Windows→powershell", () => {
    expect(pickShell("win32").cmd.toLowerCase()).toContain("powershell");
  });
  it("其余→sh", () => {
    expect(pickShell("linux").cmd).toBe("sh");
    expect(pickShell("darwin").cmd).toBe("sh");
  });
});

describe("runTerminal", () => {
  it("返回 stdout", async () => {
    expect(await runTerminal({ command: "echo hello" }, { timeoutMs: 5000 })).toContain("hello");
  });
  it("超时抛错", async () => {
    await expect(runTerminal({ command: "sleep 5" }, { timeoutMs: 200 })).rejects.toThrow(
      /超时|timeout/i
    );
  });
});
