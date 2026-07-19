import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPrisma } from "@ai-assistant/db";
import {
  LOOK_DIRECTIONS,
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  composeNormalizedPoseBoard,
  createAnimatedWebpPreview,
  createLayoutGuide,
  createLookAnchorStoryboard,
  extractPoseBoard,
  measureDirectionRowContinuity,
  petRowSpec,
  registerFirstDirectionRowToNeutral,
} from "@ai-assistant/codex-pet-pipeline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLookRowPrompt, buildVisualQaPrompt, type CodexPetVisualIdentity } from "./codex-pet-prompts.js";
import { loadCodexPetArtifact } from "./codex-pet-storage.js";
import { codexPetVisualQaConsensusPasses, generateCodexPetVisual, runCodexPetVisualQaConsensus } from "./codex-pet-visual.js";

const enabled = process.env.RUN_CODEX_PET_LOOK_POC === "1";
if (enabled) {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const envFile = existsSync(resolve(root, ".env.local"))
    ? resolve(root, ".env.local")
    : resolve(root, ".env");
  (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(envFile);
}

const prisma = getPrisma();
const sourceRunId = process.env.CODEX_PET_LOOK_POC_RUN_ID?.trim() || "";
const outputDir = process.env.CODEX_PET_LOOK_POC_OUTPUT_DIR?.trim() || "/tmp/codex-pet-look-poc";
const extraRepairHint = process.env.CODEX_PET_LOOK_POC_REPAIR_HINT?.trim() || "";

type LoadedPoc = {
  readonly identity: CodexPetVisualIdentity;
  readonly canonical: Buffer;
  readonly canonicalMime: string;
  readonly standardContact: Buffer;
  readonly cardinalAnchor: Buffer;
  readonly cardinalMime: string;
  readonly neutral: Buffer;
  readonly mechanics: string;
};

let loaded: LoadedPoc;

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

describe.skipIf(!enabled)("Codex pet real look-a POC", () => {
  beforeAll(async () => {
    if (!sourceRunId) throw new Error("CODEX_PET_LOOK_POC_RUN_ID is required");
    const run = await prisma.codexPetRun.findUnique({ where: { id: sourceRunId }, include: { project: true } });
    if (!run?.selectedBaseArtifactId) throw new Error("POC source run has no approved canonical artifact");
    const jobs = await prisma.codexPetJob.findMany({
      where: {
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        key: { in: ["identity-guide", "look-mechanics", "standard-atlas", "cardinal-anchor-strip", "row-idle"] },
      },
    });
    const job = (key: string) => {
      const result = jobs.find((candidate) => candidate.key === key);
      if (!result || result.status !== "completed") throw new Error(`POC source job ${key} is unavailable`);
      return result;
    };
    const identityJob = job("identity-guide");
    const mechanicsJob = job("look-mechanics");
    const standardJob = job("standard-atlas");
    const cardinalJob = job("cardinal-anchor-strip");
    const idleJob = job("row-idle");
    const standardContactId = String(recordOf(standardJob.output).contactArtifactId ?? "");
    const cardinalAnchorId = String(recordOf(cardinalJob.output).artifactId ?? "");
    const neutralId = idleJob.outputArtifactIds[0] ?? "";
    const artifactIds = [run.selectedBaseArtifactId, standardContactId, cardinalAnchorId, neutralId];
    if (artifactIds.some((id) => !id)) throw new Error("POC source run is missing a required artifact binding");
    const artifacts = await prisma.codexPetArtifact.findMany({
      where: { id: { in: artifactIds }, runId: run.id, projectId: run.projectId, userId: run.userId },
    });
    const artifact = (id: string) => {
      const result = artifacts.find((candidate) => candidate.id === id);
      if (!result) throw new Error("POC source artifact is missing or outside the run ownership scope");
      return result;
    };
    const canonicalArtifact = artifact(run.selectedBaseArtifactId);
    const standardArtifact = artifact(standardContactId);
    const cardinalArtifact = artifact(cardinalAnchorId);
    const neutralArtifact = artifact(neutralId);
    const [canonical, standardContact, cardinalAnchor, neutral] = await Promise.all([
      loadCodexPetArtifact(canonicalArtifact),
      loadCodexPetArtifact(standardArtifact),
      loadCodexPetArtifact(cardinalArtifact),
      loadCodexPetArtifact(neutralArtifact),
    ]);
    const snapshot = recordOf(run.inputSnapshot);
    const text = (key: string, fallback: string) => typeof snapshot[key] === "string" ? String(snapshot[key]) : fallback;
    const guide = String(recordOf(identityJob.output).guide ?? "").trim();
    const mechanics = String(recordOf(mechanicsJob.output).mechanics ?? "").trim();
    if (!guide || !mechanics) throw new Error("POC source identity guide or look mechanics is missing");
    loaded = {
      identity: {
        name: text("name", run.project.name),
        description: text("description", run.project.description),
        prompt: text("prompt", run.project.prompt),
        stylePreset: text("stylePreset", run.project.stylePreset),
        styleNotes: text("styleNotes", run.project.styleNotes),
        chromaKey: run.colorKey || "#ff00ff",
        canonicalGuide: guide,
      },
      canonical,
      canonicalMime: canonicalArtifact.mime,
      standardContact,
      cardinalAnchor,
      cardinalMime: cardinalArtifact.mime,
      neutral,
      mechanics,
    };
    await mkdir(outputDir, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("generates a monotonic 000-to-157.5 row with GPT Image 2 and validates it with GPT-5.6", async () => {
    const layout = await createLayoutGuide({
      columns: 4,
      rows: 2,
      frameCount: 8,
      title: "Eight clockwise look directions · follow the serpentine frame numbers",
      slotLabels: ["1", "2", "3", "4", "8", "7", "6", "5"],
    });
    const basePrompt = buildLookRowPrompt(loaded.identity, "look-a", loaded.mechanics);
    const anchorStoryboard = await createLookAnchorStoryboard(loaded.cardinalAnchor, "look-a", loaded.identity.chromaKey);
    await writeFile(resolve(outputDir, "look-a-anchor-storyboard.png"), anchorStoryboard);
    const generated = await generateCodexPetVisual({
      prompt: `${basePrompt}${extraRepairHint
        ? `\n\nAll additional repair requirements are mandatory and cumulative:\n1. ${extraRepairHint}`
        : ""}`,
      references: [
        { b64: anchorStoryboard.toString("base64"), mime: "image/png", filename: "look-a-approved-anchor-storyboard.png" },
        { b64: loaded.canonical.toString("base64"), mime: loaded.canonicalMime, filename: "approved-canonical-base.png" },
        { b64: loaded.cardinalAnchor.toString("base64"), mime: loaded.cardinalMime, filename: "approved-cardinal-anchor-strip.png" },
        { b64: loaded.standardContact.toString("base64"), mime: "image/png", filename: "approved-standard-contact.png" },
        { b64: layout.toString("base64"), mime: "image/png", filename: "look-layout.png" },
      ],
      size: "1536x1024",
      quality: "low",
      env: process.env,
    });
    await writeFile(resolve(outputDir, "look-a-raw.png"), generated.buffer);

    const extracted = await extractPoseBoard(generated.buffer, {
      columns: 4,
      rows: 2,
      frameCount: 8,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
      chromaKey: loaded.identity.chromaKey,
      requireUnusedSlotsEmpty: true,
    });
    const normalized = await composeNormalizedPoseBoard(extracted.frames, {
      columns: 4,
      rows: 2,
      chromaKey: loaded.identity.chromaKey,
    });
    await writeFile(resolve(outputDir, "look-a-normalized.png"), normalized);

    const registered = await registerFirstDirectionRowToNeutral(generated.buffer, loaded.neutral, {
      chromaKey: loaded.identity.chromaKey,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    });
    const registeredBoard = await composeNormalizedPoseBoard(registered.frames, {
      columns: 4,
      rows: 2,
      chromaKey: loaded.identity.chromaKey,
    });
    await writeFile(resolve(outputDir, "look-a-registered.png"), registeredBoard);
    const continuity = await measureDirectionRowContinuity(registered.frames, LOOK_DIRECTIONS.slice(0, 8));
    const productionQa = extracted.ok
      ? await runCodexPetVisualQaConsensus({
          images: [
            { buffer: loaded.canonical, mime: loaded.canonicalMime },
            { buffer: normalized, mime: "image/png" },
          ],
          prompt: buildVisualQaPrompt(
            "directions",
            "Real look-a POC production-cell gate for chronological 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5 after deterministic serpentine reordering.",
            loaded.identity.canonicalGuide,
          ),
          repetitions: 1,
          env: process.env,
        })
      : null;
    const preview = registered.ok
      ? await createAnimatedWebpPreview(registered.frames, petRowSpec("look-a").durations)
      : null;
    if (preview) await writeFile(resolve(outputDir, "look-a-preview.webp"), preview.image);
    const qa = registered.ok && continuity.ok && preview
      ? await runCodexPetVisualQaConsensus({
          images: [
            { buffer: loaded.canonical, mime: loaded.canonicalMime },
            { buffer: loaded.standardContact, mime: "image/png" },
            { buffer: loaded.cardinalAnchor, mime: loaded.cardinalMime },
            { buffer: preview.image, mime: preview.mime },
          ],
          prompt: buildVisualQaPrompt(
            "directions",
            "Real look-a POC gate for registered 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5. Confirm cell 1 matches approved 000 up, cell 5 matches approved 090 screen-right, cell 8 is one step before approved 180 down, and cell 4 to cell 5 remains one continuous clockwise step with no facial quadrant, eye, mouth, marking, prop or tail side reversal.",
            loaded.identity.canonicalGuide,
          ),
          repetitions: 1,
          env: process.env,
        })
      : null;

    await writeFile(resolve(outputDir, "look-a-result.json"), `${JSON.stringify({
      provider: {
        requestedModel: generated.provider.requestedModel,
        actualModel: generated.provider.actualModel,
        requestedSize: generated.provider.requestedSize,
        actualSize: generated.provider.actualSize,
        requestedQuality: generated.provider.requestedQuality,
        actualQuality: generated.provider.actualQuality,
        usage: generated.provider.usage,
      },
      deterministic: {
        extractionOk: extracted.ok,
        extractionErrors: extracted.errors,
        extractionWarnings: extracted.warnings,
        registrationOk: registered.ok,
        registrationErrors: registered.errors,
        registrationWarnings: registered.warnings,
        continuity,
      },
      visualQa: qa,
      productionVisualQa: productionQa,
    }, null, 2)}\n`);

    expect(extracted.ok, extracted.errors.join("; ")).toBe(true);
    expect(registered.ok, registered.errors.join("; ")).toBe(true);
    expect(continuity.ok, continuity.errors.join("; ")).toBe(true);
    const fullyPassed = (value: typeof qa) => Boolean(value && codexPetVisualQaConsensusPasses(value));
    expect(fullyPassed(productionQa), productionQa?.failures.join("; ") || "GPT-5.6 production-cell QA did not pass").toBe(true);
    expect(fullyPassed(qa), qa?.failures.join("; ") || "GPT-5.6 animated look-a QA did not pass").toBe(true);
  }, 600_000);
});
