import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPrisma } from "../packages/db/src/index.js";
import { getObject, loadS3Config, makeS3 } from "../apps/api/src/storage/s3.js";

const runId = "cpr_3a7a7ee330675f6f5f3b4d58e0ef5b5b";
const selectedBaseArtifactId = "01e1fafc-5e57-4e04-b3a5-881b17e34258";
const outputDir = fileURLToPath(new URL("./r7-replay", import.meta.url));
const standardRowKeys = [
  "row-idle",
  "row-running-right",
  "row-running-left",
  "row-waving",
  "row-jumping",
  "row-failed",
  "row-waiting",
  "row-running",
  "row-review",
] as const;

function extension(mime: string): string {
  if (mime === "application/json") return "json";
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  return "bin";
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "artifact";
}

async function main() {
  const prisma = getPrisma();
  const s3 = makeS3(loadS3Config());
  await mkdir(outputDir, { recursive: true });

  const jobs = await prisma.codexPetJob.findMany({
    where: { runId },
    select: { id: true, key: true, status: true, attempt: true, output: true },
  });
  const acceptedBoardIds = new Set<string>();
  for (const job of jobs) {
    if (!standardRowKeys.includes(job.key as typeof standardRowKeys[number])) continue;
    const output = job.output && typeof job.output === "object" && !Array.isArray(job.output)
      ? job.output as Record<string, unknown>
      : {};
    if (typeof output.boardArtifactId === "string") acceptedBoardIds.add(output.boardArtifactId);
  }

  const artifacts = await prisma.codexPetArtifact.findMany({
    where: {
      runId,
      OR: [
        { id: selectedBaseArtifactId },
        { id: { in: [...acceptedBoardIds] } },
        { kind: { in: ["standard_atlas", "qa_contact_sheet", "cardinal_anchor_strip"] } },
        { job: { key: { in: ["look-cardinals", "look-a"] } } },
      ],
    },
    include: { job: { select: { key: true, attempt: true } } },
    orderBy: { createdAt: "asc" },
  });

  const manifest: Array<Record<string, unknown>> = [];
  for (const artifact of artifacts) {
    if (!artifact.mime.startsWith("image/") && artifact.mime !== "application/json") continue;
    const jobKey = artifact.job?.key ?? "artifact";
    const filename = `${safe(jobKey)}--${safe(artifact.kind)}--${safe(artifact.name)}--${artifact.id}.${extension(artifact.mime)}`;
    const bytes = await getObject(s3, artifact.objectKey);
    await writeFile(resolve(outputDir, filename), bytes);
    manifest.push({
      id: artifact.id,
      jobKey,
      jobAttempt: artifact.job?.attempt ?? null,
      kind: artifact.kind,
      name: artifact.name,
      mime: artifact.mime,
      width: artifact.width,
      height: artifact.height,
      status: artifact.status,
      filename,
      metadata: artifact.metadata,
    });
  }

  await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify({ runId, selectedBaseArtifactId, artifacts: manifest }, null, 2)}\n`);
  await prisma.$disconnect();
  console.log(JSON.stringify({ outputDir, downloaded: manifest.length, acceptedStandardBoards: acceptedBoardIds.size }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
