import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPrisma } from "@ai-assistant/db";
import { loadCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";

function safeName(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const runId = process.argv[2]?.trim();
  const outputDirectory = process.argv[3]?.trim();
  if (!runId || !outputDirectory) {
    throw new Error("usage: download-codex-pet-run.ts <run-id> <output-directory>");
  }

  const prisma = getPrisma();
  try {
    const artifacts = await prisma.codexPetArtifact.findMany({
      where: { runId },
      select: { id: true, kind: true, name: true, objectKey: true, mime: true },
      orderBy: { createdAt: "asc" },
    });
    await mkdir(outputDirectory, { recursive: true });
    const manifest: Array<Record<string, string>> = [];
    for (const [index, artifact] of artifacts.entries()) {
      const extension = artifact.mime === "application/json" ? ".json" : ".png";
      const filename = `${String(index + 1).padStart(2, "0")}-${safeName(artifact.kind)}-${safeName(artifact.name)}${extension}`;
      await writeFile(path.join(outputDirectory, filename), await loadCodexPetArtifact(artifact.objectKey));
      manifest.push({ id: artifact.id, kind: artifact.kind, name: artifact.name, filename, objectKey: artifact.objectKey });
    }
    await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify({ runId, artifacts: manifest }, null, 2)}\n`);
    console.log(JSON.stringify({ runId, outputDirectory: path.resolve(outputDirectory), count: artifacts.length }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
