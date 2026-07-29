import { readFileSync } from "node:fs";

const raw = readFileSync(".cc-tmp/pet-failures.json", "utf8");
const chunks = raw.split(/^##### /m).slice(1);
const rows = [];
let totalFrames = 0;
let badFrames = 0;
const errorReportCount = new Map();
for (const chunk of chunks) {
  const nl = chunk.indexOf("\n");
  const body = chunk.slice(nl + 1);
  let parsed;
  try { parsed = JSON.parse(body); } catch { continue; }
  const det = parsed.deterministic ?? {};
  const seen = new Set();
  for (const err of det.errors ?? []) {
    const code = String(err).replace(/^frame-\d+:/, "").split(":")[0];
    seen.add(code);
  }
  for (const code of seen) errorReportCount.set(code, (errorReportCount.get(code) ?? 0) + 1);
  for (const d of det.diagnostics ?? []) {
    totalFrames += 1;
    if ((d.errors ?? []).length > 0) badFrames += 1;
    if (d.edgePixels > 0) {
      rows.push({
        edge: d.edgePixels,
        opaque: d.opaquePixels,
        ratio: d.edgePixels / d.opaquePixels,
      });
    }
  }
}
rows.sort((a, b) => a.ratio - b.ratio);
console.log("reports:", chunks.length, "frames:", totalFrames, "badFrames:", badFrames, "cleanFrames:", totalFrames - badFrames);
console.log("error code -> reports affected:", [...errorReportCount.entries()].sort((a, b) => b[1] - a[1]));
console.log("edge-touch frames:", rows.length);
console.log("min", rows[0]);
console.log("max", rows[rows.length - 1]);
const ratios = rows.map((r) => r.ratio);
const median = ratios[Math.floor(ratios.length / 2)];
console.log("median ratio", (median * 100).toFixed(3) + "%");
console.log("opaque range", Math.min(...rows.map((r) => r.opaque)), Math.max(...rows.map((r) => r.opaque)));
console.log("edge range", Math.min(...rows.map((r) => r.edge)), Math.max(...rows.map((r) => r.edge)));
console.log("all ratios %", ratios.map((r) => (r * 100).toFixed(3)).join(", "));
