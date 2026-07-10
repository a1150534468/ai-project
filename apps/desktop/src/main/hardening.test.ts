import { describe, it, expect, vi } from "vitest";
import { formatCrashEntry, installCrashLogging, applyGpuCrashGuard } from "./hardening.js";

describe("formatCrashEntry", () => {
  it("用 Error.stack 组织条目并带版本/时间戳", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n  at x";
    const line = formatCrashEntry("uncaughtException", err, "1.0.18", "2026-07-06T00:00:00.000Z");
    expect(line).toContain("[uncaughtException] v1.0.18 2026-07-06T00:00:00.000Z");
    expect(line).toContain("Error: boom\n  at x");
    expect(line.endsWith("\n\n")).toBe(true);
  });

  it("非 Error 值退化为字符串", () => {
    expect(formatCrashEntry("unhandledRejection", "kaboom", "1.0.18", "T")).toContain("kaboom");
  });
});

describe("installCrashLogging", () => {
  it("uncaught/unhandled 均落盘并弹窗", () => {
    let uncaught: ((e: unknown) => void) | null = null;
    let unhandled: ((e: unknown) => void) | null = null;
    const append = vi.fn();
    const showError = vi.fn();
    installCrashLogging({
      append,
      version: "1.0.18",
      now: () => "T",
      onUncaught: (cb) => { uncaught = cb; },
      onUnhandled: (cb) => { unhandled = cb; },
      showError,
    });
    uncaught!(new Error("a"));
    unhandled!("b");
    expect(append).toHaveBeenCalledTimes(2);
    expect(showError).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0][0]).toContain("[uncaughtException]");
    expect(append.mock.calls[1][0]).toContain("[unhandledRejection]");
  });

  it("无 showError 时不报错", () => {
    let uncaught: ((e: unknown) => void) | null = null;
    const append = vi.fn();
    installCrashLogging({
      append,
      version: "1.0.18",
      now: () => "T",
      onUncaught: (cb) => { uncaught = cb; },
      onUnhandled: () => {},
    });
    expect(() => uncaught!(new Error("a"))).not.toThrow();
    expect(append).toHaveBeenCalledOnce();
  });
});

describe("applyGpuCrashGuard", () => {
  it("存在标记文件则启动即软件渲染", () => {
    const disable = vi.fn();
    applyGpuCrashGuard({
      markPath: "/m",
      exists: () => true,
      persist: vi.fn(),
      disableHardwareAcceleration: disable,
      onChildGone: () => {},
    });
    expect(disable).toHaveBeenCalledOnce();
  });

  it("无标记则不禁用硬件加速", () => {
    const disable = vi.fn();
    applyGpuCrashGuard({
      markPath: "/m",
      exists: () => false,
      persist: vi.fn(),
      disableHardwareAcceleration: disable,
      onChildGone: () => {},
    });
    expect(disable).not.toHaveBeenCalled();
  });

  it("GPU 异常崩溃落标记；正常退出/其它进程不落", () => {
    let fire: ((type: string, reason: string) => void) | null = null;
    const persist = vi.fn();
    applyGpuCrashGuard({
      markPath: "/m",
      exists: () => false,
      persist,
      disableHardwareAcceleration: vi.fn(),
      onChildGone: (cb) => { fire = cb; },
    });
    fire!("GPU", "crashed");
    fire!("GPU", "clean-exit");
    fire!("Utility", "crashed");
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("/m");
  });
});
