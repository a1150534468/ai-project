// Read-only: raw per-job extra-call rows for the two v2 runs.
import { getPrisma } from "../packages/db/src/index.js";

const prisma = getPrisma();
const runIds = ["cpr_13c964c03d2965b49b5e33cc1c9a9c1b", "cpr_f8be7f050e0491e340f4e02d9f454367"];

for (const runId of runIds) {
  const calls = await prisma.codexPetImageCall.findMany({
    where: { runId },
    orderBy: [{ jobKey: "asc" }, { logicalAttempt: "asc" }],
    select: { jobKey: true, logicalAttempt: true, callKind: true, status: true, error: true },
  });
  console.log(`=== ${runId} total=${calls.length} ===`);
  let job = "";
  for (const c of calls) {
    if (c.jobKey !== job) { job = c.jobKey; console.log(`  --- ${job}`); }
    console.log(`    attempt=${String(c.logicalAttempt).padStart(2)} ${c.callKind.padEnd(7)} ${c.status.padEnd(10)} ${String(c.error ?? "").slice(0, 90)}`);
  }
}

await prisma.$disconnect();
