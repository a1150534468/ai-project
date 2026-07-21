import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexPetArtifact } from "@prisma/client";
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
import {
  CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL,
  CODEX_PET_LOOK_POC_REQUESTED_MODEL,
  captureCodexPetLookPocLaunch,
  createCodexPetLookPocSingleCallGuard,
} from "./codex-pet-look-poc-guard.js";
import {
  buildLookRowPrompt,
  sanitizeCodexPetDirectionRepairPrompt,
  type CodexPetVisualIdentity,
} from "./codex-pet-prompts.js";
import { loadCodexPetArtifact } from "./codex-pet-storage.js";
import { generateCodexPetVisual } from "./codex-pet-visual.js";

// These controls are intentionally captured before dotenv is loaded. A local
// env file may provide service credentials, but can never opt into a live call.
const launch = captureCodexPetLookPocLaunch(process.env);
if (launch.mode !== "disabled") {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const envFile = existsSync(resolve(root, ".env.local"))
    ? resolve(root, ".env.local")
    : resolve(root, ".env");
  (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(envFile);
}

const prisma = getPrisma();

type ArtifactBinding = Pick<CodexPetArtifact, "id" | "kind" | "name" | "mime" | "checksum">;

type LoadedPoc = {
  readonly identity: CodexPetVisualIdentity;
  readonly canonical: Buffer;
  readonly canonicalMime: string;
  readonly standardContact: Buffer;
  readonly cardinalAnchor: Buffer;
  readonly cardinalMime: string;
  readonly neutral: Buffer;
  readonly previousLookA: Buffer;
  readonly previousLookAMime: string;
  readonly previousLookAQa: Buffer;
  readonly mechanics: string;
  readonly repairPrompt: string;
  readonly source: {
    readonly projectId: string;
    readonly projectName: string;
    readonly runId: string;
    readonly runStatus: string;
    readonly billingRefundStatus: string;
    readonly requestedModel: string;
    readonly visualQaModel: string;
    readonly imageGenerationCallCount: number;
    readonly lookAJob: {
      readonly id: string;
      readonly status: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly error: string | null;
    };
    readonly artifacts: {
      readonly canonical: ArtifactBinding;
      readonly standardContact: ArtifactBinding;
      readonly cardinalAnchor: ArtifactBinding;
      readonly neutral: ArtifactBinding;
      readonly previousLookA: ArtifactBinding;
      readonly previousLookAQa: ArtifactBinding;
    };
  };
};

let loaded: LoadedPoc;

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function artifactBinding(artifact: CodexPetArtifact): ArtifactBinding {
  return {
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    mime: artifact.mime,
    checksum: artifact.checksum,
  };
}

async function loadVerifiedArtifact(artifact: CodexPetArtifact): Promise<Buffer> {
  if (!artifact.checksum) throw new Error(`POC source artifact ${artifact.id} has no checksum`);
  const buffer = await loadCodexPetArtifact(artifact);
  const checksum = createHash("sha256").update(buffer).digest("hex");
  if (checksum !== artifact.checksum) throw new Error(`POC source artifact ${artifact.id} checksum mismatch`);
  return buffer;
}

function latestRepairDiagnostic(buffer: Buffer): string {
  const report = recordOf(JSON.parse(buffer.toString("utf8")));
  const visual = recordOf(report.visual);
  const verdicts = Array.isArray(visual.verdicts) ? visual.verdicts.map(recordOf) : [];
  const repairPrompt = [...verdicts].reverse()
    .map((verdict) => typeof verdict.repairPrompt === "string" ? verdict.repairPrompt.trim() : "")
    .find(Boolean);
  const failures = Array.isArray(visual.failures)
    ? visual.failures.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  const diagnostic = [repairPrompt, ...failures, launch.extraRepairHint].filter(Boolean).join("\n");
  return sanitizeCodexPetDirectionRepairPrompt(diagnostic);
}

async function loadPocSource(): Promise<LoadedPoc> {
  const run = await prisma.codexPetRun.findUnique({
    where: { id: launch.sourceRunId },
    include: { project: true },
  });
  if (!run?.selectedBaseArtifactId) throw new Error("POC source run has no approved canonical artifact");
  if (run.status !== "failed" || run.billingRefundStatus !== "refunded") {
    throw new Error("standalone look POC only accepts a failed and refunded source run");
  }
  if (run.requestedModel !== CODEX_PET_LOOK_POC_REQUESTED_MODEL) {
    throw new Error(`POC source run requested unexpected image model ${run.requestedModel}`);
  }
  const jobs = await prisma.codexPetJob.findMany({
    where: {
      runId: run.id,
      projectId: run.projectId,
      userId: run.userId,
      key: { in: ["identity-guide", "look-mechanics", "standard-atlas", "cardinal-anchor-strip", "row-idle", "look-a"] },
    },
  });
  const job = (key: string) => {
    const result = jobs.find((candidate) => candidate.key === key);
    if (!result) throw new Error(`POC source job ${key} is unavailable`);
    return result;
  };
  const completedJob = (key: string) => {
    const result = job(key);
    if (result.status !== "completed") throw new Error(`POC source job ${key} is not completed`);
    return result;
  };
  const identityJob = completedJob("identity-guide");
  const mechanicsJob = completedJob("look-mechanics");
  const standardJob = completedJob("standard-atlas");
  const cardinalJob = completedJob("cardinal-anchor-strip");
  const idleJob = completedJob("row-idle");
  const lookAJob = job("look-a");
  if (lookAJob.status !== "failed") throw new Error("POC source look-a job must be failed");

  const standardContactId = String(recordOf(standardJob.output).contactArtifactId ?? "");
  const cardinalAnchorId = String(recordOf(cardinalJob.output).artifactId ?? "");
  const neutralId = idleJob.outputArtifactIds[0] ?? "";
  const artifactIds = [run.selectedBaseArtifactId, standardContactId, cardinalAnchorId, neutralId];
  if (artifactIds.some((id) => !id)) throw new Error("POC source run is missing a required artifact binding");
  const [artifacts, failedLookArtifacts] = await Promise.all([
    prisma.codexPetArtifact.findMany({
      where: { id: { in: artifactIds }, runId: run.id, projectId: run.projectId, userId: run.userId },
    }),
    prisma.codexPetArtifact.findMany({
      where: {
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        jobId: lookAJob.id,
        status: "ready",
        kind: { in: ["pose_board", "qa_report"] },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const artifact = (id: string) => {
    const result = artifacts.find((candidate) => candidate.id === id);
    if (!result) throw new Error("POC source artifact is missing or outside the run ownership scope");
    return result;
  };
  const latestArtifact = (kind: "pose_board" | "qa_report") => {
    const result = failedLookArtifacts.find((candidate) => candidate.kind === kind);
    if (!result) throw new Error(`POC source look-a has no reusable ${kind} artifact`);
    return result;
  };
  const canonicalArtifact = artifact(run.selectedBaseArtifactId);
  const standardArtifact = artifact(standardContactId);
  const cardinalArtifact = artifact(cardinalAnchorId);
  const neutralArtifact = artifact(neutralId);
  const previousLookAArtifact = latestArtifact("pose_board");
  const previousLookAQaArtifact = latestArtifact("qa_report");
  const [canonical, standardContact, cardinalAnchor, neutral, previousLookA, previousLookAQa] = await Promise.all([
    loadVerifiedArtifact(canonicalArtifact),
    loadVerifiedArtifact(standardArtifact),
    loadVerifiedArtifact(cardinalArtifact),
    loadVerifiedArtifact(neutralArtifact),
    loadVerifiedArtifact(previousLookAArtifact),
    loadVerifiedArtifact(previousLookAQaArtifact),
  ]);
  const snapshot = recordOf(run.inputSnapshot);
  const text = (key: string, fallback: string) => typeof snapshot[key] === "string" ? String(snapshot[key]) : fallback;
  const guide = String(recordOf(identityJob.output).guide ?? "").trim();
  const mechanics = String(recordOf(mechanicsJob.output).mechanics ?? "").trim();
  if (!guide || !mechanics) throw new Error("POC source identity guide or look mechanics is missing");
  return {
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
    previousLookA,
    previousLookAMime: previousLookAArtifact.mime,
    previousLookAQa,
    mechanics,
    repairPrompt: latestRepairDiagnostic(previousLookAQa),
    source: {
      projectId: run.projectId,
      projectName: run.project.name,
      runId: run.id,
      runStatus: run.status,
      billingRefundStatus: run.billingRefundStatus,
      requestedModel: run.requestedModel,
      visualQaModel: run.visualQaModel,
      imageGenerationCallCount: run.imageGenerationCallCount,
      lookAJob: {
        id: lookAJob.id,
        status: lookAJob.status,
        attempt: lookAJob.attempt,
        maxAttempts: lookAJob.maxAttempts,
        error: lookAJob.error,
      },
      artifacts: {
        canonical: artifactBinding(canonicalArtifact),
        standardContact: artifactBinding(standardArtifact),
        cardinalAnchor: artifactBinding(cardinalArtifact),
        neutral: artifactBinding(neutralArtifact),
        previousLookA: artifactBinding(previousLookAArtifact),
        previousLookAQa: artifactBinding(previousLookAQaArtifact),
      },
    },
  };
}

function promptForPoc(): string {
  return `${buildLookRowPrompt(loaded.identity, "look-a", loaded.mechanics)}\n\n`+
    `The previous failed look-a board is attached only as diagnostic evidence. Do not copy its wrong or missing poses. `+
    `Apply this sanitized cumulative repair requirement:\n${loaded.repairPrompt}`;
}

async function preparePocFiles(mode: "prepare" | "live", observedImageCalls = 0): Promise<{
  readonly layout: Buffer;
  readonly anchorStoryboard: Buffer;
  readonly prompt: string;
}> {
  await mkdir(launch.outputDir, { recursive: true });
  const layout = await createLayoutGuide({
    columns: 4,
    rows: 2,
    frameCount: 8,
    title: "Eight clockwise look directions · follow the row-major frame numbers",
    slotLabels: ["1", "2", "3", "4", "5", "6", "7", "8"],
  });
  const anchorStoryboard = await createLookAnchorStoryboard(loaded.cardinalAnchor, "look-a", loaded.identity.chromaKey);
  const prompt = promptForPoc();
  const paths = {
    canonical: "approved-canonical-base.png",
    standardContact: "approved-standard-contact.png",
    cardinalAnchor: "approved-cardinal-anchor-strip.png",
    neutral: "approved-neutral-idle-frame.png",
    previousLookA: "previous-failed-look-a.png",
    previousLookAQa: "previous-failed-look-a-qa.json",
    layout: "look-a-layout.png",
    anchorStoryboard: "look-a-anchor-storyboard.png",
    prompt: "look-a-prompt.txt",
  };
  await Promise.all([
    writeFile(resolve(launch.outputDir, paths.canonical), loaded.canonical),
    writeFile(resolve(launch.outputDir, paths.standardContact), loaded.standardContact),
    writeFile(resolve(launch.outputDir, paths.cardinalAnchor), loaded.cardinalAnchor),
    writeFile(resolve(launch.outputDir, paths.neutral), loaded.neutral),
    writeFile(resolve(launch.outputDir, paths.previousLookA), loaded.previousLookA),
    writeFile(resolve(launch.outputDir, paths.previousLookAQa), loaded.previousLookAQa),
    writeFile(resolve(launch.outputDir, paths.layout), layout),
    writeFile(resolve(launch.outputDir, paths.anchorStoryboard), anchorStoryboard),
    writeFile(resolve(launch.outputDir, paths.prompt), `${prompt}\n`),
  ]);
  const currentRun = await prisma.codexPetRun.findUniqueOrThrow({
    where: { id: loaded.source.runId },
    select: { imageGenerationCallCount: true },
  });
  const manifest = {
    schemaVersion: "codex-pet-look-poc-preflight-v1",
    mode,
    sourceRun: {
      id: loaded.source.runId,
      projectId: loaded.source.projectId,
      projectName: loaded.source.projectName,
      status: loaded.source.runStatus,
      billingRefundStatus: loaded.source.billingRefundStatus,
      requestedModel: loaded.source.requestedModel,
      visualQaModel: loaded.source.visualQaModel,
      chromaKey: loaded.identity.chromaKey,
      imageGenerationCallCountBefore: loaded.source.imageGenerationCallCount,
      imageGenerationCallCountAfterPreparation: currentRun.imageGenerationCallCount,
    },
    sourceLookAJob: loaded.source.lookAJob,
    imageGeneration: {
      requestedModel: CODEX_PET_LOOK_POC_REQUESTED_MODEL,
      expectedActualModel: CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL,
      approvedImageCalls: 1,
      observedImageCalls,
      maxAttempts: 1,
      automaticRetry: false,
      stopOnFailure: true,
    },
    visualQaCalls: 0,
    repairPrompt: loaded.repairPrompt,
    artifacts: loaded.source.artifacts,
    files: paths,
  };
  await writeFile(resolve(launch.outputDir, "preflight.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { layout, anchorStoryboard, prompt };
}

async function consumePersistentApproval(): Promise<void> {
  const marker = resolve(launch.outputDir, ".single-image-call-consumed.json");
  try {
    await writeFile(marker, `${JSON.stringify({
      sourceRunId: loaded.source.runId,
      approvedImageCalls: 1,
      consumedAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (recordOf(error).code === "EEXIST") {
      throw new Error("this POC output directory has already consumed its one approved image call");
    }
    throw error;
  }
}

describe.skipIf(launch.mode === "disabled")("Codex pet guarded real look-a POC", () => {
  beforeAll(async () => {
    loaded = await loadPocSource();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.skipIf(launch.mode !== "prepare")("prepares R7 evidence without contacting any model", async () => {
    await preparePocFiles("prepare");
    const run = await prisma.codexPetRun.findUniqueOrThrow({
      where: { id: loaded.source.runId },
      select: { imageGenerationCallCount: true },
    });
    expect(run.imageGenerationCallCount).toBe(loaded.source.imageGenerationCallCount);
  }, 120_000);

  it.skipIf(launch.mode !== "live")("uses exactly one GPT Image call and stops after deterministic validation", async () => {
    const prepared = await preparePocFiles("live");
    const guard = createCodexPetLookPocSingleCallGuard({
      runId: loaded.source.runId,
      approvalToken: launch.approvalToken,
    });
    const generated = await generateCodexPetVisual({
      prompt: prepared.prompt,
      model: CODEX_PET_LOOK_POC_REQUESTED_MODEL,
      references: [
        { b64: prepared.anchorStoryboard.toString("base64"), mime: "image/png", filename: "look-a-approved-anchor-storyboard.png" },
        { b64: loaded.canonical.toString("base64"), mime: loaded.canonicalMime, filename: "approved-canonical-base.png" },
        { b64: loaded.cardinalAnchor.toString("base64"), mime: loaded.cardinalMime, filename: "approved-cardinal-anchor-strip.png" },
        { b64: loaded.standardContact.toString("base64"), mime: "image/png", filename: "approved-standard-contact.png" },
        { b64: loaded.previousLookA.toString("base64"), mime: loaded.previousLookAMime, filename: "previous-failed-look-a-diagnostic.png" },
        { b64: prepared.layout.toString("base64"), mime: "image/png", filename: "look-layout.png" },
      ],
      size: "1536x1024",
      quality: "low",
      maxAttempts: guard.maxAttempts,
      onAttempt: async (attempt) => {
        guard.onAttempt(attempt);
        await consumePersistentApproval();
      },
      env: process.env,
    });
    await writeFile(resolve(launch.outputDir, "look-a-raw.png"), generated.buffer);

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
    await writeFile(resolve(launch.outputDir, "look-a-normalized.png"), normalized);

    const registered = await registerFirstDirectionRowToNeutral(generated.buffer, loaded.neutral, {
      chromaKey: loaded.identity.chromaKey,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    });
    const registeredBoard = await composeNormalizedPoseBoard(registered.frames, {
      columns: 4,
      rows: 2,
      chromaKey: loaded.identity.chromaKey,
    });
    await writeFile(resolve(launch.outputDir, "look-a-registered.png"), registeredBoard);
    const registeredFramesDir = resolve(launch.outputDir, "look-a-registered-frames");
    await mkdir(registeredFramesDir, { recursive: true });
    await Promise.all(registered.frames.map((frame, index) => (
      writeFile(resolve(registeredFramesDir, `${String(index).padStart(2, "0")}.png`), frame)
    )));
    await writeFile(resolve(launch.outputDir, "look-a-registration.json"), `${JSON.stringify({
      manifest: registered.manifest,
      sourceBoardSize: registered.sourceBoardSize,
      validation: registered.validation,
      diagnostics: registered.diagnostics,
      ok: registered.ok,
      errors: registered.errors,
      warnings: registered.warnings,
    }, null, 2)}\n`);
    const continuity = await measureDirectionRowContinuity(registered.frames, LOOK_DIRECTIONS.slice(0, 8));
    const preview = registered.ok
      ? await createAnimatedWebpPreview(registered.frames, petRowSpec("look-a").durations)
      : null;
    if (preview) await writeFile(resolve(launch.outputDir, "look-a-preview.webp"), preview.image);
    await preparePocFiles("live", guard.attemptCount());
    await writeFile(resolve(launch.outputDir, "look-a-result.json"), `${JSON.stringify({
      provider: {
        requestedModel: generated.provider.requestedModel,
        actualModel: generated.provider.actualModel,
        requestedSize: generated.provider.requestedSize,
        actualSize: generated.provider.actualSize,
        requestedQuality: generated.provider.requestedQuality,
        actualQuality: generated.provider.actualQuality,
        usage: generated.provider.usage,
      },
      modelCalls: { imageGeneration: guard.attemptCount(), visualQa: 0 },
      outputs: {
        rawBoard: "look-a-raw.png",
        normalizedBoard: "look-a-normalized.png",
        registeredBoard: "look-a-registered.png",
        registeredFramesDir: "look-a-registered-frames",
        registrationManifest: "look-a-registration.json",
        preview: preview ? "look-a-preview.webp" : null,
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
    }, null, 2)}\n`);

    expect(guard.attemptCount()).toBe(1);
    expect(generated.provider.requestedModel).toBe(CODEX_PET_LOOK_POC_REQUESTED_MODEL);
    expect(generated.provider.actualModel).toBe(CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL);
    expect(extracted.ok, extracted.errors.join("; ")).toBe(true);
    expect(registered.ok, registered.errors.join("; ")).toBe(true);
    expect(continuity.ok, continuity.errors.join("; ")).toBe(true);
  }, 600_000);
});
