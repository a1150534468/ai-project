import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { buildMixArgs, mixBgmIntoVideo, clampBgmVolume } from "./dub-ffmpeg.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("clampBgmVolume", () => {
  it("裁剪到 [0,1]", () => {
    expect(clampBgmVolume(-1)).toBe(0);
    expect(clampBgmVolume(2)).toBe(1);
    expect(clampBgmVolume(0.3)).toBe(0.3);
  });
  it("非数字回退默认 0.3", () => {
    expect(clampBgmVolume(Number.NaN)).toBe(0.3);
  });
});

describe("buildMixArgs", () => {
  it("BGM 循环铺满、按视频音轨时长收尾、视频流直拷", () => {
    const a = buildMixArgs({ videoPath: "/v.mp4", bgmPath: "/b.mp3", outPath: "/o.mp4", bgmVolume: 0.3 });
    const s = a.join(" ");
    expect(s).toContain("-stream_loop -1");
    expect(s).toContain("volume=0.3");
    expect(s).toContain("duration=first");
    expect(s).toContain("-c:v copy");
    // -stream_loop 必须出现在 bgm 的 -i 之前
    expect(a.indexOf("-stream_loop")).toBeLessThan(a.lastIndexOf("-i"));
  });
});

describe.runIf(hasFfmpeg)("mixBgmIntoVideo（真实 ffmpeg）", () => {
  it("把 BGM 叠进带音轨的视频，输出可被 ffprobe 识别", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "dub-ffmpeg-test-"));
    const v = join(dir, "v.mp4"), b = join(dir, "b.mp3");
    try {
      // 2s 黑底视频 + 440Hz 人声轨；BGM = 1s 880Hz（短于视频，将被循环铺满）
      spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", v]);
      spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", b]);

      const out = await mixBgmIntoVideo({ videoBuffer: await readFile(v), bgmBuffer: await readFile(b), bgmVolume: 0.3 });
      expect(out.byteLength).toBeGreaterThan(0);

      const { probeVideoDurationSec } = await import("../_shared/video-probe.js");
      expect(await probeVideoDurationSec(out)).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("ffmpeg 失败时抛出可读错误（喂垃圾字节）", async () => {
    await expect(mixBgmIntoVideo({ videoBuffer: Buffer.from("not a video"), bgmBuffer: Buffer.from("not audio"), bgmVolume: 0.3 }))
      .rejects.toThrow(/混流失败/);
  }, 60_000);
});
