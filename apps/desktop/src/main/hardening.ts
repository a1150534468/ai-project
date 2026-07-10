// 启动加固：崩溃落盘 + GPU 子进程崩溃兜底。
// 全部依赖注入，便于单测；真实 electron/fs 接线在 main/index.ts。
// 说明：函数须在 app ready 前调用——disableHardwareAcceleration 只在 ready 前生效。

export function formatCrashEntry(
  label: string,
  err: unknown,
  version: string,
  timestamp: string
): string {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  return `[${label}] v${version} ${timestamp}\n${detail}\n\n`;
}

export interface CrashLoggerDeps {
  readonly append: (line: string) => void; // 追加落盘，内部自行兜底，不得再抛
  readonly version: string;
  readonly now: () => string;
  readonly onUncaught: (cb: (err: unknown) => void) => void;
  readonly onUnhandled: (cb: (reason: unknown) => void) => void;
  readonly showError?: (message: string) => void;
}

// 捕获主进程未处理异常/拒绝，落盘并尽量弹窗——堵住 field crash「零日志」。
export function installCrashLogging(deps: CrashLoggerDeps): void {
  const handle = (label: string, err: unknown): void => {
    const entry = formatCrashEntry(label, err, deps.version, deps.now());
    deps.append(entry);
    deps.showError?.(entry);
  };
  deps.onUncaught((err) => handle("uncaughtException", err));
  deps.onUnhandled((reason) => handle("unhandledRejection", reason));
}

export interface GpuGuardDeps {
  readonly markPath: string;
  readonly exists: (path: string) => boolean;
  readonly persist: (path: string) => void;
  readonly disableHardwareAcceleration: () => void;
  readonly onChildGone: (cb: (type: string, reason: string) => void) => void;
}

// GPU 子进程崩溃兜底：上次崩过则本次软件渲染；本次崩了落标记，下次启动自动软渲染。
// 只惩罚真出问题的机器，正常用户保留硬件加速（视频播放依赖）。
export function applyGpuCrashGuard(deps: GpuGuardDeps): void {
  if (deps.exists(deps.markPath)) {
    deps.disableHardwareAcceleration();
  }
  deps.onChildGone((type, reason) => {
    if (type === "GPU" && reason !== "clean-exit") {
      deps.persist(deps.markPath);
    }
  });
}
