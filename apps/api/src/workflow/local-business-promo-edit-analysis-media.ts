import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "./_shared/video-multimodal.js";
import { loadWorkflowMediaBuffer, loadWorkflowMediaFile } from "./_shared/workflow-media-loader.js";
import type { LocalBusinessPromoMaterial } from "./local-business-promo-core.js";
import { runCommand } from "./local-business-promo-render-ffmpeg.js";

const VIDEO_PREVIEW_MIN_FRAMES = 3;
const VIDEO_PREVIEW_MAX_FRAMES = 4;

interface PreviewFrame {
  readonly atSec: number;
  readonly block: ContentBlock;
}

function materialSource(material: LocalBusinessPromoMaterial) {
  return {
    url: material.url,
    mime: material.mime,
    objectKey: material.objectKey ?? null,
  };
}

function imageBlock(mime: string, data: string): ContentBlock {
  return { type: "image", source: { type: "base64", media_type: mime, data } };
}

function inputExtensionFromMime(mime: string): string {
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogv";
  return "mp4";
}

function previewFrameCount(durationSec: number): number {
  if (durationSec >= 60) return VIDEO_PREVIEW_MAX_FRAMES;
  return VIDEO_PREVIEW_MIN_FRAMES;
}

function previewMarginSec(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(2, Math.max(1, durationSec * 0.03));
}

function previewSampleTimes(durationSec: number, count: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  const margin = previewMarginSec(durationSec);
  if (count <= 1) return [Number(Math.min(durationSec / 2, Math.max(0, durationSec - margin)).toFixed(2))];
  const start = Math.min(margin, durationSec);
  const end = Math.max(start, durationSec - margin);
  const span = Math.max(0, end - start);
  return Array.from({ length: count }, (_, index) =>
    Number((start + (span * index) / (count - 1)).toFixed(2)));
}

async function extractVideoPreviewFrames(
  material: LocalBusinessPromoMaterial,
  fetchFn: typeof fetch,
): Promise<readonly PreviewFrame[]> {
  const workdir = await mkdtemp(join(tmpdir(), "local-business-promo-analysis-"));
  try {
    const inputPath = join(workdir, `input.${inputExtensionFromMime(material.mime)}`);
    await loadWorkflowMediaFile({
      source: materialSource(material),
      outputPath: inputPath,
      fetchFn,
      allowUrlFallback: material.objectKey ? false : undefined,
    });
    const times = previewSampleTimes(
      Math.max(0, material.durationSec || 0),
      previewFrameCount(Math.max(0, material.durationSec || 0)),
    );
    const frames: PreviewFrame[] = [];
    for (let index = 0; index < times.length; index += 1) {
      const atSec = times[index]!;
      const outputPath = join(workdir, `frame-${index + 1}.jpg`);
      await runCommand("ffmpeg", [
        "-y",
        "-ss", atSec.toFixed(2),
        "-i", inputPath,
        "-vf", "scale=640:640:force_original_aspect_ratio=decrease",
        "-frames:v", "1",
        "-threads", "1",
        "-q:v", "8",
        outputPath,
      ], { timeoutMs: 20_000 });
      const frame = await readFile(outputPath);
      frames.push({
        atSec,
        block: imageBlock("image/jpeg", frame.toString("base64")),
      });
    }
    return frames;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function buildMaterialBlocks(
  material: LocalBusinessPromoMaterial,
  index: number,
  fetchFn: typeof fetch,
): Promise<ContentBlock[]> {
  const name = material.name.trim() || `素材${index}`;
  if (material.mime.startsWith("video/")) {
    const frames = await extractVideoPreviewFrames(material, fetchFn);
    const previewLabel = frames.map((frame, frameIndex) => `${frameIndex + 1}@${frame.atSec}s`).join("、");
    return [
      {
        type: "text",
        text: `素材 ${index}：视频「${name}」，总时长约 ${material.durationSec || 0} 秒。以下按时间顺序给出 ${frames.length} 张预览帧，对应时间点约为 ${previewLabel}。`,
      },
      ...frames.map((frame) => frame.block),
    ];
  }

  const loaded = await loadWorkflowMediaBuffer({
    source: materialSource(material),
    fetchFn,
    allowUrlFallback: material.objectKey ? false : undefined,
  });
  return [
    { type: "text", text: `素材 ${index}：图片「${name}」。` },
    imageBlock(loaded.mime, loaded.buffer.toString("base64")),
  ];
}

export async function buildLocalBusinessPromoAnalysisBlocks(args: {
  readonly materials: readonly LocalBusinessPromoMaterial[];
  readonly fetchFn?: typeof fetch;
}): Promise<ContentBlock[]> {
  const fetchFn = args.fetchFn ?? fetch;
  const blocks: ContentBlock[] = [];
  for (let index = 0; index < args.materials.length; index += 1) {
    blocks.push(...await buildMaterialBlocks(args.materials[index]!, index + 1, fetchFn));
  }
  blocks.push({
    type: "text",
    text: "请基于以上候选素材完成镜头选择、字幕摆放建议与剪辑建议，并输出 JSON。若是视频素材，你看到的是按时间顺序抽取的预览帧，可据此估计最合适的起止秒。",
  });
  return blocks;
}
