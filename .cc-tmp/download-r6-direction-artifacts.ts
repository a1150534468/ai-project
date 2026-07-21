import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPrisma } from "@ai-assistant/db";
import { getObject, loadS3Config, makeS3 } from "../apps/api/src/storage/s3.js";

const runId = "cpr_33f540888a4c38ed4c3a0c267fcd2d88";
const outputDir = resolve(".cc-tmp/r6-direction");
async function main() {
  const prisma = getPrisma();
  const s3 = makeS3(loadS3Config());
  await mkdir(outputDir, { recursive: true });

  const artifacts = await prisma.codexPetArtifact.findMany({
  where: {
    runId,
    OR: [
      { kind: "cardinal_anchor_strip" },
      { job: { key: { in: ["look-cardinals", "look-a"] } } },
    ],
  },
  include: { job: { select: { key: true } } },
  orderBy: { createdAt: "asc" },
  });

  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact.mime.startsWith("image/") && artifact.mime !== "application/json") continue;
    const extension = artifact.mime === "application/json"
      ? "json"
      : artifact.mime === "image/png" ? "png" : "bin";
    const safeName = artifact.name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
    const filename = `${String(index + 1).padStart(2, "0")}-${artifact.job?.key ?? "artifact"}-${artifact.kind}-${safeName}.${extension}`;
    await writeFile(resolve(outputDir, filename), await getObject(s3, artifact.objectKey));
  }

  await prisma.$disconnect();
  console.log(outputDir);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
