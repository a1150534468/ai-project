import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPrisma } from "@ai-assistant/db";
import { createLayoutGuide, extractPoseBoard } from "@ai-assistant/codex-pet-pipeline";
import { buildCardinalPrompt, type CodexPetVisualIdentity } from "../apps/api/src/workflow/codex-pet-prompts.js";
import { loadCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";
import { generateCodexPetVisual } from "../apps/api/src/workflow/codex-pet-visual.js";

const loadEnvFile = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
loadEnvFile?.(resolve(import.meta.dirname, "../.env"));

async function main(): Promise<void> {
  const prisma = getPrisma();
  try {
    const runId = "cpr_52ff2ba58f9629d4f5b8a26a493bab56";
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: runId }, include: { project: true } });
    if (!run.selectedBaseArtifactId) throw new Error("run has no selected canonical artifact");
    const [identityJob, mechanicsJob, standardJob, canonicalArtifact] = await Promise.all([
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId, key: "identity-guide" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId, key: "look-mechanics" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId, key: "standard-atlas" } } }),
      prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: run.selectedBaseArtifactId } }),
    ]);
    const guide = String((identityJob.output as { guide?: string } | null)?.guide ?? "").trim();
    const mechanics = String((mechanicsJob.output as { mechanics?: string } | null)?.mechanics ?? "").trim();
    const contactArtifactId = String((standardJob.output as { contactArtifactId?: string } | null)?.contactArtifactId ?? "");
    if (!guide || !mechanics || !contactArtifactId) throw new Error("run lacks cardinal input evidence");
    const contactArtifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: contactArtifactId } });
    const [canonical, standardContact, layout] = await Promise.all([
      loadCodexPetArtifact(canonicalArtifact),
      loadCodexPetArtifact(contactArtifact),
      createLayoutGuide({ columns: 2, rows: 2, frameCount: 4, title: "Four cardinal look anchors" }),
    ]);
    const identity: CodexPetVisualIdentity = {
      name: run.project.name,
      description: run.project.description,
      prompt: run.project.prompt,
      stylePreset: run.project.stylePreset,
      styleNotes: run.project.styleNotes,
      chromaKey: run.colorKey || "#ff00ff",
      canonicalGuide: guide,
    };
    const outputDir = resolve(import.meta.dirname, "r2-cardinal-poc");
    await mkdir(outputDir, { recursive: true });
    const generated = await generateCodexPetVisual({
      prompt: buildCardinalPrompt(identity, mechanics),
      references: [
        { b64: canonical.toString("base64"), mime: canonicalArtifact.mime, filename: "canonical-base.png" },
        { b64: standardContact.toString("base64"), mime: contactArtifact.mime, filename: "standard-contact.png" },
        { b64: layout.toString("base64"), mime: "image/png", filename: "cardinal-layout.png" },
      ],
      size: "1536x1024",
      quality: "low",
      env: process.env,
    });
    await writeFile(resolve(outputDir, "cardinals-raw.png"), generated.buffer);
    const extracted = await extractPoseBoard(generated.buffer, {
      columns: 2,
      rows: 2,
      frameCount: 4,
      chromaKey: identity.chromaKey,
      requireUnusedSlotsEmpty: true,
    });
    const result = {
      provider: generated.provider,
      deterministic: { ok: extracted.ok, errors: extracted.errors, warnings: extracted.warnings, geometry: extracted.geometry },
    };
    await writeFile(resolve(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: extracted.ok,
      errors: extracted.errors,
      requestedModel: generated.provider.requestedModel,
      actualModel: generated.provider.actualModel,
      upstreamRequestId: generated.provider.upstreamRequestId,
      usage: generated.provider.usage,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
