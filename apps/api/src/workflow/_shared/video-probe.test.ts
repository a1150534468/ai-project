import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { probeVideoDurationSec } from "./video-probe.js";

const run = promisify(execFile);

// 用 ffmpeg 生成一段确定时长的测试视频，验证 ffprobe 读取并向上取整。
async function makeTestVideo(seconds: number): Promise<Buffer | null> {
  try {
    const { stdout } = await run(
      "ffmpeg",
      [
        "-f", "lavfi",
        "-i", `color=c=black:s=64x64:d=${seconds}`,
        "-pix_fmt", "yuv420p",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout as unknown as Buffer;
  } catch {
    return null;
  }
}

describe("probeVideoDurationSec", () => {
  it("reads duration from a real video buffer (ceil to whole seconds)", async () => {
    const buffer = await makeTestVideo(3);
    if (!buffer) {
      // 环境无 ffmpeg 时跳过（生产运行时保证有 ffmpeg）。
      return;
    }
    const seconds = await probeVideoDurationSec(buffer);
    expect(seconds).toBeGreaterThanOrEqual(3);
    expect(seconds).toBeLessThanOrEqual(4);
  });

  it("returns 0 for a non-video buffer", async () => {
    const seconds = await probeVideoDurationSec(Buffer.from("not a video at all"));
    expect(seconds).toBe(0);
  });
});
