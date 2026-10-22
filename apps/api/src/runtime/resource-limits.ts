import { envInt } from "./env.js";

let configured = false;
let sharpModule: Promise<typeof import("sharp")> | null = null;

export async function loadSharp(env: NodeJS.ProcessEnv = process.env): Promise<typeof import("sharp")["default"]> {
  sharpModule ??= import("sharp");
  const sharp = (await sharpModule).default;
  if (configured) return sharp;
  sharp.concurrency(envInt(env, "SHARP_CONCURRENCY", 1));
  sharp.cache({
    memory: envInt(env, "SHARP_CACHE_MEMORY_MB", 32),
    files: envInt(env, "SHARP_CACHE_FILES", 10),
    items: envInt(env, "SHARP_CACHE_ITEMS", 50),
  });
  configured = true;
  return sharp;
}
