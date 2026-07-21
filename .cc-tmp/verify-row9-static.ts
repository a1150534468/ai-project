import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPrisma } from "@ai-assistant/db";
import {
  createAnimatedWebpPreview,
  petRowSpec,
  splitRegisteredDirectionRow,
} from "@ai-assistant/codex-pet-pipeline";
import { buildVisualQaPrompt } from "../apps/api/src/workflow/codex-pet-prompts.js";
import { loadCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";
import { runCodexPetVisualQaConsensus } from "../apps/api/src/workflow/codex-pet-visual.js";

const loadEnvFile = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
loadEnvFile?.(resolve(import.meta.dirname, "../.env"));

async function main(): Promise<void> {
  const prisma = getPrisma();
  const runId = "cpr_396e486e06c3d28f2bd368fc429d351a";
  try {
  const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: runId } });
  const identityJob = await prisma.codexPetJob.findUniqueOrThrow({
    where: { runId_key: { runId, key: "identity-guide" } },
  });
  const guide = String((identityJob.output as { guide?: string } | null)?.guide ?? "").trim();
  if (!guide || !run.selectedBaseArtifactId) throw new Error("Run is missing the approved identity evidence");

  const [canonical, standardContact, cardinalAnchor, registeredRow] = await Promise.all([
    prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: run.selectedBaseArtifactId } }),
    prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId, kind: "qa_contact_sheet", job: { key: "standard-atlas" } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId, kind: "cardinal_anchor_strip" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId, kind: "registered_direction_row" },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const [canonicalBytes, standardBytes, cardinalBytes, rowBytes] = await Promise.all([
    loadCodexPetArtifact(canonical),
    loadCodexPetArtifact(standardContact),
    loadCodexPetArtifact(cardinalAnchor),
    loadCodexPetArtifact(registeredRow),
  ]);
  const frames = await splitRegisteredDirectionRow(rowBytes);
  const preview = await createAnimatedWebpPreview(frames, petRowSpec("look-a").durations);
  const result = await runCodexPetVisualQaConsensus({
    images: [
      { buffer: canonicalBytes, mime: canonical.mime },
      { buffer: standardBytes, mime: standardContact.mime },
      { buffer: cardinalBytes, mime: cardinalAnchor.mime },
      { buffer: rowBytes, mime: "image/png" },
      { buffer: preview.image, mime: preview.mime },
    ],
    prompt: buildVisualQaPrompt(
      "directions",
      "Pre-row-10 gate for the registered row-9 sequence 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5. Confirm 000 unmistakably up, 090 unmistakably screen-right, every intermediate stays in its labeled quadrant, and the animated sequence advances clockwise without reversal, registration snap, scale pop or identity drift. The fourth image is the complete static eight-frame registered row in chronological left-to-right order; inspect every cell. The fifth image is its animation preview. Continuity metrics are review evidence only: none.",
      guide,
    ),
    repetitions: 1,
    env: process.env,
  });
  await writeFile(resolve(import.meta.dirname, "row9-static-real-qa.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    pass: result.pass,
    score: result.score,
    failures: result.failures,
    warnings: result.warnings,
    provenance: result.modelProvenance,
  }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
