import { readFileSync } from "node:fs";
const chunks = readFileSync(".cc-tmp/pet-failures.json", "utf8").split(/^##### /m).slice(1);
let comp = 0, compWithEdge = 0;
for (const c of chunks) {
  let p; try { p = JSON.parse(c.slice(c.indexOf("\n") + 1)); } catch { continue; }
  for (const d of p.deterministic?.diagnostics ?? []) {
    if (d.componentCount > 1) { comp += 1; if (d.edgePixels > 0) compWithEdge += 1; }
  }
}
console.log("frames with >1 component:", comp, "of which also touch slot edge:", compWithEdge);
