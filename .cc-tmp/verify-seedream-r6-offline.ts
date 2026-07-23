import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { colorDistance } from "@ai-assistant/codex-pet-pipeline";
import { normalizeSeedreamChromaMatte } from "../apps/api/src/workflow/codex-pet-visual.js";
import { DOUBAO_IMAGE_MODEL } from "../apps/api/src/workflow/image-service.js";

async function main(): Promise<void> {
  const directory = path.resolve(".cc-tmp/seedream-r6");
  const key = { r: 255, g: 0, b: 255 };
  const results: Array<Record<string, unknown>> = [];

  for (const candidate of [1, 2]) {
  const inputPath = path.join(directory, `candidate-${candidate}.png`);
  const outputPath = path.join(directory, `candidate-${candidate}-normalized.png`);
  const input = await sharp(inputPath).png().toBuffer();
  const normalized = await normalizeSeedreamChromaMatte(
    input,
    "one centered full-body desktop pet on a flat #ff00ff chroma background, readable inside a final 192x208 cell",
    DOUBAO_IMAGE_MODEL,
  );
  await writeFile(outputPath, normalized.buffer);

  const before = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(normalized.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (before.info.width !== after.info.width || before.info.height !== after.info.height) {
    throw new Error(`candidate ${candidate} changed dimensions`);
  }

  let edgePixels = 0;
  let exactKeyEdgePixels = 0;
  let exactKeyPixels = 0;
  let protectedForegroundPixels = 0;
  let preservedForegroundPixels = 0;
  for (let y = 0; y < after.info.height; y += 1) {
    for (let x = 0; x < after.info.width; x += 1) {
      const offset = (y * after.info.width + x) * after.info.channels;
      const afterRgb = { r: after.data[offset]!, g: after.data[offset + 1]!, b: after.data[offset + 2]! };
      const isExactKey = afterRgb.r === key.r && afterRgb.g === key.g && afterRgb.b === key.b;
      if (isExactKey) exactKeyPixels += 1;
      if (x === 0 || y === 0 || x === after.info.width - 1 || y === after.info.height - 1) {
        edgePixels += 1;
        if (isExactKey) exactKeyEdgePixels += 1;
      }

      const beforeRgb = { r: before.data[offset]!, g: before.data[offset + 1]!, b: before.data[offset + 2]! };
      if (colorDistance(beforeRgb, key) >= 400) {
        protectedForegroundPixels += 1;
        if (beforeRgb.r === afterRgb.r && beforeRgb.g === afterRgb.g && beforeRgb.b === afterRgb.b) {
          preservedForegroundPixels += 1;
        }
      }
    }
  }

  const centerOffset = (
    Math.floor(after.info.height / 2) * after.info.width + Math.floor(after.info.width / 2)
  ) * after.info.channels;
  const centerBefore = [...before.data.subarray(centerOffset, centerOffset + 3)];
  const centerAfter = [...after.data.subarray(centerOffset, centerOffset + 3)];
  const result = {
    candidate,
    inputPath,
    outputPath,
    width: after.info.width,
    height: after.info.height,
    exactKeyEdgeRatio: exactKeyEdgePixels / edgePixels,
    exactKeyCoverage: exactKeyPixels / (after.info.width * after.info.height),
    protectedForegroundPixels,
    preservedForegroundRatio: preservedForegroundPixels / protectedForegroundPixels,
    centerBefore,
    centerAfter,
    centerPreserved: centerBefore.every((value, index) => value === centerAfter[index]),
  };
    results.push(result);

    if (result.exactKeyEdgeRatio !== 1) throw new Error(`candidate ${candidate} has non-key outer-edge pixels`);
    if (result.preservedForegroundRatio < 0.999) throw new Error(`candidate ${candidate} lost protected foreground pixels`);
    if (!result.centerPreserved) throw new Error(`candidate ${candidate} changed its center foreground pixel`);
  }

  const report = { ok: true, mode: "offline-no-network", results };
  await writeFile(path.join(directory, "offline-normalization-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
