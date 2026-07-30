// Read-only. Answers: why is the run "failed" when the 9 standard rows exist?
import { getPrisma } from "../packages/db/src/index.js";

const prisma = getPrisma();

const runs = await prisma.codexPetRun.findMany({
  orderBy: { createdAt: "desc" },
  take: 2,
});

for (const run of runs) {
  console.log("=== run", run.id, "===");
  console.log({
    status: run.status,
    progressStage: run.progressStage,
    progressPercent: run.progressPercent,
    billingMode: run.billingMode,
    billingSettlementStatus: run.billingSettlementStatus,
    billingReservedPoints: run.billingReservedPoints,
    billingSettledPoints: run.billingSettledPoints,
    knowledgeDocumentId: run.knowledgeDocumentId,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
  });
  console.log("error:", run.error);

  const jobs = await prisma.codexPetJob.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: "asc" },
    select: { key: true, kind: true, status: true, attempt: true, maxAttempts: true },
  });
  console.log("--- jobs ---");
  for (const job of jobs) {
    console.log(
      [job.status.padEnd(10), job.key.padEnd(30), `attempt=${job.attempt}/${job.maxAttempts}`].join(" "),
    );
  }

  const artifacts = await prisma.codexPetArtifact.groupBy({
    by: ["kind"],
    where: { runId: run.id },
    _count: { _all: true },
  });
  console.log("--- artifacts by kind ---");
  console.log(artifacts.map((a) => `${a.kind}=${a._count._all}`).join(" "));

  const calls = await prisma.codexPetImageCall.groupBy({
    by: ["callKind", "status"],
    where: { runId: run.id },
    _count: { _all: true },
    _sum: { points: true },
  });
  console.log("--- image calls ---");
  for (const c of calls) {
    console.log(`${c.callKind}/${c.status}: n=${c._count._all} points=${c._sum.points ?? 0}`);
  }
  console.log("");
}

await prisma.$disconnect();
