import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { removeChroma } from "@ai-assistant/codex-pet-pipeline";

async function main(): Promise<void> {
  const source = await readFile(process.argv[2]!);
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) throw new Error("missing dimensions");
  for (const slot of [0, 1, 4, 5]) {
  const column = slot % 4;
  const row = Math.floor(slot / 4);
  const left = Math.floor(column * metadata.width / 4);
  const right = Math.floor((column + 1) * metadata.width / 4);
  const top = Math.floor(row * metadata.height / 2);
  const bottom = Math.floor((row + 1) * metadata.height / 2);
  const tile = await sharp(source).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
  const removed = await removeChroma(tile, { key: "#ff00ff" });
  const { data, info } = await sharp(removed.image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = data[index * info.channels + 3]! >= 24 ? 1 : 0;
  const queue = new Int32Array(mask.length);
  const visited = new Uint8Array(mask.length);
  const components: Array<Record<string, number>> = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    let minX = info.width;
    let maxX = -1;
    let minY = info.height;
    let maxY = -1;
    queue[tail++] = seed;
    visited[seed] = 1;
    while (head < tail) {
      const current = queue[head++]!;
      const x = current % info.width;
      const y = Math.floor(current / info.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const neighbor of [x > 0 ? current - 1 : -1, x + 1 < info.width ? current + 1 : -1, y > 0 ? current - info.width : -1, y + 1 < info.height ? current + info.width : -1]) {
        if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    components.push({ pixels: tail, left: minX, right: maxX, top: minY, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
    console.log(JSON.stringify({ slot, width: info.width, height: info.height, components: components.sort((a, b) => b.pixels! - a.pixels!) }, null, 2));
  }
}

void main();
