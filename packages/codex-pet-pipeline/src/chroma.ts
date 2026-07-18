import sharp from "sharp";
import { DEFAULT_CHROMA_CANDIDATES } from "./constants.js";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface ChromaRemovalOptions {
  readonly key: string | RgbColor;
  readonly threshold?: number;
  readonly feather?: number;
}

export interface ChromaRemovalResult {
  readonly image: Buffer;
  readonly removedPixels: number;
  readonly softenedPixels: number;
  readonly totalPixels: number;
  readonly key: string;
  readonly threshold: number;
  readonly feather: number;
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function parseHexColor(value: string | RgbColor): RgbColor {
  if (typeof value !== "string") return { r: byte(value.r), g: byte(value.g), b: byte(value.b) };
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid RGB color: ${value}`);
  return { r: Number.parseInt(match[1]!, 16), g: Number.parseInt(match[2]!, 16), b: Number.parseInt(match[3]!, 16) };
}

export function formatHexColor(value: RgbColor): string {
  return `#${byte(value.r).toString(16).padStart(2, "0")}${byte(value.g).toString(16).padStart(2, "0")}${byte(value.b).toString(16).padStart(2, "0")}`;
}

export function colorDistance(a: RgbColor, b: RgbColor): number {
  // Red-mean weighted RGB distance is cheap and perceptually less misleading than plain RGB.
  const meanR = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((2 + meanR / 256) * dr * dr + 4 * dg * dg + (2 + (255 - meanR) / 256) * db * db);
}

export async function chooseChromaKey(
  reference: Buffer | readonly Buffer[],
  candidates: readonly string[] = DEFAULT_CHROMA_CANDIDATES,
): Promise<string> {
  if (candidates.length === 0) throw new Error("At least one chroma-key candidate is required");
  const samples: RgbColor[] = [];
  const references = Array.isArray(reference) ? reference : [reference];
  for (const item of references) {
    const { data, info } = await sharp(item)
      .ensureAlpha()
      .resize(48, 48, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let index = 0; index < info.width * info.height; index += 1) {
      const offset = index * info.channels;
      if ((data[offset + 3] ?? 255) < 64) continue;
      samples.push({ r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! });
    }
  }
  if (samples.length === 0) return formatHexColor(parseHexColor(candidates[0]!));

  let selected = candidates[0]!;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const rgb = parseHexColor(candidate);
    const distances = samples.map((sample) => colorDistance(rgb, sample)).sort((a, b) => a - b);
    // A low percentile protects against a small but important marking that happens to match the key.
    const score = distances[Math.floor((distances.length - 1) * 0.08)] ?? 0;
    if (score > selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return formatHexColor(parseHexColor(selected));
}

export async function removeChroma(
  input: Buffer,
  options: ChromaRemovalOptions,
): Promise<ChromaRemovalResult> {
  const key = parseHexColor(options.key);
  const threshold = Math.max(0, options.threshold ?? 86);
  const feather = Math.max(0, options.feather ?? 24);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let removedPixels = 0;
  let softenedPixels = 0;
  const opaqueStart = threshold + feather;
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * info.channels;
    const alpha = data[offset + 3]!;
    if (alpha === 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      continue;
    }
    const distance = colorDistance(
      { r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! },
      key,
    );
    if (distance <= threshold) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 0;
      removedPixels += 1;
    } else if (feather > 0 && distance < opaqueStart) {
      const factor = (distance - threshold) / feather;
      data[offset + 3] = byte(alpha * factor);
      softenedPixels += 1;
    }
  }
  const image = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer();
  return {
    image,
    removedPixels,
    softenedPixels,
    totalPixels: info.width * info.height,
    key: formatHexColor(key),
    threshold,
    feather,
  };
}

export async function countOpaqueKeyPixels(
  input: Buffer,
  keyInput: string | RgbColor,
  threshold = 32,
): Promise<number> {
  const key = parseHexColor(keyInput);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * info.channels;
    if (data[offset + 3]! < 32) continue;
    if (colorDistance({ r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! }, key) <= threshold) count += 1;
  }
  return count;
}
