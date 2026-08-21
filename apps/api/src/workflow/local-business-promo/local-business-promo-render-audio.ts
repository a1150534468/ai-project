import { runCommand } from "./local-business-promo-render-ffmpeg.js";

const AUDIO_CODEC = "aac";
const BGM_VOLUME = "0.34";
const AUDIO_BITRATE = "192k";

export async function muxAudio(args: {
  readonly baseVideoPath: string;
  readonly outputPath: string;
  readonly narrationPath?: string | null;
  readonly bgmPath?: string | null;
  readonly durationSec: number;
}): Promise<void> {
  const fadeStart = Math.max(0, args.durationSec - 1.5);
  if (!args.narrationPath && !args.bgmPath) {
    await runCommand("ffmpeg", [
      "-y",
      "-i", args.baseVideoPath,
      "-c", "copy",
      "-movflags", "+faststart",
      args.outputPath,
    ], { timeoutMs: Math.max(20_000, Math.ceil(args.durationSec * 4_000)) });
    return;
  }
  if (args.narrationPath && !args.bgmPath) {
    await runCommand("ffmpeg", [
      "-y",
      "-i", args.baseVideoPath,
      "-i", args.narrationPath,
      "-filter_complex", `[1:a]aresample=async=1:first_pts=0,volume=1,apad,atrim=0:${args.durationSec.toFixed(2)}[narr]`,
      "-map", "0:v:0",
      "-map", "[narr]",
      "-c:v", "copy",
      "-c:a", AUDIO_CODEC,
      "-b:a", AUDIO_BITRATE,
      "-t", args.durationSec.toFixed(2),
      "-movflags", "+faststart",
      args.outputPath,
    ], { timeoutMs: Math.max(30_000, Math.ceil(args.durationSec * 5_000)) });
    return;
  }
  if (!args.narrationPath && args.bgmPath) {
    await runCommand("ffmpeg", [
      "-y",
      "-i", args.baseVideoPath,
      "-stream_loop", "-1",
      "-i", args.bgmPath,
      "-filter_complex", `[1:a]aresample=async=1:first_pts=0,volume=${BGM_VOLUME},apad,atrim=0:${args.durationSec.toFixed(2)},afade=t=out:st=${fadeStart.toFixed(2)}:d=1.5[bgm]`,
      "-map", "0:v:0",
      "-map", "[bgm]",
      "-c:v", "copy",
      "-c:a", AUDIO_CODEC,
      "-b:a", AUDIO_BITRATE,
      "-t", args.durationSec.toFixed(2),
      "-movflags", "+faststart",
      args.outputPath,
    ], { timeoutMs: Math.max(30_000, Math.ceil(args.durationSec * 5_000)) });
    return;
  }
  await runCommand("ffmpeg", [
    "-y",
    "-i", args.baseVideoPath,
    "-i", args.narrationPath!,
    "-stream_loop", "-1",
    "-i", args.bgmPath!,
    "-filter_complex",
    `[1:a]aresample=async=1:first_pts=0,volume=1,apad,atrim=0:${args.durationSec.toFixed(2)},asplit=2[narr_mix][narr_side];` +
    `[2:a]aresample=async=1:first_pts=0,volume=${BGM_VOLUME},apad,atrim=0:${args.durationSec.toFixed(2)},afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeStart.toFixed(2)}:d=1.5[bgm];` +
    "[bgm][narr_side]sidechaincompress=threshold=0.035:ratio=10:attack=20:release=320:makeup=1[bgm_ducked];" +
    `[narr_mix][bgm_ducked]amix=inputs=2:duration=longest:dropout_transition=0,atrim=0:${args.durationSec.toFixed(2)}[mix]`,
    "-map", "0:v:0",
    "-map", "[mix]",
    "-c:v", "copy",
    "-c:a", AUDIO_CODEC,
    "-b:a", AUDIO_BITRATE,
    "-t", args.durationSec.toFixed(2),
    "-movflags", "+faststart",
    args.outputPath,
  ], { timeoutMs: Math.max(45_000, Math.ceil(args.durationSec * 6_000)) });
}
