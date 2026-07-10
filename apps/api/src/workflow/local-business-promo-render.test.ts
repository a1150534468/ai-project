import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { muxAudio } from "./local-business-promo-render.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const hasFfprobe = spawnSync("ffprobe", ["-version"]).status === 0;

function runOrThrow(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error(result.stderr || `${command} exited with code ${result.status}`);
}

function probeDurationSec(path: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffprobe exited with code ${result.status}`);
  }
  return Number(result.stdout.trim());
}

function probeCodecTypes(path: string): string {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffprobe exited with code ${result.status}`);
  }
  return result.stdout.trim();
}

describe.runIf(hasFfmpeg && hasFfprobe)("local-business-promo-render muxAudio", () => {
  it("pads a short narration so the final video keeps the target duration without bgm", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-business-promo-render-test-"));
    try {
      const baseVideoPath = join(dir, "base.mp4");
      const narrationPath = join(dir, "narration.wav");
      const outputPath = join(dir, "out-no-bgm.mp4");
      runOrThrow("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=4", "-pix_fmt", "yuv420p", baseVideoPath]);
      runOrThrow("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.8", "-c:a", "pcm_s16le", narrationPath]);

      await muxAudio({
        baseVideoPath,
        narrationPath,
        outputPath,
        durationSec: 4,
      });

      const durationSec = probeDurationSec(outputPath);
      expect(durationSec).toBeGreaterThanOrEqual(3.8);
      expect(durationSec).toBeLessThanOrEqual(4.2);
      expect(probeCodecTypes(outputPath)).toContain("video");
      expect(probeCodecTypes(outputPath)).toContain("audio");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("pads a short narration before mixing bgm so the final video keeps the target duration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-business-promo-render-test-"));
    try {
      const baseVideoPath = join(dir, "base.mp4");
      const narrationPath = join(dir, "narration.wav");
      const bgmPath = join(dir, "bgm.mp3");
      const outputPath = join(dir, "out-with-bgm.mp4");
      runOrThrow("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=4", "-pix_fmt", "yuv420p", baseVideoPath]);
      runOrThrow("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.8", "-c:a", "pcm_s16le", narrationPath]);
      runOrThrow("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=1.2", bgmPath]);

      await muxAudio({
        baseVideoPath,
        narrationPath,
        bgmPath,
        outputPath,
        durationSec: 4,
      });

      const durationSec = probeDurationSec(outputPath);
      expect(durationSec).toBeGreaterThanOrEqual(3.8);
      expect(durationSec).toBeLessThanOrEqual(4.2);
      expect(probeCodecTypes(outputPath)).toContain("video");
      expect(probeCodecTypes(outputPath)).toContain("audio");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
