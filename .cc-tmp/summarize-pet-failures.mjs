import { readFileSync } from "node:fs";

const raw = readFileSync(".cc-tmp/pet-failures.json", "utf8");
const chunks = raw.split(/^##### /m).slice(1);
for (const chunk of chunks) {
  const newline = chunk.indexOf("\n");
  const name = chunk.slice(0, newline).trim();
  let report;
  try { report = JSON.parse(chunk.slice(newline)); } catch { console.log(name, "-> unparseable"); continue; }
  const d = report.deterministic ?? {};
  const perFrame = (d.diagnostics ?? []).map((f) => {
    const nb = f.normalizedBounds;
    return {
      i: f.index,
      err: f.errors?.join(",") || "-",
      edge: f.edgePixels,
      comp: f.componentCount,
      holes: f.internalTransparentPixels,
      chroma: f.chromaCoverage != null ? Number(f.chromaCoverage.toFixed(3)) : null,
      nbw: nb?.width ?? null,
      nbh: nb?.height ?? null,
    };
  });
  console.log("=".repeat(90));
  console.log(name);
  console.log("  ok:", d.ok, "| errors:", JSON.stringify(d.errors));
  console.log("  warnings:", JSON.stringify(d.warnings));
  console.log("  geometry:", JSON.stringify(d.geometry));
  console.log("  unusedSlotOpaquePixels:", JSON.stringify(d.unusedSlotOpaquePixels));
  console.log("  visual.pass:", report.visual?.pass, "| visual.failures:", JSON.stringify(report.visual?.failures ?? []));
  console.log("  frames:");
  for (const f of perFrame) {
    console.log(`    f${f.i} err=${f.err} edgePx=${f.edge} comp=${f.comp} holes=${f.holes} chroma=${f.chroma} nb=${f.nbw}x${f.nbh}`);
  }
}
