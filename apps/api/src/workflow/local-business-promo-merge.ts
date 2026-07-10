import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storeVideoMaterial, type StoredVideoMaterial } from "./video-service.js";
import { runCommand } from "./local-business-promo-render-ffmpeg.js";

export interface MergeLocalBusinessPromoClipsInput {
  readonly userId: string;
  readonly clipUrls: readonly string[];
  readonly fetchFn?: typeof fetch;
}

async function fetchClipBuffer(fetchFn: typeof fetch, url: string): Promise<Buffer> {
  const response = await fetchFn(url, { method: "GET" });
  if (!response.ok) throw new Error(`clip download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function mergeLocalBusinessPromoClips(input: MergeLocalBusinessPromoClipsInput): Promise<StoredVideoMaterial> {
  if (input.clipUrls.length === 0) throw new Error("没有可拼接的视频分段");
  const fetchFn = input.fetchFn ?? fetch;
  const workdir = await mkdtemp(join(tmpdir(), "local-business-promo-"));
  try {
    const clipPaths: string[] = [];
    for (let index = 0; index < input.clipUrls.length; index += 1) {
      const buffer = await fetchClipBuffer(fetchFn, input.clipUrls[index]!);
      const clipPath = join(workdir, `clip-${index + 1}.mp4`);
      await writeFile(clipPath, buffer);
      clipPaths.push(clipPath);
    }
    const concatListPath = join(workdir, "concat.txt");
    const concatList = clipPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(concatListPath, concatList);
    const outputPath = join(workdir, `merged-${randomUUID()}.mp4`);
    await runCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      outputPath,
    ], { timeoutMs: Math.max(30_000, input.clipUrls.length * 20_000) });
    const mergedBuffer = await readFile(outputPath);
    return storeVideoMaterial({
      userId: input.userId,
      filename: "local-business-promo-merged.mp4",
      mime: "video/mp4",
      buffer: mergedBuffer,
    });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
