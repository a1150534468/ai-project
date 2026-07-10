import { describe, expect, it, vi } from "vitest";
import { startAutoUpdateChecks } from "./updater.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function listenerFor(updater: { once: ReturnType<typeof vi.fn> }, event: string) {
  return updater.once.mock.calls.find((call) => call[0] === event)?.[1] as
    | ((info?: { version?: string }) => void)
    | undefined;
}

describe("startAutoUpdateChecks", () => {
  function makeUpdater() {
    return {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
      once: vi.fn(),
    };
  }

  it("schedules update checks only for packaged builds", () => {
    const setTimeout = vi.fn();
    const updater = makeUpdater();

    startAutoUpdateChecks({
      app: { isPackaged: false },
      updater,
      setTimeout,
      delayMs: 1,
    });

    expect(setTimeout).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.once).not.toHaveBeenCalled();
  });

  it("checks and force-installs updates after the configured delay in packaged builds (无 notifier 降级)", () => {
    const setTimeout = vi.fn((callback: () => void) => {
      callback();
      return 1;
    });
    const updater = makeUpdater();

    startAutoUpdateChecks({
      app: { isPackaged: true },
      updater,
      setTimeout,
      delayMs: 1,
    });

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    // 无 notifier 时不注册 update-available，只注册 update-downloaded 并直接安装。
    expect(listenerFor(updater, "update-available")).toBeUndefined();
    const listener = listenerFor(updater, "update-downloaded");
    expect(listener).toBeTypeOf("function");
    listener?.();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("有 notifier 时发现新版本弹后台下载提示", () => {
    const setTimeout = vi.fn(() => 1);
    const updater = makeUpdater();
    const notifier = {
      notifyDownloading: vi.fn(),
      confirmRestart: vi.fn().mockResolvedValue(true),
    };

    startAutoUpdateChecks({ app: { isPackaged: true }, updater, notifier, setTimeout, delayMs: 1 });

    listenerFor(updater, "update-available")?.({ version: "1.2.3" });
    expect(notifier.notifyDownloading).toHaveBeenCalledWith("1.2.3");
  });

  it("下载完成选“立即重启”则安装", async () => {
    const setTimeout = vi.fn(() => 1);
    const updater = makeUpdater();
    const notifier = {
      notifyDownloading: vi.fn(),
      confirmRestart: vi.fn().mockResolvedValue(true),
    };

    startAutoUpdateChecks({ app: { isPackaged: true }, updater, notifier, setTimeout, delayMs: 1 });

    listenerFor(updater, "update-downloaded")?.({ version: "1.2.3" });
    await flush();
    expect(notifier.confirmRestart).toHaveBeenCalledWith("1.2.3");
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("下载完成选“稍后”则标记退出自动装，并 remindMs 后再次提醒", async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const setTimeout = vi.fn((fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    });
    const updater = makeUpdater();
    const confirmRestart = vi.fn().mockResolvedValue(false);
    const notifier = { notifyDownloading: vi.fn(), confirmRestart };

    startAutoUpdateChecks({
      app: { isPackaged: true },
      updater,
      notifier,
      setTimeout,
      delayMs: 1,
      remindMs: 60_000,
    });

    listenerFor(updater, "update-downloaded")?.({ version: "1.2.3" });
    await flush();

    // 稍后：不重启、标记退出自动装、并排了一次 60s 后的再提醒
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(true);
    const remind = scheduled.find((task) => task.ms === 60_000);
    expect(remind).toBeDefined();
    expect(confirmRestart).toHaveBeenCalledTimes(1);

    // 模拟 1 分钟后触发再提醒
    remind?.fn();
    await flush();
    expect(confirmRestart).toHaveBeenCalledTimes(2);
  });
});
