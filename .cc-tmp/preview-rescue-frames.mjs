/** Render the frames the rescue would deliver into one contact sheet for eyeballing. */
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "./../packages/codex-pet-pipeline/node_modules/sharp/dist/index.cjs";
import { extractPoseBoard, petRowSpec } from "./../packages/codex-pet-pipeline/src/index.ts";

const spec = petRowSpec("running-right");
const attempt = Number(process.argv[2] ?? 1);
const extracted = await extractPoseBoard(readFileSync(`.cc-tmp/pose-boards/running-right-${attempt}.png`), {
  columns: spec.boardColumns,
  rows: spec.boardRows,
  frameCount: spec.frameCount,
  chromaKey: "#00ff00",
  requireUnusedSlotsEmpty: true,
});
console.log(`第 ${attempt} 次: ok=${extracted.ok} frames=${extracted.frames.length}`);
if (!extracted.frames.length) process.exit(1);

const meta = await sharp(extracted.frames[0]).metadata();
const w = meta.width, h = meta.height;
const pad = 8;
// Checkerboard so transparent gaps and stray holes are visible.
const sheet = sharp({
  create: {
    width: (w + pad) * extracted.frames.length + pad,
    height: h + pad * 2,
    channels: 4,
    background: { r: 240, g: 240, b: 240, alpha: 1 },
  },
}).composite(extracted.frames.map((frame, index) => ({
  input: frame,
  left: pad + index * (w + pad),
  top: pad,
})));
writeFileSync(`.cc-tmp/rescue-preview-${attempt}.png`, await sheet.png().toBuffer());
console.log(`帧尺寸 ${w}x${h}，已写出 .cc-tmp/rescue-preview-${attempt}.png`);
