/**
 * Detail the frames that still fail after the tolerance change, so the
 * remaining thresholds are chosen from measurements rather than intuition.
 */
import { readFileSync } from "node:fs";
import { extractPoseBoard, petRowSpec } from "./../packages/codex-pet-pipeline/src/index.ts";

const TARGETS = [
  ["idle", 1], ["running-right", 1], ["running-right", 2], ["running-right", 3],
  ["running-right", 5], ["running-right", 6], ["running-right", 10],
];

for (const [state, attempt] of TARGETS) {
  const spec = petRowSpec(state);
  const board = readFileSync(`.cc-tmp/pose-boards/${state}-${attempt}.png`);
  const extracted = await extractPoseBoard(board, {
    columns: spec.boardColumns,
    rows: spec.boardRows,
    frameCount: spec.frameCount,
    chromaKey: "#00ff00",
    requireUnusedSlotsEmpty: true,
  });
  if (extracted.ok) continue;
  console.log(`\n=== ${state}-${attempt} ===`);
  for (const d of extracted.diagnostics) {
    if (d.errors.length === 0) continue;
    console.log(`  frame-${d.index}: ${d.errors.join(", ")}`);
    console.log(`    opaque=${d.opaquePixels} totalHoles=${d.internalTransparentPixels} (${(d.internalTransparentPixels / d.opaquePixels * 100).toFixed(2)}% of sprite)`);
    console.log(`    regions: ${d.enclosedRegions.slice(0, 5).map((r) => `${r.pixels}px(${(r.pixels / d.opaquePixels * 100).toFixed(2)}%,inset${r.insetRatio.toFixed(2)})`).join(" ")}`);
    const primary = d.foregroundComponents.reduce((a, b) => !a || b.pixels > a.pixels ? b : a, null);
    console.log(`    components: ${d.foregroundComponents.map((c) => {
      const pct = primary ? (c.pixels / primary.pixels * 100).toFixed(2) : "?";
      return `${c.pixels}px(${pct}% of primary, box ${c.bounds.width}x${c.bounds.height} at ${c.bounds.left},${c.bounds.top}, edge${c.edgePixels})`;
    }).join("\n                ")}`);
  }
}
