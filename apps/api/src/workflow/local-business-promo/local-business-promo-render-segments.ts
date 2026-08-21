import { writeFile } from "node:fs/promises";
import { outputSize } from "./local-business-promo-overlay.js";
import { runCommand } from "./local-business-promo-render-ffmpeg.js";
import type { RenderShotArgs } from "./local-business-promo-render-support.js";

const FRAME_RATE = 30;
const VIDEO_CODEC = "libx264";
const VIDEO_PRESET = "veryfast";
const VIDEO_CRF = "23";

function renderCommandTimeoutMs(durationSec: number, minimumMs = 20_000): number {
  return Math.max(minimumMs, Math.ceil(Math.max(1, durationSec) * 6_000));
}

async function normalizeStillImage(inputPath: string, outputPath: string): Promise<void> {
  try {
    await runCommand("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-frames:v", "1",
      "-pix_fmt", "rgba",
      outputPath,
    ], { timeoutMs: 15_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`图片素材解码失败：${message}`);
  }
}

function containBlurGraph(args: {
  readonly width: number;
  readonly height: number;
  readonly padDuration: number;
  readonly overlayInputIndex?: number | null;
}): { graph: string; mapLabel: string } {
  const chains = [
    `[0:v]split=2[fg][bg]`,
    `[bg]scale=${args.width}:${args.height}:force_original_aspect_ratio=increase,crop=${args.width}:${args.height},boxblur=20:2[bgfill]`,
    `[fg]scale=${args.width}:${args.height}:force_original_aspect_ratio=decrease[fgfit]`,
    "[bgfill][fgfit]overlay=(W-w)/2:(H-h)/2[visual]",
  ];
  let upstreamLabel = "[visual]";
  if (args.overlayInputIndex != null) {
    chains.push(`[visual][${args.overlayInputIndex}:v]overlay=0:0:eof_action=repeat[with_overlay]`);
    upstreamLabel = "[with_overlay]";
  }
  chains.push(`${upstreamLabel}fps=${FRAME_RATE},tpad=stop_mode=clone:stop_duration=${args.padDuration.toFixed(2)},format=yuv420p[base]`);
  return {
    graph: chains.join(";"),
    mapLabel: "[base]",
  };
}

export async function renderVideoShot(args: RenderShotArgs): Promise<void> {
  const { width, height } = outputSize(args.aspectRatio);
  const sourceStart = Math.max(0, args.shot.sourceStartSec ?? 0);
  const sourceEnd = Math.max(sourceStart + 0.5, args.shot.sourceEndSec ?? sourceStart + args.shot.durationSec);
  const sourceDuration = Math.max(0.5, sourceEnd - sourceStart);
  const padDuration = Math.max(0, args.shot.durationSec - sourceDuration);
  const filterGraph = containBlurGraph({
    width,
    height,
    padDuration,
    overlayInputIndex: args.overlayPath ? 1 : null,
  });
  const commandArgs = [
    "-y",
    "-ss", sourceStart.toFixed(2),
    "-to", sourceEnd.toFixed(2),
    "-i", args.inputPath,
  ];
  if (args.overlayPath) {
    commandArgs.push("-loop", "1", "-i", args.overlayPath);
  }
  commandArgs.push(
    "-filter_complex", filterGraph.graph,
    "-map", filterGraph.mapLabel,
    "-an",
    "-t", String(args.shot.durationSec),
    "-c:v", VIDEO_CODEC,
    "-preset", VIDEO_PRESET,
    "-crf", VIDEO_CRF,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    args.outputPath,
  );
  await runCommand("ffmpeg", commandArgs, {
    timeoutMs: renderCommandTimeoutMs(args.shot.durationSec, 30_000),
  });
}

export async function renderImageShot(args: RenderShotArgs): Promise<void> {
  const normalizedInputPath = `${args.outputPath}.source.png`;
  await normalizeStillImage(args.inputPath, normalizedInputPath);
  const { width, height } = outputSize(args.aspectRatio);
  const filterGraph = containBlurGraph({
    width,
    height,
    padDuration: 0,
    overlayInputIndex: args.overlayPath ? 1 : null,
  });
  const commandArgs = [
    "-y",
    "-loop", "1",
    "-i", normalizedInputPath,
  ];
  if (args.overlayPath) {
    commandArgs.push("-loop", "1", "-i", args.overlayPath);
  }
  commandArgs.push(
    "-filter_complex", filterGraph.graph,
    "-map", filterGraph.mapLabel,
    "-an",
    "-t", String(args.shot.durationSec),
    "-c:v", VIDEO_CODEC,
    "-preset", VIDEO_PRESET,
    "-crf", VIDEO_CRF,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    args.outputPath,
  );
  await runCommand("ffmpeg", commandArgs, {
    timeoutMs: renderCommandTimeoutMs(args.shot.durationSec, 30_000),
  });
}

export async function concatSegments(segmentPaths: readonly string[], outputPath: string): Promise<void> {
  const concatListPath = `${outputPath}.txt`;
  const listBody = segmentPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(concatListPath, listBody);
  await runCommand("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    outputPath,
  ], {
    timeoutMs: Math.max(30_000, segmentPaths.length * 20_000),
  });
}
