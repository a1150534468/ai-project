/**
 * codex-pet-visual 拆分后的 Seedream(豆包)适配层:提示词改写、chroma matte 归一化、
 * 姿态板构造参考图、步态相位挑选。
 *
 * 这一层存在的唯一原因是 Seedream 的三个真实脾气:
 *  1. 它会把 `#ff00ff` 这种 hex 字面量当文字画到图上 —— 所以对 doubao 走自然语言
 *     色名,同时保留落库的 key 色(`adaptCodexPetPromptForModel`)。
 *  2. 它给的抠图边缘不稳 —— `normalizeSeedreamChromaMatte` 按边框采样自适应阈值,
 *     覆盖率落在 5%~95% 之外就直接抛,不把坏图往下游放。
 *  3. 它会照抄常规布局参考图上的标签与虚线框 —— 所以给它的是"每格一个完整已通过
 *     角色、无标签、真 chroma 底"的构造参考图(`createSeedreamPoseBoardScaffold`),
 *     且构造图必须与 prompt 的 columns:rows 同比例,否则它会把角色跨行切开。
 *
 * `petPipelineModule` 是本文件独占的模块级缓存(动态 import 管道包),别再复制一份。
 *
 * 依赖方向:本文件 → image。不 import client / qa / direction。
 */

import { Buffer } from "node:buffer";
import { DOUBAO_IMAGE_MODEL } from "../_shared/image-service.js";
import { loadSharp } from "../../runtime/resource-limits.js";

let petPipelineModule: Promise<typeof import("@ai-assistant/codex-pet-pipeline")> | null = null;

function loadPetPipeline(): Promise<typeof import("@ai-assistant/codex-pet-pipeline")> {
  petPipelineModule ??= import("@ai-assistant/codex-pet-pipeline");
  return petPipelineModule;
}

const SEEDREAM_CHROMA_NAMES: Readonly<Record<string, string>> = {
  "#ff00ff": "a perfectly flat solid hot-magenta chroma-key background",
  "#00ff00": "a perfectly flat solid bright-green chroma-key background",
  "#0000ff": "a perfectly flat solid pure-blue chroma-key background",
};

/** Seedream tends to render literal hex tokens as visible text. Keep those
 * tokens in the provider-neutral prompt for GPT/Qwen, but use natural-language
 * color instructions for Seedream while retaining the persisted key color. */
export function adaptCodexPetPromptForModel(prompt: string, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  if (model !== DOUBAO_IMAGE_MODEL && !normalizedModel.startsWith("doubao")) return prompt;
  const adapted = prompt.replace(/#[0-9a-f]{6}/gi, (value) => (
    SEEDREAM_CHROMA_NAMES[value.toLowerCase()] ?? "a perfectly flat solid chroma-key background"
  ));
  return `${adapted}\nSeedream production constraint: the chroma-key matte is only a background-removal aid. Never draw or print the color name, hex code, RGB values, labels, symbols, or any other text anywhere in the image. Do not add a ground plane, floor strip, contact shadow, cast shadow, glow, vignette, gradient, texture, lighting variation, or decorative background detail.`;
}

export async function normalizeSeedreamChromaMatte(
  input: Buffer,
  originalPrompt: string,
  model: string,
): Promise<{ readonly buffer: Buffer; readonly mime: string }> {
  if (model !== DOUBAO_IMAGE_MODEL && !model.trim().toLowerCase().startsWith("doubao")) {
    return { buffer: input, mime: "" };
  }
  const keyToken = originalPrompt.match(/#[0-9a-f]{6}/i)?.[0];
  if (!keyToken) return { buffer: input, mime: "" };
  const sharp = await loadSharp();
  const { colorDistance, parseHexColor, removeChroma } = await loadPetPipeline();
  const key = parseHexColor(keyToken);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const border = Math.max(1, Math.floor(Math.min(info.width, info.height) * 0.02));
  const distances: number[] = [];
  const sample = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    distances.push(colorDistance({ r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! }, key));
  };
  const stride = Math.max(1, Math.floor(Math.max(info.width, info.height) / 512));
  for (let y = 0; y < info.height; y += stride) {
    for (let x = 0; x < info.width; x += stride) {
      if (x < border || x >= info.width - border || y < border || y >= info.height - border) sample(x, y);
    }
  }
  distances.sort((a, b) => a - b);
  const edgeDistance = distances[Math.floor(Math.max(0, distances.length - 1) * 0.995)] ?? 86;
  const threshold = Math.min(380, Math.max(86, Math.ceil(edgeDistance + 12)));
  const removed = await removeChroma(input, { key, threshold, feather: 20 });
  const coverage = removed.totalPixels > 0
    ? (removed.removedPixels + removed.softenedPixels) / removed.totalPixels
    : 0;
  if (coverage < 0.05 || coverage > 0.95) {
    throw new Error(`Seedream chroma normalization produced unsafe coverage: ${coverage.toFixed(4)}`);
  }
  const layout = originalPrompt.match(/(\d+)\s*columns?\s*[×x]\s*(\d+)\s*rows?/i)
    ?? originalPrompt.match(/(\d+)\s*[×x]\s*(\d+)\s*(?:pose\s+)?board/i);
  const columns = layout ? Number(layout[1]) : null;
  const rows = layout ? Number(layout[2]) : null;
  const targetWidth = info.width;
  const targetHeight = columns && rows && columns > 0 && rows > 0
    ? Math.max(1, Math.round(targetWidth * rows / columns))
    : info.height;
  let buffer: Buffer;
  if (columns && rows) {
    const composites: Array<{ readonly input: Buffer; readonly left: number; readonly top: number }> = [];
    const slotWidth = targetWidth / columns;
    const slotHeight = targetHeight / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const sourceLeft = Math.floor(column * info.width / columns);
        const sourceTop = Math.floor(row * info.height / rows);
        const sourceRight = Math.floor((column + 1) * info.width / columns);
        const sourceBottom = Math.floor((row + 1) * info.height / rows);
        const tile = await sharp(removed.image).extract({
          left: sourceLeft,
          top: sourceTop,
          width: sourceRight - sourceLeft,
          height: sourceBottom - sourceTop,
        }).png().toBuffer();
        const contentWidth = Math.max(1, Math.floor(slotWidth * 0.82));
        const contentHeight = Math.max(1, Math.floor(slotHeight * 0.82));
        const resized = await sharp(tile).resize({
          width: contentWidth,
          height: contentHeight,
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        }).png().toBuffer();
        composites.push({
          input: resized,
          left: Math.round(column * slotWidth + (slotWidth - contentWidth) / 2),
          top: Math.round(row * slotHeight + (slotHeight - contentHeight) / 2),
        });
      }
    }
    buffer = await sharp({
      create: { width: targetWidth, height: targetHeight, channels: 4, background: keyToken },
    }).composite(composites).png().toBuffer();
  } else {
    const resized = await sharp(removed.image).png().toBuffer();
    buffer = await sharp({
      create: { width: targetWidth, height: targetHeight, channels: 4, background: keyToken },
    }).composite([{ input: resized }]).png().toBuffer();
  }
  return { buffer, mime: "image/png" };
}

/**
 * Seedream frequently copies labels and dashed borders from a conventional
 * layout guide. Give it a safe, label-free construction reference instead:
 * one complete approved character per target slot on the real chroma matte.
 * This is guidance only; the generation prompt still owns every action pose.
 */
export async function createSeedreamPoseBoardScaffold(input: {
  readonly canonical: Buffer;
  /** Optional already-paid pose phases used only as construction evidence. */
  readonly poseVariants?: readonly Buffer[];
  /** Zero-based variant index for each target slot; defaults to round-robin. */
  readonly variantSequence?: readonly number[];
  readonly chromaKey: string;
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
  readonly width?: number;
  readonly height?: number;
}): Promise<Buffer> {
  const sharp = await loadSharp();
  const { parseHexColor, removeChroma } = await loadPetPipeline();
  // Seedream preserves the prompt's square target slots much more reliably
  // when the construction reference uses the same columns:rows aspect ratio.
  // A fixed 1536x1024 canvas is correct for 3x2 idle, but it turns a 4x2 gait
  // board into 3:2 and can make the provider split each character across rows.
  const width = input.width
    ?? (input.height ? Math.round(input.height * input.columns / input.rows) : 1536);
  const height = input.height ?? Math.round(width * input.rows / input.columns);
  if (!Number.isInteger(input.columns) || input.columns < 1
    || !Number.isInteger(input.rows) || input.rows < 1
    || !Number.isInteger(input.frameCount) || input.frameCount < 1
    || input.frameCount > input.columns * input.rows
    || !Number.isInteger(width) || width < 1
    || !Number.isInteger(height) || height < 1) {
    throw new Error("Seedream scaffold requires a valid positive layout and frame count");
  }
  if (Math.abs(width / input.columns - height / input.rows) > 1) {
    throw new Error("Seedream scaffold must use square slots matching the requested columns:rows aspect ratio");
  }
  const sources = input.poseVariants?.length ? [...input.poseVariants] : [input.canonical];
  const sequence = input.variantSequence
    ? [...input.variantSequence]
    : Array.from({ length: input.frameCount }, (_, index) => index % sources.length);
  if (sequence.length !== input.frameCount
    || sequence.some((value) => !Number.isInteger(value) || value < 0 || value >= sources.length)) {
    throw new Error("Seedream scaffold variant sequence must select one available pose per frame");
  }

  const trimmedVariants = await Promise.all(sources.map(async (source) => {
    const removed = await removeChroma(source, {
      key: parseHexColor(input.chromaKey),
      threshold: 96,
      feather: 16,
    });
    return sharp(removed.image)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }));
  const composites: Array<{ readonly input: Buffer; readonly left: number; readonly top: number }> = [];
  for (let index = 0; index < input.frameCount; index += 1) {
    const column = index % input.columns;
    const row = Math.floor(index / input.columns);
    const slotLeft = Math.floor(column * width / input.columns);
    const slotRight = Math.floor((column + 1) * width / input.columns);
    const slotTop = Math.floor(row * height / input.rows);
    const slotBottom = Math.floor((row + 1) * height / input.rows);
    const slotWidth = slotRight - slotLeft;
    const slotHeight = slotBottom - slotTop;
    const contentWidth = Math.max(1, Math.floor(slotWidth * 0.64));
    const contentHeight = Math.max(1, Math.floor(slotHeight * 0.72));
    const sprite = await sharp(trimmedVariants[sequence[index]!]!).resize({
      width: contentWidth,
      height: contentHeight,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png({ compressionLevel: 9 }).toBuffer();
    composites.push({
      input: sprite,
      left: slotLeft + Math.floor((slotWidth - contentWidth) / 2),
      top: slotTop + Math.floor(slotHeight * 0.1),
    });
  }
  return sharp({
    create: { width, height, channels: 4, background: input.chromaKey },
  }).composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

/** Pick one stable first phase and the most visually distinct paid phase. */
export async function selectSeedreamGaitScaffoldVariants(
  frames: readonly Buffer[],
): Promise<readonly [Buffer, Buffer]> {
  if (frames.length < 2) throw new Error("Seedream gait scaffold requires at least two source phases");
  const sharp = await loadSharp();
  const decoded = await Promise.all(frames.map((frame) => (
    sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  )));
  const anchor = decoded[0]!;
  let selectedIndex = 1;
  let selectedScore = -1;
  for (let index = 1; index < decoded.length; index += 1) {
    const candidate = decoded[index]!;
    if (candidate.info.width !== anchor.info.width
      || candidate.info.height !== anchor.info.height
      || candidate.info.channels !== anchor.info.channels) {
      throw new Error("Seedream gait scaffold phases must share one normalized geometry");
    }
    let score = 0;
    for (let offset = 0; offset < anchor.data.length; offset += 1) {
      score += Math.abs(anchor.data[offset]! - candidate.data[offset]!);
    }
    if (score > selectedScore) {
      selectedScore = score;
      selectedIndex = index;
    }
  }
  return [frames[0]!, frames[selectedIndex]!];
}
