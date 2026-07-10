import { spawn } from "node:child_process";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/**
 * 用 ffprobe 从内存 buffer 读取视频时长（秒，向上取整）。
 * 计费依据不可信客户端，必须由后端权威测量：这里从 stdin 直接喂入字节流，避免临时文件。
 * 失败/超时/未安装 ffprobe 时返回 0，由调用方判定（本项目会拒绝无法测量时长的计费请求）。
 */
export async function probeVideoDurationSec(
  buffer: Buffer,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: number) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        "-i", "pipe:0",
      ]);
    } catch {
      done(0);
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(0);
    }, timeoutMs);

    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(0);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(0);
        return;
      }
      const seconds = Number.parseFloat(out.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        done(0);
        return;
      }
      done(Math.ceil(seconds));
    });

    // stdin 写入可能因进程提前退出而 EPIPE，吞掉避免进程崩溃。
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(buffer);
  });
}

export async function probeVideoDurationSecFromFile(
  filePath: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: number) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ]);
    } catch {
      done(0);
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(0);
    }, timeoutMs);

    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(0);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(0);
        return;
      }
      const seconds = Number.parseFloat(out.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        done(0);
        return;
      }
      done(Math.ceil(seconds));
    });
  });
}
