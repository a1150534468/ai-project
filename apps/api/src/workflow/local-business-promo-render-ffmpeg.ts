import { spawn } from "node:child_process";

class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }
}

let ffmpegSemaphore: Semaphore | null = null;

function loadNumber(envKey: string, fallback: number): number {
  const value = Number(process.env[envKey]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getFfmpegSemaphore(): { run<T>(work: () => Promise<T>): Promise<T> } {
  ffmpegSemaphore ??= new Semaphore(loadNumber("LOCAL_BUSINESS_PROMO_FFMPEG_CONCURRENCY", 1));
  return ffmpegSemaphore;
}

export interface RunCommandOptions {
  readonly timeoutMs?: number;
}

function appendStderr(buffer: string, chunk: Buffer | string): string {
  const next = `${buffer}${chunk.toString()}`;
  return next.length > 16_384 ? next.slice(-16_384) : next;
}

function killChildProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (!child.pid) return;
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    // ignore cleanup errors
  }
}

export async function runCommand(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    let didTimeout = false;
    let killTimer: NodeJS.Timeout | null = null;
    const cleanupSignals = [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
    ] as const;
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      for (const signal of cleanupSignals) process.off(signal, handleProcessExit);
      process.off("exit", handleProcessExit);
    };
    const handleProcessExit = () => {
      killChildProcessTree(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => killChildProcessTree(child, "SIGKILL"), 1_500);
      }
    };
    for (const signal of cleanupSignals) process.once(signal, handleProcessExit);
    process.once("exit", handleProcessExit);
    const timeoutTimer = options.timeoutMs
      ? setTimeout(() => {
        didTimeout = true;
        killChildProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => killChildProcessTree(child, "SIGKILL"), 1_500);
      }, options.timeoutMs)
      : null;
    child.stderr.on("data", (chunk) => {
      stderr = appendStderr(stderr, chunk);
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }
      if (didTimeout) {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}
