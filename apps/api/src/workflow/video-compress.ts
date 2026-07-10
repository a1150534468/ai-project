import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * gemini 原生 inline_data 的请求体上限约 20MB，base64 会把体积放大 4/3，
 * 所以原始视频必须压到 ~14MB 以内。这里留出余量取 12MB。
 * 音轨必须保留：口播文稿是靠模型「听」出来的。
 */
export const VISION_MAX_RAW_BYTES = 12 * 1024 * 1024;
export const COMPRESS_TIMEOUT_MS = 180_000;

export interface CompressStep { readonly maxWidth: number; readonly crf: number; readonly fps: number; readonly audioKbps: number }

/** 逐级加狠：先保画质，实在超限再降。 */
export const COMPRESS_LADDER: readonly CompressStep[] = [
  { maxWidth: 640, crf: 30, fps: 15, audioKbps: 64 },
  { maxWidth: 480, crf: 34, fps: 12, audioKbps: 48 },
  { maxWidth: 360, crf: 38, fps: 8, audioKbps: 32 },
];

export function needsCompression(bytes: number): boolean {
  return bytes >= VISION_MAX_RAW_BYTES;
}

export function buildCompressArgs(a: { inPath: string; outPath: string; maxWidth: number; crf: number; fps: number; audioKbps: number }): string[] {
  return [
    "-y", "-i", a.inPath,
    "-vf", `scale='min(${a.maxWidth},iw)':-2`,
    "-r", String(a.fps),
    "-c:v", "libx264", "-crf", String(a.crf), "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", `${a.audioKbps}k`, "-ac", "1",
    "-movflags", "+faststart",
    a.outPath,
  ];
}

export interface CompressOpts { readonly forceCompress?: boolean; readonly timeoutMs?: number }

/** 已够小则原样返回（不重编码，省时且不掉画质）；否则沿阶梯压到限额内，压不下去就抛错。 */
export async function compressForVision(buffer: Buffer, opts: CompressOpts = {}): Promise<Buffer> {
  if (!opts.forceCompress && !needsCompression(buffer.byteLength)) return buffer;

  const dir = await mkdtemp(join(tmpdir(), "vis-compress-"));
  const inPath = join(dir, `${randomUUID()}.mp4`);
  try {
    await writeFile(inPath, buffer);
    for (const step of COMPRESS_LADDER) {
      const outPath = join(dir, `${randomUUID()}-out.mp4`);
      await runFfmpeg(buildCompressArgs({ inPath, outPath, ...step }), opts.timeoutMs ?? COMPRESS_TIMEOUT_MS);
      const out = await readFile(outPath);
      if (out.byteLength < VISION_MAX_RAW_BYTES) return out;
    }
    throw new Error("视频过大，压缩后仍超出模型可接收上限，请上传更短的视频");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpeg(argv: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn("ffmpeg", argv); } catch { done(new Error("ffmpeg 未安装")); return; }
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr = (stderr + c.toString()).slice(-2000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(new Error("视频压缩超时")); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(new Error("ffmpeg 未安装或无法执行")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? undefined : new Error(`视频压缩失败（ffmpeg ${code}）：${stderr.slice(-200)}`));
    });
  });
}
