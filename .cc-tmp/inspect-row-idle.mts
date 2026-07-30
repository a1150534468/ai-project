// Read-only: why row-idle resolves to 6 frames.
import { getPrisma } from "../packages/db/src/index.js";

const RUN_ID = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";
const prisma = getPrisma();

const job = await prisma.codexPetJob.findFirst({ where: { runId: RUN_ID, key: "row-idle" } });
if (!job) throw new Error("no job");
console.log("attempt", job.attempt, "status", job.status);
console.log("outputArtifactIds", job.outputArtifactIds.length);
console.log("output", JSON.stringify(job.output));

const listed = await prisma.codexPetArtifact.findMany({
  where: { id: { in: job.outputArtifactIds } },
  select: { id: true, kind: true, status: true, metadata: true },
});
for (const a of listed) {
  const index = (a.metadata as Record<string, unknown> | null)?.index;
  console.log(`listed ${a.kind} ${a.status} index=${String(index)}`);
}

const allFrames = await prisma.codexPetArtifact.findMany({
  where: { runId: RUN_ID, jobId: job.id, kind: "frame" },
  select: { id: true, status: true, metadata: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});
console.log("--- all frames on this job:", allFrames.length);
for (const a of allFrames) {
  const meta = a.metadata as Record<string, unknown> | null;
  console.log(`${a.status} index=${String(meta?.index)} listed=${job.outputArtifactIds.includes(a.id)} ${a.createdAt.toISOString()}`);
}

await prisma.$disconnect();
process.exit(0);
