let configured = false;
let sharpModule: Promise<typeof import("sharp")> | null = null;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function configuredFfmpegThreads(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.FFMPEG_THREADS, 1);
}

export async function loadSharp(env: NodeJS.ProcessEnv = process.env): Promise<typeof import("sharp")["default"]> {
  sharpModule ??= import("sharp");
  const sharp = (await sharpModule).default;
  if (configured) return sharp;
  sharp.concurrency(positiveInteger(env.SHARP_CONCURRENCY, 1));
  sharp.cache({
    memory: positiveInteger(env.SHARP_CACHE_MEMORY_MB, 32),
    files: positiveInteger(env.SHARP_CACHE_FILES, 10),
    items: positiveInteger(env.SHARP_CACHE_ITEMS, 50),
  });
  configured = true;
  return sharp;
}
