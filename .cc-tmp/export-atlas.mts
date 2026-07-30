// Read-only: verify the stored atlas and write it to disk for inspection.
import { writeFileSync } from "node:fs";
import { getPrisma } from "../packages/db/src/index.js";
import { getObject, loadS3Config, makeS3 } from "../apps/api/src/storage/s3.js";

const RUN_ID = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";
const prisma = getPrisma();
const s3 = makeS3(loadS3Config());

const job = await prisma.codexPetJob.findFirst({ where: { runId: RUN_ID, key: "standard-atlas" } });
console.log("job", job?.status, "attempt", job?.attempt, "ids", job?.outputArtifactIds.length);

const rows = await prisma.codexPetArtifact.findMany({
  where: { runId: RUN_ID, kind: { in: ["standard_atlas", "qa_contact_sheet"] }, status: "ready" },
  select: { id: true, kind: true, name: true, objectKey: true, width: true, height: true, expiresAt: true },
});
for (const row of rows) {
  console.log(`${row.kind} ${row.width}x${row.height} expires=${row.expiresAt ? row.expiresAt.toISOString() : "never"}`);
  const buffer = await getObject(s3, row.objectKey);
  const ext = row.kind === "standard_atlas" ? "webp" : "png";
  const path = `.cc-tmp/laoshumao-${row.kind}.${ext}`;
  writeFileSync(path, buffer);
  console.log(`  -> ${path}`);
}

await prisma.$disconnect();
process.exit(0);
