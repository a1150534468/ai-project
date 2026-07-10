import { describe, it, expect } from "vitest";
import { checkHighRisk } from "./high-risk.js";

describe("checkHighRisk", () => {
  it("放行普通操作", () => {
    expect(checkHighRisk("terminal_exec", { command: "ls -la" }).risky).toBe(false);
    expect(checkHighRisk("fs_read", { path: "/Users/me/proj/a.txt" }).risky).toBe(false);
    expect(checkHighRisk("fs_edit", { path: "/Users/me/proj/a.ts", old_string: "x", new_string: "y" }).risky).toBe(false);
    expect(checkHighRisk("fs_glob", { pattern: "**/*.ts", cwd: "/Users/me/proj" }).risky).toBe(false);
  });

  it("终端删根/格式化", () => {
    expect(checkHighRisk("terminal_exec", { command: "rm -rf /" }).risky).toBe(true);
    expect(checkHighRisk("terminal_exec", { command: "mkfs.ext4 /dev/sda" }).risky).toBe(true);
    expect(checkHighRisk("terminal_exec", { command: "Remove-Item C:\\Windows -Recurse" }).risky).toBe(true);
  });

  it("读凭据路径", () => {
    expect(checkHighRisk("fs_read", { path: "/Users/me/.ssh/id_rsa" }).risky).toBe(true);
    expect(checkHighRisk("fs_grep", { pattern: "x", path: "/home/me/.aws" }).risky).toBe(true);
  });

  it("写/改/删/移到系统目录", () => {
    expect(checkHighRisk("fs_write", { path: "/etc/passwd", content: "x" }).risky).toBe(true);
    expect(checkHighRisk("fs_edit", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts", old_string: "a", new_string: "b" }).risky).toBe(true);
    expect(checkHighRisk("fs_delete", { path: "/usr/bin/node" }).risky).toBe(true);
    expect(checkHighRisk("fs_move", { from: "/Users/me/a", to: "/etc/cron.d/x" }).risky).toBe(true);
  });

  it("递归删除根/家目录", () => {
    expect(checkHighRisk("fs_delete", { path: "/", recursive: true }).risky).toBe(true);
    expect(checkHighRisk("fs_delete", { path: "C:\\", recursive: true }).risky).toBe(true);
  });

  it("路径穿越规范化后拦截", () => {
    expect(checkHighRisk("fs_write", { path: "/Users/me/proj/../../../etc/passwd", content: "x" }).risky).toBe(true);
    expect(checkHighRisk("fs_read", { path: "/tmp/../Users/me/.ssh/id_rsa" }).risky).toBe(true);
  });

  it("rm 危险变体", () => {
    expect(checkHighRisk("terminal_exec", { command: "rm -rf ." }).risky).toBe(true);
    expect(checkHighRisk("terminal_exec", { command: "rm -rf *" }).risky).toBe(true);
    expect(checkHighRisk("terminal_exec", { command: "rm -r -f /" }).risky).toBe(true);
  });
});
