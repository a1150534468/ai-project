import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPrisma } from "@ai-assistant/db";
import {
  LOOK_DIRECTIONS,
  createAnimatedWebpPreview,
  measureDirectionRowContinuity,
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
  try {
    const runId = "cpr_dc28e69094bef3b53c41a0e9d79207cc";
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: runId } });
    if (!run.selectedBaseArtifactId) throw new Error("run has no selected canonical artifact");
    const [identityJob, standardJob, canonicalArtifact, cardinalArtifact] = await Promise.all([
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId, key: "identity-guide" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId, key: "standard-atlas" } } }),
      prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: run.selectedBaseArtifactId } }),
      prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: "f5533ff2-4095-4bc8-acc9-4c89272c0421" } }),
    ]);
    const guide = String((identityJob.output as { guide?: string } | null)?.guide ?? "").trim();
    const contactArtifactId = String((standardJob.output as { contactArtifactId?: string } | null)?.contactArtifactId ?? "");
    if (!guide || !contactArtifactId) throw new Error("run lacks identity or standard contact evidence");
    const contactArtifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: contactArtifactId } });
    const [canonical, standardContact, cardinalAnchor, registeredRow] = await Promise.all([
      loadCodexPetArtifact(canonicalArtifact),
      loadCodexPetArtifact(contactArtifact),
      loadCodexPetArtifact(cardinalArtifact),
      readFile(resolve(import.meta.dirname, "run-dc28-row9/registered-fixed-attempt3.png")),
    ]);
    const frames = await splitRegisteredDirectionRow(registeredRow);
    const continuity = await measureDirectionRowContinuity(frames, LOOK_DIRECTIONS.slice(0, 8));
    const preview = await createAnimatedWebpPreview(frames, petRowSpec("look-a").durations);
    const result = await runCodexPetVisualQaConsensus({
      images: [
        { buffer: canonical, mime: canonicalArtifact.mime },
        { buffer: standardContact, mime: contactArtifact.mime },
        { buffer: cardinalAnchor, mime: cardinalArtifact.mime },
        { buffer: registeredRow, mime: "image/png" },
        { buffer: preview.image, mime: preview.mime },
      ],
      prompt: buildVisualQaPrompt(
        "directions",
        `Pre-row-10 gate for the registered row-9 sequence 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5. `
        + `Confirm 000 unmistakably up, 090 unmistakably screen-right, every intermediate stays in its labeled quadrant, and the animated sequence advances clockwise without reversal, registration snap, scale pop or identity drift. `
        + `Image 3 is the authoritative 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. Row-9 cell 1 must match Image 3 top-left's visible front/back appearance, cell 5 must match its top-right, and cell 8 must visibly approach its bottom-left without entering the opposite side. `
        + `Image 4 is the complete static eight-frame registered row in chronological left-to-right order; inspect every cell. Image 5 is its animation preview. `
        + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).join(" | ") || "none"}.`,
        guide,
      ),
      repetitions: 1,
      env: process.env,
    });
    await writeFile(resolve(import.meta.dirname, "run-dc28-row9/row9-fixed-registration-real-qa.json"), `${JSON.stringify({ continuity, visualQa: result }, null, 2)}\n`);
    console.log(JSON.stringify({ pass: result.pass, score: result.score, failures: result.failures, warnings: result.warnings, provider: result.modelProvenance }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
