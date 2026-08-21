import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPrisma } from "@ai-assistant/db";
import {
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  LOOK_DIRECTIONS,
  composeLookBScreenLeftTrajectoryReference,
  composeLookSourceBoardReference,
  composeNormalizedPoseBoard,
  createAnimatedWebpPreview,
  createLayoutGuide,
  createLookAnchorStoryboard,
  extractPoseBoard,
  measureDirectionRowContinuity,
  parseNeutralDirectionRegistrationManifest,
  petRowSpec,
  registerSecondDirectionRowWithManifest,
  validateNeutralLockedDirectionFrames,
  type NeutralDirectionRegistrationManifest,
} from "@ai-assistant/codex-pet-pipeline";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL,
  CODEX_PET_LOOK_POC_REQUESTED_MODEL,
  captureCodexPetLookBPocLaunch,
  createCodexPetLookPocSingleCallGuard,
} from "./codex-pet-look-poc-guard.js";
import {
  buildLookRowPrompt,
  buildVisualQaPrompt,
  sanitizeCodexPetDirectionRepairPrompt,
  type CodexPetVisualIdentity,
} from "./codex-pet-prompts.js";
import {
  codexPetVisualQaConsensusPasses,
  generateCodexPetVisual,
  runCodexPetVisualQaConsensus,
} from "./codex-pet-visual.js";

const launch = captureCodexPetLookBPocLaunch(process.env);
if (launch.mode !== "disabled") {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const envFile = existsSync(resolve(root, ".env.local")) ? resolve(root, ".env.local") : resolve(root, ".env");
  (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(envFile);
}

const prisma = getPrisma();

type LoadedLookB = {
  readonly identity: CodexPetVisualIdentity;
  readonly mechanics: string;
  readonly canonical: Buffer;
  readonly canonicalMime: string;
  readonly standardContact: Buffer;
  readonly cardinalAnchor: Buffer;
  readonly cardinalMime: string;
  readonly cardinalFrames: readonly Buffer[];
  readonly neutral: Buffer;
  readonly row9Frames: readonly Buffer[];
  readonly row9Reference: Buffer;
  readonly row9Manifest: NeutralDirectionRegistrationManifest;
  readonly row9RegisteredChecksum: string;
  readonly sourceCallCount: number;
  readonly chromaKey: string;
};

let loaded: LoadedLookB;

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return recordOf(JSON.parse(await readFile(path, "utf8")));
}

async function splitCardinals(strip: Buffer): Promise<readonly Buffer[]> {
  const metadata = await sharp(strip).metadata();
  if (metadata.width !== 384 || metadata.height !== 416) throw new Error("approved cardinal strip must be 384x416");
  return Promise.all(Array.from({ length: 4 }, (_, index) => sharp(strip).extract({
    left: (index % 2) * 192,
    top: Math.floor(index / 2) * 208,
    width: 192,
    height: 208,
  }).png().toBuffer()));
}

async function loadLookBSource(): Promise<LoadedLookB> {
  const preflight = await readJson(resolve(launch.sourceDir, "preflight.json"));
  const sourceRun = recordOf(preflight.sourceRun);
  if (sourceRun.id !== launch.sourceRunId) throw new Error("look-a preflight belongs to another run");
  const chromaKey = typeof sourceRun.chromaKey === "string" ? sourceRun.chromaKey : "";
  if (!/^#[0-9a-f]{6}$/i.test(chromaKey)) throw new Error("look-a preflight has no valid chroma key");
  const files = recordOf(preflight.files);
  const artifacts = recordOf(preflight.artifacts);
  const evidence = async (fileKey: string, artifactKey: string) => {
    const filename = String(files[fileKey] ?? "");
    const artifact = recordOf(artifacts[artifactKey]);
    const checksum = String(artifact.checksum ?? "");
    if (!filename || !/^[0-9a-f]{64}$/.test(checksum)) throw new Error(`look-a preflight is missing ${fileKey}`);
    const buffer = await readFile(resolve(launch.sourceDir, filename));
    if (hash(buffer) !== checksum) throw new Error(`look-a preflight checksum mismatch for ${fileKey}`);
    return { buffer, mime: String(artifact.mime ?? "image/png") };
  };
  const [canonical, standardContact, cardinalAnchor, neutral] = await Promise.all([
    evidence("canonical", "canonical"),
    evidence("standardContact", "standardContact"),
    evidence("cardinalAnchor", "cardinalAnchor"),
    evidence("neutral", "neutral"),
  ]);

  const lookAResult = await readJson(resolve(launch.sourceDir, "look-a-result.json"));
  const provider = recordOf(lookAResult.provider);
  const modelCalls = recordOf(lookAResult.modelCalls);
  const deterministic = recordOf(lookAResult.deterministic);
  const continuity = recordOf(deterministic.continuity);
  if (provider.requestedModel !== CODEX_PET_LOOK_POC_REQUESTED_MODEL
    || provider.actualModel !== CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL
    || modelCalls.imageGeneration !== 1
    || modelCalls.visualQa !== 1
    || deterministic.extractionOk !== true
    || deterministic.registrationOk !== true
    || continuity.ok !== true) {
    throw new Error("look-a result has not passed the required one-call deterministic gate");
  }
  const registrationReport = await readJson(resolve(launch.sourceDir, "look-a-registration.json"));
  const row9Manifest = parseNeutralDirectionRegistrationManifest(registrationReport.manifest);
  const row9Frames = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    readFile(resolve(launch.sourceDir, "look-a-registered-frames", `${String(index).padStart(2, "0")}.png`))
  )));
  const lockedValidation = await validateNeutralLockedDirectionFrames(neutral.buffer, row9Frames, row9Manifest.thresholds);
  if (!lockedValidation.ok) throw new Error(`look-a registered frames failed locked validation: ${lockedValidation.errors.join("; ")}`);
  const row9Reference = await composeLookSourceBoardReference(row9Frames, chromaKey);
  const registeredBoard = await readFile(resolve(launch.sourceDir, "look-a-registered.png"));
  if (hash(row9Reference) !== hash(registeredBoard)) {
    throw new Error("look-a registered board does not match its persisted registered frames");
  }
  const row9RegisteredChecksum = hash(registeredBoard);
  const semanticApproval = await readJson(resolve(launch.sourceDir, "look-a-semantic-approval.json"));
  const semanticModel = recordOf(semanticApproval.modelProvenance);
  if (semanticApproval.sourceRunId !== launch.sourceRunId
    || semanticApproval.row !== "look-a"
    || semanticApproval.verdict !== "pass"
    || semanticApproval.registeredBoardChecksum !== row9RegisteredChecksum
    || semanticModel.requestedModel !== "gpt-5.6-sol"
    || semanticModel.actualModel !== "gpt-5.6-sol") {
    throw new Error("look-a requires a checksum-bound GPT-5.6 semantic approval before look-b");
  }

  const run = await prisma.codexPetRun.findUnique({ where: { id: launch.sourceRunId }, include: { project: true } });
  if (!run || run.status !== "failed" || run.billingRefundStatus !== "refunded") {
    throw new Error("look-b POC only accepts the original failed/refunded R7 source run");
  }
  if (run.requestedModel !== CODEX_PET_LOOK_POC_REQUESTED_MODEL || run.visualQaModel !== "gpt-5.6-sol") {
    throw new Error("look-b POC source model contract is invalid");
  }
  const jobs = await prisma.codexPetJob.findMany({
    where: { runId: run.id, projectId: run.projectId, userId: run.userId, key: { in: ["identity-guide", "look-mechanics"] } },
  });
  const identityJob = jobs.find((job) => job.key === "identity-guide");
  const mechanicsJob = jobs.find((job) => job.key === "look-mechanics");
  const guide = String(recordOf(identityJob?.output).guide ?? "").trim();
  const mechanics = String(recordOf(mechanicsJob?.output).mechanics ?? "").trim();
  if (identityJob?.status !== "completed" || mechanicsJob?.status !== "completed" || !guide || !mechanics) {
    throw new Error("look-b POC source identity guide or mechanics is unavailable");
  }
  const snapshot = recordOf(run.inputSnapshot);
  const text = (key: string, fallback: string) => typeof snapshot[key] === "string" ? String(snapshot[key]) : fallback;
  return {
    identity: {
      name: text("name", run.project.name),
      description: text("description", run.project.description),
      prompt: text("prompt", run.project.prompt),
      stylePreset: text("stylePreset", run.project.stylePreset),
      styleNotes: text("styleNotes", run.project.styleNotes),
      chromaKey,
      canonicalGuide: guide,
    },
    mechanics,
    canonical: canonical.buffer,
    canonicalMime: canonical.mime,
    standardContact: standardContact.buffer,
    cardinalAnchor: cardinalAnchor.buffer,
    cardinalMime: cardinalAnchor.mime,
    cardinalFrames: await splitCardinals(cardinalAnchor.buffer),
    neutral: neutral.buffer,
    row9Frames,
    row9Reference,
    row9Manifest,
    row9RegisteredChecksum,
    sourceCallCount: run.imageGenerationCallCount,
    chromaKey,
  };
}

function lookBPrompt(): string {
  const base = buildLookRowPrompt(loaded.identity, "look-b", loaded.mechanics);
  return launch.extraRepairHint
    ? `${base}\n\nAdditional cumulative repair requirement:\n${sanitizeCodexPetDirectionRepairPrompt(launch.extraRepairHint)}`
    : base;
}

async function prepareLookB(mode: "prepare" | "live", observedImageCalls = 0, observedVisualQaCalls = 0) {
  await mkdir(launch.outputDir, { recursive: true });
  const [anchorStoryboard, trajectory, layout] = await Promise.all([
    createLookAnchorStoryboard(loaded.cardinalAnchor, "look-b", loaded.chromaKey),
    composeLookBScreenLeftTrajectoryReference(loaded.row9Frames, loaded.cardinalFrames, loaded.chromaKey),
    createLayoutGuide({
      columns: 4,
      rows: 2,
      frameCount: 8,
      title: "Eight clockwise look directions · follow the row-major frame numbers",
      slotLabels: ["1", "2", "3", "4", "5", "6", "7", "8"],
    }),
  ]);
  const prompt = lookBPrompt();
  await Promise.all([
    writeFile(resolve(launch.outputDir, "look-b-anchor-storyboard.png"), anchorStoryboard),
    writeFile(resolve(launch.outputDir, "look-b-screen-left-trajectory-scaffold.png"), trajectory),
    writeFile(resolve(launch.outputDir, "approved-registered-look-row-9-4x2.png"), loaded.row9Reference),
    writeFile(resolve(launch.outputDir, "look-b-layout.png"), layout),
    writeFile(resolve(launch.outputDir, "look-b-prompt.txt"), `${prompt}\n`),
  ]);
  const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: launch.sourceRunId }, select: { imageGenerationCallCount: true } });
  await writeFile(resolve(launch.outputDir, "preflight.json"), `${JSON.stringify({
    schemaVersion: "codex-pet-look-b-poc-preflight-v1",
    mode,
    sourceRunId: launch.sourceRunId,
    sourceLookADir: launch.sourceDir,
    sourceImageGenerationCallCount: loaded.sourceCallCount,
    currentImageGenerationCallCount: run.imageGenerationCallCount,
    sourceRegisteredLookAChecksum: loaded.row9RegisteredChecksum,
    imageGeneration: {
      requestedModel: CODEX_PET_LOOK_POC_REQUESTED_MODEL,
      expectedActualModel: CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL,
      approvedImageCalls: 1,
      observedImageCalls,
      maxAttempts: 1,
      automaticRetry: false,
      stopOnFailure: true,
    },
    visualQaCalls: observedVisualQaCalls,
    files: {
      anchorStoryboard: "look-b-anchor-storyboard.png",
      trajectory: "look-b-screen-left-trajectory-scaffold.png",
      registeredLookAReference: "approved-registered-look-row-9-4x2.png",
      layout: "look-b-layout.png",
      prompt: "look-b-prompt.txt",
    },
  }, null, 2)}\n`);
  return { anchorStoryboard, trajectory, layout, prompt };
}

async function consumePersistentApproval(): Promise<void> {
  const marker = resolve(launch.outputDir, ".single-image-call-consumed.json");
  try {
    await writeFile(marker, `${JSON.stringify({
      sourceRunId: launch.sourceRunId,
      row: "look-b",
      approvedImageCalls: 1,
      consumedAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (recordOf(error).code === "EEXIST") throw new Error("this look-b output directory already consumed its approved call");
    throw error;
  }
}

describe.skipIf(launch.mode === "disabled")("Codex pet guarded real look-b POC", () => {
  beforeAll(async () => {
    loaded = await loadLookBSource();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.skipIf(launch.mode !== "prepare")("prepares row 10 only from an approved locked row 9", async () => {
    await prepareLookB("prepare");
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: launch.sourceRunId }, select: { imageGenerationCallCount: true } });
    expect(run.imageGenerationCallCount).toBe(loaded.sourceCallCount);
  }, 120_000);

  it.skipIf(launch.mode !== "live")("uses exactly one GPT Image call for row 10 and keeps row-9 registration immutable", async () => {
    const prepared = await prepareLookB("live");
    const guard = createCodexPetLookPocSingleCallGuard({ runId: launch.sourceRunId, approvalToken: launch.approvalToken });
    const generated = await generateCodexPetVisual({
      prompt: prepared.prompt,
      model: CODEX_PET_LOOK_POC_REQUESTED_MODEL,
      references: [
        { b64: prepared.trajectory.toString("base64"), mime: "image/png", filename: "look-b-screen-left-trajectory-scaffold.png" },
        { b64: loaded.canonical.toString("base64"), mime: loaded.canonicalMime, filename: "approved-canonical-base.png" },
        { b64: loaded.cardinalAnchor.toString("base64"), mime: loaded.cardinalMime, filename: "approved-cardinal-anchor-strip.png" },
        { b64: prepared.anchorStoryboard.toString("base64"), mime: "image/png", filename: "look-b-approved-cardinal-endpoint-storyboard.png" },
        { b64: loaded.row9Reference.toString("base64"), mime: "image/png", filename: "approved-registered-look-row-9-4x2.png" },
        { b64: loaded.standardContact.toString("base64"), mime: "image/png", filename: "approved-standard-contact.png" },
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
    await writeFile(resolve(launch.outputDir, "look-b-raw.png"), generated.buffer);
    const extracted = await extractPoseBoard(generated.buffer, {
      columns: 4,
      rows: 2,
      frameCount: 8,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
      chromaKey: loaded.chromaKey,
      requireUnusedSlotsEmpty: true,
    });
    const normalized = await composeNormalizedPoseBoard(extracted.frames, { columns: 4, rows: 2, chromaKey: loaded.chromaKey });
    await writeFile(resolve(launch.outputDir, "look-b-normalized.png"), normalized);
    const registered = await registerSecondDirectionRowWithManifest(generated.buffer, loaded.neutral, loaded.row9Manifest, {
      chromaKey: loaded.chromaKey,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    });
    const registeredBoard = await composeNormalizedPoseBoard(registered.frames, { columns: 4, rows: 2, chromaKey: loaded.chromaKey });
    await writeFile(resolve(launch.outputDir, "look-b-registered.png"), registeredBoard);
    const framesDir = resolve(launch.outputDir, "look-b-registered-frames");
    await mkdir(framesDir, { recursive: true });
    await Promise.all(registered.frames.map((frame, index) => writeFile(resolve(framesDir, `${String(index).padStart(2, "0")}.png`), frame)));
    const continuity = await measureDirectionRowContinuity(registered.frames, LOOK_DIRECTIONS.slice(8));
    const preview = registered.ok ? await createAnimatedWebpPreview(registered.frames, petRowSpec("look-b").durations) : null;
    if (preview) await writeFile(resolve(launch.outputDir, "look-b-preview.webp"), preview.image);

    if (!extracted.ok) throw new Error(`look-b extraction failed: ${extracted.errors.join("; ")}`);
    if (!registered.ok) throw new Error(`look-b registration failed: ${registered.errors.join("; ")}`);
    if (!continuity.ok) throw new Error(`look-b continuity failed: ${continuity.errors.join("; ")}`);
    if (!preview) throw new Error("look-b preview is unavailable after registration");

    const semanticQa = await runCodexPetVisualQaConsensus({
      images: [
        { buffer: loaded.canonical, mime: loaded.canonicalMime },
        { buffer: loaded.standardContact, mime: "image/png" },
        { buffer: loaded.cardinalAnchor, mime: loaded.cardinalMime },
        { buffer: loaded.row9Reference, mime: "image/png" },
        { buffer: registeredBoard, mime: "image/png" },
        { buffer: preview.image, mime: preview.mime },
      ],
      prompt: buildVisualQaPrompt(
        "directions",
        `Checksum-bound row-10 gate for registered directions 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5. `
        + `Confirm 180 unmistakably down/front-facing, 270 unmistakably screen-left, every intermediate stays in its labeled quadrant, and the row advances clockwise without reversal, registration snap, scale pop or identity drift. `
        + `Image 3 is the approved 2x2 cardinal basis, Image 4 is approved row 9, Image 5 is the complete static registered row 10, and Image 6 is its animation preview. `
        + `Check both row-boundary seams 157.5 to 180 and 337.5 to 000. Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
        loaded.identity.canonicalGuide,
      ),
      env: process.env,
      repetitions: 1,
    });
    const semanticProvenance = semanticQa.modelProvenance;
    if (!semanticProvenance
      || semanticProvenance.requestedModel !== "gpt-5.6-sol"
      || semanticProvenance.actualModels.length !== 1
      || semanticProvenance.actualModels[0] !== "gpt-5.6-sol"
      || semanticProvenance.route !== "chatgpt_model_route") {
      throw new Error("look-b semantic QA did not use the selected Pixel GPT model route");
    }
    const semanticPassed = codexPetVisualQaConsensusPasses(semanticQa);
    const registeredBoardChecksum = hash(registeredBoard);
    await writeFile(resolve(launch.outputDir, "look-b-semantic-approval.json"), `${JSON.stringify({
      schemaVersion: "codex-pet-look-semantic-approval-v1",
      sourceRunId: launch.sourceRunId,
      row: "look-b",
      verdict: semanticPassed ? "pass" : "fail",
      registeredBoardChecksum,
      sourceRegisteredLookAChecksum: loaded.row9RegisteredChecksum,
      modelProvenance: {
        requestedModel: semanticProvenance.requestedModel,
        actualModel: semanticProvenance.actualModels[0],
        route: semanticProvenance.route,
      },
      qa: semanticQa,
    }, null, 2)}\n`);
    await prepareLookB("live", guard.attemptCount(), 1);
    await writeFile(resolve(launch.outputDir, "look-b-result.json"), `${JSON.stringify({
      provider: generated.provider,
      modelCalls: { imageGeneration: guard.attemptCount(), visualQa: 1 },
      sourceRegisteredLookAChecksum: loaded.row9RegisteredChecksum,
      registrationManifestSchema: registered.manifest.schemaVersion,
      deterministic: {
        extractionOk: extracted.ok,
        extractionErrors: extracted.errors,
        registrationOk: registered.ok,
        registrationErrors: registered.errors,
        continuity,
      },
      semanticQa,
      outputs: { semanticApproval: "look-b-semantic-approval.json" },
    }, null, 2)}\n`);
    expect(guard.attemptCount()).toBe(1);
    expect(generated.provider.actualModel).toBe(CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL);
    expect(registered.manifest).toEqual(loaded.row9Manifest);
    expect(extracted.ok, extracted.errors.join("; ")).toBe(true);
    expect(registered.ok, registered.errors.join("; ")).toBe(true);
    expect(continuity.ok, continuity.errors.join("; ")).toBe(true);
    expect(semanticPassed, semanticQa.failures.join("; ")).toBe(true);
  }, 600_000);
});
