// Read-only: exact billing columns for the failed run.
import { getPrisma } from "../packages/db/src/index.js";

const prisma = getPrisma();
const runId = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";

const run = await prisma.codexPetRun.findFirstOrThrow({ where: { id: runId } });
const billing = Object.fromEntries(
  Object.entries(run).filter(([k]) => k.startsWith("billing")),
);
console.log(billing);

const calls = await prisma.codexPetImageCall.findMany({
  where: { runId },
  orderBy: { createdAt: "asc" },
});
console.log("--- call fields ---");
console.log(Object.keys(calls[0] ?? {}).join(" "));
console.log("--- calls ---");
for (const c of calls as ReadonlyArray<Record<string, unknown>>) {
  console.log(
    [
      String(c.callKind).padEnd(8),
      String(c.status).padEnd(10),
      `pts=${String(c.points ?? c.pointsCharged ?? "?").padStart(4)}`,
      String(c.purpose ?? "").padEnd(24),
      c.sentAt ? "sent" : "unsent",
    ].join(" "),
  );
}

await prisma.$disconnect();
