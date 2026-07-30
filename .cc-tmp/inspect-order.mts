// Read-only: when did standard-atlas complete vs when did the run fail?
import { getPrisma } from "../packages/db/src/index.js";

const prisma = getPrisma();
const runId = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";

const jobs = await prisma.codexPetJob.findMany({
  where: { runId, key: { in: ["standard-atlas", "row-review", "row-running-right"] } },
  select: { key: true, status: true, attempt: true, startedAt: true, completedAt: true, updatedAt: true },
});
console.log("--- jobs ---");
for (const j of jobs) console.log(j);

const atlas = await prisma.codexPetArtifact.findMany({
  where: { runId, kind: "standard_atlas" },
  select: { id: true, createdAt: true, updatedAt: true, expiresAt: true },
});
console.log("--- standard_atlas artifact ---");
for (const a of atlas) console.log(a);

const events = await prisma.codexPetRunEvent.findMany({
  where: { runId },
  orderBy: { createdAt: "desc" },
  take: 14,
  select: { createdAt: true, type: true, status: true, message: true },
});
console.log("--- last events (newest first) ---");
for (const e of events) {
  console.log(`${e.createdAt.toISOString()} ${String(e.type).padEnd(30)} ${String(e.status).padEnd(20)} ${String(e.message ?? "").slice(0, 130)}`);
}

await prisma.$disconnect();
