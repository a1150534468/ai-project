import { describe, it, expect } from "vitest";
import {
  clientMessageSchema,
  localTools,
  TOOL_BROWSER_NAVIGATE,
  TOOL_BROWSER_SNAPSHOT,
  TOOL_TERMINAL_EXEC,
  TOOL_FS_READ,
} from "./index.js";

describe("connector-protocol", () => {
  it("校验合法 device.register", () => {
    const r = clientMessageSchema.safeParse({
      type: "device.register",
      token: "t",
      deviceId: "d1",
      platform: "win",
      appVersion: "1.0.0",
      capabilities: [],
    });
    expect(r.success).toBe(true);
  });

  it("device.register 支持上报动态工具定义", () => {
    const r = clientMessageSchema.safeParse({
      type: "device.register",
      token: "t",
      deviceId: "d1",
      platform: "win",
      appVersion: "1.0.0",
      capabilities: ["terminal_exec", "skill_10270"],
      tools: [{
        name: "skill_10270",
        description: "执行已安装的 skill",
        input_schema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
          },
          required: ["prompt"],
        },
      }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect("tools" in r.data && Array.isArray(r.data.tools)).toBe(true);
  });

  it("拒绝非法 platform", () => {
    const r = clientMessageSchema.safeParse({
      type: "device.register",
      token: "t",
      deviceId: "d1",
      platform: "solaris",
      appVersion: "1.0.0",
    });
    expect(r.success).toBe(false);
  });

  it("校验 tool.result / tool.error", () => {
    expect(clientMessageSchema.safeParse({ type: "tool.result", id: "x", ok: true, data: "out" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "tool.error", id: "x", code: "EXEC_ERROR", message: "boom" }).success).toBe(true);
  });

  it("工具名符合 Anthropic 规则（仅字母数字下划线连字符）", () => {
    const re = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const t of localTools) expect(t.name).toMatch(re);
    expect(TOOL_TERMINAL_EXEC).toBe("terminal_exec");
    expect(TOOL_FS_READ).toBe("fs_read");
  });

  it("localTools 含本机与浏览器工具且名称合法", () => {
    const names = localTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "browser_click", "browser_close", "browser_console", "browser_evaluate",
      "browser_navigate", "browser_network", "browser_screenshot", "browser_snapshot",
      "browser_type", "browser_wait",
      "fs_copy", "fs_delete", "fs_edit", "fs_glob", "fs_grep",
      "fs_list", "fs_mkdir", "fs_move", "fs_read", "fs_stat",
      "fs_write", "terminal_exec",
    ]);
    const re = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const t of localTools) expect(t.name).toMatch(re);
    expect(TOOL_BROWSER_NAVIGATE).toBe("browser_navigate");
    expect(TOOL_BROWSER_SNAPSHOT).toBe("browser_snapshot");
  });
});
