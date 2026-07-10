import { spawn } from "node:child_process";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export async function probeAudioDurationSec(
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

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(buffer);
  });
}
