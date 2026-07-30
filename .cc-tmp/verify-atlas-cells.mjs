// Re-extract the two boards whose cells failed the assembled 8x9 atlas check and
// re-inspect each normalized frame the way validateStandardPetAtlas does.
// Read-only: nothing is written back to the database or object store.
import { readFileSync } from "node:fs";
import { extractPoseBoard, inspectFrame } from "./../packages/codex-pet-pipeline/src/index.ts";

const CASES = [
  { file: ".cc-tmp/pose-boards2/running-left-1.png", state: "running-left", frames: 8 },
  { file: ".cc-tmp/pose-boards2/failed-1.png", state: "failed", frames: 8 },
];

for (const testCase of CASES) {
  const board = readFileSync(testCase.file);
  const extracted = await extractPoseBoard(board, {
    columns: 4,
    rows: 2,
    frameCount: testCase.frames,
    chromaKey: "#00ff00",
  });
  console.log(`\n=== ${testCase.state} ===`);
  console.log(`board ok=${extracted.ok} errors=${JSON.stringify(extracted.errors)}`);
  console.log(`warnings=${JSON.stringify(extracted.warnings)}`);
  for (let index = 0; index < extracted.frames.length; index += 1) {
    const cell = await inspectFrame(extracted.frames[index], index);
    const flag = cell.errors.length ? "FAIL" : "ok  ";
    console.log(
      `  cell ${index} ${flag} components=${cell.componentCount} `
      + `errors=${JSON.stringify(cell.errors)} warnings=${JSON.stringify(cell.warnings)}`,
    );
  }
}
