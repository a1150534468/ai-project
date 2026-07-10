interface AppLike {
  readonly isPackaged: boolean;
}

interface UpdateInfoLike {
  readonly version?: string;
}

interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<unknown> | unknown;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  once: (
    event: "update-available" | "update-downloaded",
    listener: (info: UpdateInfoLike) => void
  ) => void;
}

// 更新提示（注入 electron dialog，便于单测）：
// - notifyDownloading：发现新版本、开始后台下载时告知用户（非阻塞）。
// - confirmRestart：下载完成后询问是否立即重启，resolve true=立即重启、false=稍后。
interface UpdateNotifierLike {
  notifyDownloading: (version: string) => void;
  confirmRestart: (version: string) => Promise<boolean>;
}

interface LoggerLike {
  warn: (message: string) => void;
}

interface StartAutoUpdateChecksOptions {
  readonly app: AppLike;
  readonly updater: UpdaterLike;
  readonly notifier?: UpdateNotifierLike;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly delayMs?: number;
  readonly remindMs?: number;
  readonly logger?: LoggerLike;
}

const DEFAULT_UPDATE_DELAY_MS = 10_000;
// 用户选“稍后”后，每隔这么久再提醒一次，直到立即重启（其间退出会自动安装）。
const DEFAULT_RESTART_REMIND_MS = 60_000;

function formatUpdateError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startAutoUpdateChecks(options: StartAutoUpdateChecksOptions): void {
  if (!options.app.isPackaged) {
    return;
  }

  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const delayMs = options.delayMs ?? DEFAULT_UPDATE_DELAY_MS;
  const remindMs = options.remindMs ?? DEFAULT_RESTART_REMIND_MS;
  const logger = options.logger ?? console;
  const { updater, notifier } = options;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;

  if (notifier) {
    updater.once("update-available", (info) => {
      notifier.notifyDownloading(info?.version ?? "");
    });
  }

  updater.once("update-downloaded", (info) => {
    const version = info?.version ?? "";
    if (!notifier) {
      // 无 notifier（降级/测试）：保持原“下载完直接重启”行为。
      updater.quitAndInstall(true, true);
      return;
    }
    // 询问是否立即重启；选“稍后”则保证退出时自动装，并 remindMs 后再次提醒，直到立即重启。
    const promptRestart = (): void => {
      void notifier
        .confirmRestart(version)
        .then((restartNow) => {
          if (restartNow) {
            updater.quitAndInstall(true, true);
            return;
          }
          updater.autoInstallOnAppQuit = true;
          schedule(promptRestart, remindMs);
        })
        .catch((error: unknown) => {
          logger.warn(`[auto-update] restart prompt failed: ${formatUpdateError(error)}`);
          updater.autoInstallOnAppQuit = true;
        });
    };
    promptRestart();
  });

  schedule(() => {
    void Promise.resolve(updater.checkForUpdates()).catch((error: unknown) => {
      logger.warn(`[auto-update] check failed: ${formatUpdateError(error)}`);
    });
  }, delayMs);
}
