import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./index.js";
import { __setBrowserAutomationForTest, type BrowserAutomation } from "./browser.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-assistant-exec-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  __setBrowserAutomationForTest(null);
});

describe("executeTool", () => {
  it("普通命令不触发确认", async () => {
    const confirm = vi.fn(async () => true);
    const result = await executeTool("terminal_exec", { command: "echo hi" }, { confirm });
    expect(result).toContain("hi");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("路由 fs_write/fs_read", async () => {
    const confirm = vi.fn(async () => true);
    const p = join(dir, "x.txt");
    await executeTool("fs_write", { path: p, content: "data" }, { confirm });
    const content = await executeTool("fs_read", { path: p }, { confirm });
    expect(content).toBe("data");
  });

  it("高危拒绝→BLOCKED", async () => {
    const confirm = vi.fn(async () => false);
    await expect(
      executeTool("terminal_exec", { command: "rm -rf /" }, { confirm })
    ).rejects.toThrow("BLOCKED");
    expect(confirm).toHaveBeenCalled();
  });

  it("未知工具→EXEC_ERROR", async () => {
    await expect(
      executeTool("nope", {}, { confirm: async () => true })
    ).rejects.toThrow("EXEC_ERROR");
  });

  it("路由浏览器导航和快照工具", async () => {
    const fakeBrowser: BrowserAutomation = {
      navigate: async (url) => `navigated:${url}`,
      snapshot: async () => "snapshot",
      click: async () => "clicked",
      type: async () => "typed",
      wait: async () => "waited",
      evaluate: async () => "evaluated",
      screenshot: async () => "screenshot",
      console: async () => "console",
      network: async () => "network",
      close: async () => "closed",
    };
    __setBrowserAutomationForTest(fakeBrowser);
    const confirm = vi.fn(async () => true);

    await expect(
      executeTool("browser_navigate", { url: "https://example.com" }, { confirm })
    ).resolves.toBe("navigated:https://example.com");
    await expect(executeTool("browser_snapshot", {}, { confirm })).resolves.toBe("snapshot");
    expect(confirm).not.toHaveBeenCalled();
  });
});
