import { readFileSync } from "node:fs";

const raw = readFileSync(".cc-tmp/pet-failures.json", "utf8");
const chunks = raw.split(/^##### /m).slice(1);

const reports = [];
for (const chunk of chunks) {
  const nl = chunk.indexOf("\n");
  const title = chunk.slice(0, nl).trim();
  let parsed;
  try { parsed = JSON.parse(chunk.slice(nl + 1)); } catch { continue; }
  reports.push({ title, det: parsed.deterministic ?? {} });
}

const codesOf = (d) => new Set((d.errors ?? []).map((e) => String(e).split(":")[0]));

console.log("=== hole ratios on frames flagged possible-transparent-holes vs clean frames ===");
const flagged = [];
const clean = [];
for (const r of reports) {
  for (const d of r.det.diagnostics ?? []) {
    const ratio = d.internalTransparentPixels / d.opaquePixels;
    if (codesOf(d).has("possible-transparent-holes")) flagged.push(ratio);
    else if (d.internalTransparentPixels > 0) clean.push(ratio);
  }
}
const pct = (xs) => xs.map((x) => (x * 100).toFixed(2)).sort((a, b) => a - b).join(", ");
console.log("flagged (%):", pct(flagged));
console.log("passed-but-nonzero (%):", pct(clean));

console.log("\n=== what-if: which reports would pass under each relaxation ===");
const scenarios = {
  "A 现状（零容忍）": () => false,
  "B 仅边缘接触降级为警告": (d) => [...codesOf(d)].every((c) => c === "source-touches-slot-edge"),
  "C 边缘+碎片降级": (d) => [...codesOf(d)].every((c) => c === "source-touches-slot-edge" || c === "multiple-foreground-components"),
  "D 边缘+碎片+空洞三项降级": (d) => [...codesOf(d)].every((c) => ["source-touches-slot-edge", "multiple-foreground-components", "possible-transparent-holes"].includes(c)),
};
for (const [name, forgiven] of Object.entries(scenarios)) {
  let pass = 0;
  const failing = [];
  for (const r of reports) {
    const bad = (r.det.diagnostics ?? []).filter((d) => (d.errors ?? []).length > 0 && !forgiven(d));
    if (bad.length === 0) pass += 1;
    else failing.push(`${r.title.slice(0, 24)}…(${bad.length}帧)`);
  }
  console.log(`${name}: ${pass}/${reports.length} 通过`);
}

console.log("\n=== per report: clean frames / total (帧级复用可回收比例) ===");
for (const r of reports) {
  const ds = r.det.diagnostics ?? [];
  const good = ds.filter((d) => (d.errors ?? []).length === 0).length;
  console.log(`${good}/${ds.length}  ${r.title}`);
}
