import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { buildCompressArgs, needsCompression, COMPRESS_LADDER, VISION_MAX_RAW_BYTES, compressForVision } from "./video-compress.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("needsCompression", () => {
  it("小于阈值不压", () => {
    expect(needsCompression(1024)).toBe(false);
    expect(needsCompression(VISION_MAX_RAW_BYTES - 1)).toBe(false);
  });
  it("达到阈值就压", () => {
    expect(needsCompression(VISION_MAX_RAW_BYTES)).toBe(true);
  });
});

describe("buildCompressArgs", () => {
  it("保留音轨（对口型文稿转写依赖人声），缩放降码率", () => {
    const a = buildCompressArgs({ inPath: "/i.mp4", outPath: "/o.mp4", ...COMPRESS_LADDER[0] });
    const s = a.join(" ");
    expect(s).toContain("-c:a aac"); // 必须保留音频，否则模型听不到台词
    expect(s).toContain("-c:v libx264");
    expect(s).toContain(`-crf ${COMPRESS_LADDER[0].crf}`);
    expect(s).toContain("scale=");
    expect(a[a.length - 1]).toBe("/o.mp4");
  });
  it("阶梯逐级更狠：宽度不增、crf 不减", () => {
    for (let i = 1; i < COMPRESS_LADDER.length; i++) {
      expect(COMPRESS_LADDER[i].maxWidth).toBeLessThanOrEqual(COMPRESS_LADDER[i - 1].maxWidth);
      expect(COMPRESS_LADDER[i].crf).toBeGreaterThanOrEqual(COMPRESS_LADDER[i - 1].crf);
    }
  });
});

describe.runIf(hasFfmpeg)("compressForVision（真实 ffmpeg）", () => {
  it("小视频原样返回，不重编码", async () => {
    const tiny = Buffer.alloc(1000, 1);
    const out = await compressForVision(tiny);
    expect(out).toBe(tiny);
  });

  it("压缩后仍保留音轨", async () => {
    const tmp = process.env.TMPDIR ?? "/tmp";
    const src = `${tmp}/vc-src.mp4`;
    // 3s 视频 + 正弦人声占位
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=640x480:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const out = await compressForVision(readFileSync(src), { forceCompress: true });
    const outPath = `${tmp}/vc-out.mp4`;
    writeFileSync(outPath, out);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", outPath]);
    expect(probe.stdout.toString()).toContain("audio");
    expect(probe.stdout.toString()).toContain("video");
  }, 90_000);
});
