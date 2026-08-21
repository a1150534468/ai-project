import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUB_MIX_TIMEOUT_MS, DUB_BGM_VOLUME_MIN, DUB_BGM_VOLUME_MAX } from "./dub-constants.js";

const DEFAULT_BGM_VOLUME = 0.3;

export function clampBgmVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_BGM_VOLUME;
  return Math.min(DUB_BGM_VOLUME_MAX, Math.max(DUB_BGM_VOLUME_MIN, v));
}

// BGM 用 -stream_loop -1 无限循环铺满；amix duration=first 以视频原音轨（口播人声）时长收尾；视频流直拷不重编码。
function configuredThreads(): number {
  const value = Number(process.env.FFMPEG_THREADS);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function buildMixArgs(a: { videoPath: string; bgmPath: string; outPath: string; bgmVolume: number; threads?: number }): string[] {
  return [
    "-y",
    "-i", a.videoPath,
    "-stream_loop", "-1", "-i", a.bgmPath,
    "-filter_complex", `[1:a]volume=${a.bgmVolume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-threads", String(a.threads ?? configuredThreads()), "-shortest",
    a.outPath,
  ];
}

export async function mixBgmIntoVideo(args: {
  videoBuffer: Buffer; bgmBuffer: Buffer; bgmVolume: number; timeoutMs?: number;
}): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "dub-mix-"));
  const videoPath = join(dir, `${randomUUID()}.mp4`);
  const bgmPath = join(dir, `${randomUUID()}.audio`);
  const outPath = join(dir, `${randomUUID()}-out.mp4`);
  try {
    await writeFile(videoPath, args.videoBuffer);
    await writeFile(bgmPath, args.bgmBuffer);
    await mixBgmFiles({
      videoPath,
      bgmPath,
      outPath,
      bgmVolume: args.bgmVolume,
      timeoutMs: args.timeoutMs,
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function mixBgmFiles(args: {
  readonly videoPath: string;
  readonly bgmPath: string;
  readonly outPath: string;
  readonly bgmVolume: number;
  readonly timeoutMs?: number;
}): Promise<void> {
  await runFfmpeg(
    buildMixArgs({
      videoPath: args.videoPath,
      bgmPath: args.bgmPath,
      outPath: args.outPath,
      bgmVolume: clampBgmVolume(args.bgmVolume),
    }),
    args.timeoutMs ?? DUB_MIX_TIMEOUT_MS,
  );
}

function runFfmpeg(argv: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffmpeg", argv);
    } catch {
      done(new Error("BGM 混流失败：ffmpeg 未安装"));
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr = (stderr + c.toString()).slice(-2000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(new Error("BGM 混流超时")); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(new Error("BGM 混流失败：ffmpeg 无法执行")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? undefined : new Error(`BGM 混流失败（ffmpeg ${code}）：${stderr.slice(-300)}`));
    });
  });
}
