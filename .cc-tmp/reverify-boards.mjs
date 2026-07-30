/**
 * Re-run the extractor over the 13 already-paid 老鼠猫 boards in both strictness
 * modes. Read-only: loads PNGs from disk, touches no database and no storage.
 *
 *   node --import tsx .cc-tmp/reverify-boards.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { extractPoseBoard, petRowSpec } from "./../packages/codex-pet-pipeline/src/index.ts";

const DIR = ".cc-tmp/pose-boards";
const CHROMA = "#00ff00";

const files = readdirSync(DIR).filter((name) => name.endsWith(".png")).sort((a, b) => {
  const parse = (name) => {
    const [, state, attempt] = /^(.*)-(\d+)\.png$/.exec(name) ?? [];
    return [state ?? name, Number(attempt ?? 0)];
  };
  const [stateA, attemptA] = parse(a);
  const [stateB, attemptB] = parse(b);
  return stateA === stateB ? attemptA - attemptB : String(stateA).localeCompare(String(stateB));
});

const summary = [];
for (const file of files) {
  const [, state, attempt] = /^(.*)-(\d+)\.png$/.exec(file) ?? [];
  const spec = petRowSpec(state);
  const board = readFileSync(`${DIR}/${file}`);
  const base = {
    columns: spec.boardColumns,
    rows: spec.boardRows,
    frameCount: spec.frameCount,
    chromaKey: CHROMA,
    requireUnusedSlotsEmpty: true,
  };
  const strict = await extractPoseBoard(board, { ...base, frameStrictness: "strict" });
  const tolerant = await extractPoseBoard(board, { ...base });
  summary.push({ file, state, attempt: Number(attempt), strict, tolerant });

  const runs = tolerant.diagnostics.map((d) => {
    const r = d.borderContactRuns;
    const maxRun = Math.max(r.left, r.right, r.top, r.bottom);
    const pct = d.opaquePixels > 0 ? (d.edgePixels / d.opaquePixels * 100).toFixed(3) : "0";
    const hole = d.enclosedRegions[0];
    const holePct = hole && d.opaquePixels > 0 ? (hole.pixels / d.opaquePixels * 100).toFixed(2) : "0";
    return `f${d.index}[run${maxRun} edge${pct}% comp${d.componentCount} hole${holePct}%/inset${hole ? hole.insetRatio.toFixed(2) : "-"}]`;
  });
  console.log(`\n=== ${file} (${spec.frameCount} frames) ===`);
  console.log(`  strict  : ok=${strict.ok} errors=${strict.errors.length}`);
  console.log(`  tolerant: ok=${tolerant.ok} errors=${tolerant.errors.length} warnings=${tolerant.warnings.length}`);
  if (!tolerant.ok) console.log(`  REMAINING: ${tolerant.errors.join(" | ")}`);
  console.log(`  ${runs.join(" ")}`);
}

console.log("\n\n================ VERDICT ================");
const rr = summary.filter((item) => item.state === "running-right");
const idle = summary.filter((item) => item.state === "idle");
for (const [label, group] of [["running-right", rr], ["idle", idle]]) {
  const strictPass = group.filter((item) => item.strict.ok).length;
  const tolerantPass = group.filter((item) => item.tolerant.ok).length;
  console.log(`${label}: strict ${strictPass}/${group.length} 通过, tolerant ${tolerantPass}/${group.length} 通过`);
  const first = group.find((item) => item.tolerant.ok);
  if (first) console.log(`  最早可用尝试: 第 ${first.attempt} 次`);
}
const stillFailing = summary.filter((item) => !item.tolerant.ok);
console.log(`\n仍然失败: ${stillFailing.length ? stillFailing.map((item) => item.file).join(", ") : "无"}`);
