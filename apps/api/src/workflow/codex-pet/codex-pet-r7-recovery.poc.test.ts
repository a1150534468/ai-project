import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getPrisma } from "@ai-assistant/db";
import {
  LOOK_DIRECTIONS,
  PET_ROW_SPECS,
  assemblePetAtlas,
  assembleStandardPetAtlas,
  createAnimatedWebpPreview,
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  despillChromaEdges,
  inspectCodexPetZip,
  measureDirectionContinuity,
  validatePetAtlas,
  type PetFramesByState,
} from "@ai-assistant/codex-pet-pipeline";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { makeS3 } from "../../storage/s3.js";
import { buildVisualQaPrompt } from "./codex-pet-prompts.js";
import {
  buildCodexPetRecoverySeed,
  finalizeCodexPetRecovery,
  initializeCodexPetRecoveryRun,
  type CodexPetRecoveryBuildInput,
  type CodexPetRecoveryQaEvidence,
} from "./codex-pet-recovery-finalizer.js";
import { createCodexPetArtifactStore } from "./codex-pet-storage.js";
import {
  codexPetVisualQaVerdictPasses,
  runBlindDirectionQa,
  runCodexPetVisualQa,
  runLabeledDirectionSemantics,
  type BlindDirectionValidation,
  type DirectionSemanticVerdict,
  type PetVisualQaVerdict,
} from "./codex-pet-visual.js";

const enabled = process.env.RUN_CODEX_PET_R7_RECOVERY === "1";
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
if (enabled) {
  const envFile = existsSync(resolve(root, ".env.local")) ? resolve(root, ".env.local") : resolve(root, ".env");
  (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(envFile);
}

const SOURCE_RUN_ID = "cpr_3a7a7ee330675f6f5f3b4d58e0ef5b5b";
const PROJECT_ID = "cmrteijsv0002c3opa4jyt04z";
const LOOK_A_DIR = resolve(root, ".cc-tmp/r7-look-poc");
const LOOK_B_DIR = resolve(root, ".cc-tmp/r7-look-b-poc");
const OUTPUT_DIR = resolve(root, ".cc-tmp/r7-recovery");
const WORKER_ID = "codex-pet-r7-recovery-local";
const EXPECTED_IMAGE_CALLS = 26;
const ACCEPTED_QA_EVIDENCE_CALLS = 5;
const OBSERVED_RECOVERY_VISUAL_QA_CALLS = 11;
const EXPECTED_VISUAL_MODEL = "gpt-5.6-sol";
const EXPECTED_VISUAL_ROUTE = "chatgpt_model_route";
const prisma = getPrisma();

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<JsonRecord> {
  return record(JSON.parse(await readFile(path, "utf8")));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadFrames(directory: string): Promise<readonly Buffer[]> {
  return Promise.all(Array.from({ length: 8 }, (_, index) => (
    readFile(resolve(directory, `${String(index).padStart(2, "0")}.png`))
  )));
}

async function extractStandardFrames(atlas: Buffer): Promise<PetFramesByState> {
  const metadata = await sharp(atlas).metadata();
  if (metadata.width !== 1536 || metadata.height !== 1872) {
    throw new Error("R7 recovery requires the validated 1536x1872 standard atlas");
  }
  const frames: PetFramesByState = {};
  for (const spec of PET_ROW_SPECS.slice(0, 9)) {
    frames[spec.state] = await Promise.all(Array.from({ length: spec.frameCount }, (_, column) => (
      sharp(atlas).extract({
        left: column * 192,
        top: spec.row * 208,
        width: 192,
        height: 208,
      }).png().toBuffer()
    )));
  }
  return frames;
}

type AlphaBounds = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

async function alphaBounds(frame: Buffer): Promise<AlphaBounds> {
  const { data, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3]! <= 8) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error("cannot normalize an empty jumping frame");
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

async function normalizeJumpingFrames(frames: PetFramesByState): Promise<{
  readonly frames: PetFramesByState;
  readonly report: JsonRecord;
}> {
  const idle = frames.idle;
  const jumping = frames.jumping;
  if (!idle?.length || jumping?.length !== 5) throw new Error("standard frames do not contain idle and five jumping cells");
  const idleBounds = await Promise.all(idle.map(alphaBounds));
  const medianIdleHeight = [...idleBounds].sort((a, b) => a.height - b.height)[Math.floor(idleBounds.length / 2)]!.height;
  const targetHeight = Math.min(174, medianIdleHeight - 5);
  const sourceBounds = await Promise.all(jumping.map(alphaBounds));
  const sourceBottomMin = Math.min(...sourceBounds.map((bounds) => bounds.bottom));
  const sourceBottomMax = Math.max(...sourceBounds.map((bounds) => bounds.bottom));
  const outputBottomMin = 3 + targetHeight - 1;
  const outputBottomMax = 195;
  const outputBounds = new Array<AlphaBounds>(jumping.length);
  const corrected = await Promise.all(jumping.map(async (frame, index) => {
    const bounds = sourceBounds[index]!;
    const crop = await sharp(frame).extract({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }).resize({ height: targetHeight, kernel: sharp.kernel.nearest }).png().toBuffer();
    const metadata = await sharp(crop).metadata();
    const width = metadata.width!;
    const height = metadata.height!;
    const sourceCenterX = (bounds.left + bounds.right) / 2;
    const left = Math.max(8, Math.min(192 - 8 - width, Math.round(sourceCenterX - width / 2)));
    const normalizedBottom = Math.round(outputBottomMin
      + ((bounds.bottom - sourceBottomMin) / Math.max(1, sourceBottomMax - sourceBottomMin)) * (outputBottomMax - outputBottomMin));
    const top = normalizedBottom - height + 1;
    const normalized = await sharp({
      create: { width: 192, height: 208, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: crop, left, top }]).png().toBuffer();
    outputBounds[index] = await alphaBounds(normalized);
    return normalized;
  }));
  const ground = outputBounds.map((bounds) => bounds.bottom);
  const peakLiftPixels = Math.max(ground[0]!, ground[ground.length - 1]!) - Math.min(...ground);
  if (peakLiftPixels < 18 || outputBounds.some((bounds) => bounds.left < 8 || bounds.right > 183 || bounds.top < 3 || bounds.bottom > 195)) {
    throw new Error("deterministic jumping normalization broke the required arc or safe padding");
  }
  return {
    frames: { ...frames, jumping: corrected },
    report: {
      ok: true,
      algorithm: "neutral-median-height-lock-v2",
      medianIdleHeight,
      targetHeight,
      sourceBounds,
      outputBounds,
      sourceBottoms: sourceBounds.map((bounds) => bounds.bottom),
      outputBottoms: ground,
      peakLiftPixels,
      imageGenerationCalls: 0,
    },
  };
}

function assertVisualProvenance(value: unknown, label: string): void {
  const provenance = record(value);
  const actualModels = Array.isArray(provenance.actualModels)
    ? provenance.actualModels.map(String)
    : typeof provenance.actualModel === "string" ? [provenance.actualModel] : [];
  if (provenance.requestedModel !== EXPECTED_VISUAL_MODEL
    || actualModels.length === 0
    || actualModels.some((model) => model !== EXPECTED_VISUAL_MODEL)
    || provenance.route !== EXPECTED_VISUAL_ROUTE) {
    throw new Error(`${label} did not use the selected Pixel GPT visual route`);
  }
}

function validateCachedQa(value: JsonRecord, atlasChecksum: string): {
  blind: BlindDirectionValidation;
  semantics: readonly DirectionSemanticVerdict[];
  finalQa: PetVisualQaVerdict;
} | null {
  if (value.schemaVersion !== "codex-pet-r7-recovery-qa-v1" || value.atlasChecksum !== atlasChecksum) return null;
  const blind = record(value.blind) as unknown as BlindDirectionValidation;
  const semantics = Array.isArray(value.semantics) ? value.semantics as unknown as readonly DirectionSemanticVerdict[] : [];
  const finalQa = record(value.finalQa) as unknown as PetVisualQaVerdict;
  if (!blind.ok || blind.reviewers?.length !== 3 || semantics.length !== LOOK_DIRECTIONS.length
    || semantics.some((item) => item.verdict === "fail") || !codexPetVisualQaVerdictPasses(finalQa)) return null;
  assertVisualProvenance(blind.modelProvenance, "cached blind QA");
  semantics.forEach((item) => assertVisualProvenance(item.modelProvenance, `cached direction ${item.direction}`));
  assertVisualProvenance(finalQa.modelProvenance, "cached final QA");
  return { blind, semantics, finalQa };
}

async function loadDirectionQaCheckpoint(blindSheetChecksum: string, directionSheetChecksum: string): Promise<{
  blind: BlindDirectionValidation;
  semantics: readonly DirectionSemanticVerdict[];
} | null> {
  const checkpointPath = resolve(OUTPUT_DIR, "direction-qa-checkpoint.json");
  if (!existsSync(checkpointPath)) return null;
  const checkpoint = await readJson(checkpointPath);
  if (checkpoint.schemaVersion !== "codex-pet-direction-qa-checkpoint-v1"
    || checkpoint.sourceRunId !== SOURCE_RUN_ID
    || checkpoint.blindSheetChecksum !== blindSheetChecksum
    || checkpoint.directionSheetChecksum !== directionSheetChecksum
    || checkpoint.blindReviewerCount !== 3
    || checkpoint.requestedModel !== EXPECTED_VISUAL_MODEL
    || checkpoint.actualModel !== EXPECTED_VISUAL_MODEL
    || checkpoint.route !== EXPECTED_VISUAL_ROUTE) return null;
  const blind = record(await readJson(resolve(OUTPUT_DIR, String(checkpoint.blindValidationFile)))) as unknown as BlindDirectionValidation;
  const rawSemantics = JSON.parse(await readFile(resolve(OUTPUT_DIR, String(checkpoint.directionSemanticsFile)), "utf8")) as unknown;
  const semantics = Array.isArray(rawSemantics) ? rawSemantics as readonly DirectionSemanticVerdict[] : [];
  if (!blind.ok || blind.reviewers?.length !== 3 || semantics.length !== LOOK_DIRECTIONS.length
    || semantics.some((item) => item.verdict === "fail")) return null;
  assertVisualProvenance(blind.modelProvenance, "checkpoint blind QA");
  semantics.forEach((item) => assertVisualProvenance(item.modelProvenance, `checkpoint direction ${item.direction}`));
  return { blind, semantics };
}

async function persistInputArtifact(input: {
  readonly artifacts: ReturnType<typeof createCodexPetArtifactStore>;
  readonly runId: string;
  readonly userId: string;
  readonly kind: string;
  readonly name: string;
  readonly buffer: Buffer;
  readonly mime: string;
}): Promise<string> {
  const checksum = sha256(input.buffer);
  const existing = await prisma.codexPetArtifact.findFirst({
    where: {
      runId: input.runId,
      projectId: PROJECT_ID,
      userId: input.userId,
      kind: input.kind,
      checksum,
      status: "ready",
    },
    select: { id: true },
  });
  if (existing) return existing.id;
  const artifact = await input.artifacts.put({
    userId: input.userId,
    projectId: PROJECT_ID,
    runId: input.runId,
    kind: input.kind,
    name: input.name,
    buffer: input.buffer,
    mime: input.mime,
    metadata: { recoverySourceRunId: SOURCE_RUN_ID, checksum },
  });
  return artifact.id;
}

describe.skipIf(!enabled)("Codex pet R7 real zero-image recovery", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("finishes the failed GPT run without another image generation call", async () => {
    await mkdir(OUTPUT_DIR, { recursive: true });
    const source = await prisma.codexPetRun.findUnique({
      where: { id: SOURCE_RUN_ID },
      include: { project: true },
    });
    if (!source || source.projectId !== PROJECT_ID) throw new Error("R7 source run is unavailable");
    if (source.status !== "failed" || source.workerId) {
      throw new Error("R7 source run is not in the immutable failed state");
    }
    if (source.requestedModel !== "gpt-image-2" || source.visualQaModel !== EXPECTED_VISUAL_MODEL
      || source.colorKey !== "#ff00ff" || source.imageGenerationCallCount !== 24) {
      throw new Error("R7 source model, chroma, or image-call contract changed");
    }

    const jobs = await prisma.codexPetJob.findMany({
      where: { runId: SOURCE_RUN_ID, key: { in: ["identity-guide", "look-mechanics", "look-cardinals", "standard-atlas"] } },
    });
    const job = (key: string) => jobs.find((candidate) => candidate.key === key);
    const identityJob = job("identity-guide");
    const mechanicsJob = job("look-mechanics");
    const cardinalJob = job("look-cardinals");
    const standardJob = job("standard-atlas");
    const identityGuide = String(record(identityJob?.output).guide ?? "").trim();
    const mechanics = String(record(mechanicsJob?.output).mechanics ?? "").trim();
    if ([identityJob, mechanicsJob, cardinalJob, standardJob].some((item) => item?.status !== "completed")
      || !identityGuide || !mechanics) {
      throw new Error("R7 source deterministic inputs are incomplete");
    }

    const standardOutput = record(standardJob?.output);
    const standardAtlasId = String(standardOutput.atlasArtifactId ?? "");
    const sourceArtifactIds = [
      source.selectedBaseArtifactId,
      standardAtlasId,
      String(standardOutput.contactArtifactId ?? ""),
      String((await prisma.codexPetArtifact.findFirst({
        where: { runId: SOURCE_RUN_ID, kind: "cardinal_anchor_strip", status: "ready" },
        select: { id: true },
      }))?.id ?? ""),
    ].filter((value): value is string => Boolean(value));
    const sourceArtifacts = await prisma.codexPetArtifact.findMany({
      where: { id: { in: sourceArtifactIds }, runId: SOURCE_RUN_ID, projectId: PROJECT_ID, userId: source.userId, status: "ready" },
    });
    const sourceArtifact = (id: string | null | undefined) => sourceArtifacts.find((artifact) => artifact.id === id);
    const standardArtifact = sourceArtifact(standardAtlasId);
    const canonicalArtifact = sourceArtifact(source.selectedBaseArtifactId);
    const contactArtifact = sourceArtifact(String(standardOutput.contactArtifactId ?? ""));
    const cardinalArtifact = sourceArtifacts.find((artifact) => artifact.kind === "cardinal_anchor_strip");
    if (!standardArtifact || !canonicalArtifact || !contactArtifact || !cardinalArtifact) {
      throw new Error("R7 source artifacts are incomplete");
    }

    const artifacts = createCodexPetArtifactStore({ prisma, s3: makeS3() });
    const [standardAtlas, canonical, standardContact, cardinalAnchor, neutral, rowA, rowB] = await Promise.all([
      artifacts.load(standardArtifact),
      artifacts.load(canonicalArtifact),
      artifacts.load(contactArtifact),
      artifacts.load(cardinalArtifact),
      readFile(resolve(LOOK_A_DIR, "approved-neutral-idle-frame.png")),
      loadFrames(resolve(LOOK_A_DIR, "look-a-registered-frames")),
      loadFrames(resolve(LOOK_B_DIR, "look-b-registered-frames")),
    ]);
    const [registration, lookAResult, lookBResult, lookAApproval, lookBApproval] = await Promise.all([
      readJson(resolve(LOOK_A_DIR, "look-a-registration.json")),
      readJson(resolve(LOOK_A_DIR, "look-a-result.json")),
      readJson(resolve(LOOK_B_DIR, "look-b-result.json")),
      readJson(resolve(LOOK_A_DIR, "look-a-semantic-approval.json")),
      readJson(resolve(LOOK_B_DIR, "look-b-semantic-approval.json")),
    ]);
    const assertPoc = (result: JsonRecord, approval: JsonRecord, row: string) => {
      const provider = record(result.provider);
      const calls = record(result.modelCalls);
      const deterministic = record(result.deterministic);
      if (provider.requestedModel !== "gpt-image-2" || provider.actualModel !== "gpt-image-2-codex"
        || calls.imageGeneration !== 1 || calls.visualQa !== 1
        || deterministic.extractionOk !== true || deterministic.registrationOk !== true
        || record(deterministic.continuity).ok !== true || approval.verdict !== "pass" || approval.row !== row) {
        throw new Error(`${row} POC evidence is incomplete`);
      }
      const provenance = record(approval.modelProvenance);
      assertVisualProvenance({ ...provenance, actualModels: [provenance.actualModel] }, `${row} semantic gate`);
    };
    assertPoc(lookAResult, lookAApproval, "look-a");
    assertPoc(lookBResult, lookBApproval, "look-b");

    const extractedStandardFrames = await extractStandardFrames(standardAtlas);
    const jumpingCorrection = await normalizeJumpingFrames(extractedStandardFrames);
    const standardFrames = jumpingCorrection.frames;
    const correctedStandardAtlas = await assembleStandardPetAtlas(standardFrames, "webp");
    const frames: PetFramesByState = { ...standardFrames, "look-a": rowA, "look-b": rowB };
    const assembled = await assemblePetAtlas(frames, "png");
    const cleaned = await despillChromaEdges(assembled, source.colorKey);
    if (!cleaned.report.ok) throw new Error(`recovery despill failed with ${cleaned.report.remainingOpaqueKeyPixels} key pixels`);
    const validation = await validatePetAtlas(cleaned.image, source.colorKey);
    if (!validation.ok) throw new Error(`recovery atlas failed validation: ${validation.errors.join("; ")}`);
    const continuity = await measureDirectionContinuity(cleaned.image);
    if (!continuity.ok) throw new Error(`recovery direction continuity failed: ${continuity.errors.join("; ")}`);

    const petId = `${source.project.name}-${createHash("sha256").update(PROJECT_ID).digest("hex").slice(0, 10)}`;
    const packaged = await createCodexPetPackage({
      id: petId,
      displayName: source.project.name,
      description: source.project.description,
      spritesheet: cleaned.image,
    });
    const [contactSheet, directionSheet, blindSheet, motionPreviews] = await Promise.all([
      createAtlasContactSheet(packaged.spritesheet),
      createDirectionQaSheet(packaged.spritesheet),
      createDirectionBlindQaSheet(packaged.spritesheet),
      Promise.all(PET_ROW_SPECS.slice(0, 9).map((spec) => (
        createAnimatedWebpPreview(standardFrames[spec.state]!, spec.durations)
      ))),
    ]);
    const atlasChecksum = sha256(cleaned.image);
    await Promise.all([
      writeFile(resolve(OUTPUT_DIR, "spritesheet-extended.png"), cleaned.image),
      writeFile(resolve(OUTPUT_DIR, "spritesheet-extended.webp"), packaged.spritesheet),
      writeFile(resolve(OUTPUT_DIR, "contact-sheet-extended.png"), contactSheet),
      writeFile(resolve(OUTPUT_DIR, "look-directions.png"), directionSheet),
      writeFile(resolve(OUTPUT_DIR, "direction-blind-pairs.png"), blindSheet.image),
      writeJson(resolve(OUTPUT_DIR, "direction-blind-answer-key.json"), blindSheet.answerKey),
      writeJson(resolve(OUTPUT_DIR, "chroma-despill-extended.json"), cleaned.report),
      writeJson(resolve(OUTPUT_DIR, "validation-extended.json"), validation),
      writeJson(resolve(OUTPUT_DIR, "look-continuity.json"), continuity),
      writeFile(resolve(OUTPUT_DIR, "standard-atlas-corrected.webp"), correctedStandardAtlas),
      writeJson(resolve(OUTPUT_DIR, "jumping-registration-correction.json"), jumpingCorrection.report),
      ...motionPreviews.map((preview, index) => writeFile(
        resolve(OUTPUT_DIR, `preview-${String(index).padStart(2, "0")}-${PET_ROW_SPECS[index]!.state}.webp`),
        preview.image,
      )),
    ]);
    await writeJson(resolve(OUTPUT_DIR, "preflight.json"), {
      schemaVersion: "codex-pet-r7-recovery-preflight-v1",
      sourceRunId: SOURCE_RUN_ID,
      sourceImageGenerationCallCount: source.imageGenerationCallCount,
      totalApprovedImageGenerationCalls: EXPECTED_IMAGE_CALLS,
      recoveryImageGenerationCalls: 0,
      atlasChecksum,
      dimensions: "1536x2288",
      requestedImageModel: source.requestedModel,
      actualImageModel: "gpt-image-2-codex",
      requestedVisualModel: source.visualQaModel,
      visualRoute: EXPECTED_VISUAL_ROUTE,
      qaCalls: { blindReviewers: 3, labeledSemantics: 1, finalVisualQa: 1 },
    });

    const qaCachePath = resolve(OUTPUT_DIR, "recovery-qa-evidence.json");
    let qa = existsSync(qaCachePath) ? validateCachedQa(await readJson(qaCachePath), atlasChecksum) : null;
    if (!qa) {
      const qaEnv = { ...process.env, PET_VISUAL_QA_MODEL: source.visualQaModel };
      const blindSheetChecksum = sha256(blindSheet.image);
      const directionSheetChecksum = sha256(directionSheet);
      const checkpoint = await loadDirectionQaCheckpoint(blindSheetChecksum, directionSheetChecksum);
      const directionQa = checkpoint ?? await (async () => {
        const [blind, semantics] = await Promise.all([
          runBlindDirectionQa({
            sheet: blindSheet.image,
            answerKey: blindSheet.answerKey,
            identityGuide,
            env: qaEnv,
          }),
          runLabeledDirectionSemantics({
            sheet: directionSheet,
            expectedDirections: LOOK_DIRECTIONS,
            identityGuide,
            env: qaEnv,
          }),
        ]);
        await Promise.all([
          writeJson(resolve(OUTPUT_DIR, "direction-blind-validation.json"), blind),
          writeJson(resolve(OUTPUT_DIR, "direction-semantics.json"), semantics),
          writeJson(resolve(OUTPUT_DIR, "direction-qa-checkpoint.json"), {
            schemaVersion: "codex-pet-direction-qa-checkpoint-v1",
            sourceRunId: SOURCE_RUN_ID,
            blindSheetChecksum,
            directionSheetChecksum,
            blindValidationFile: "direction-blind-validation.json",
            directionSemanticsFile: "direction-semantics.json",
            blindReviewerCount: 3,
            labeledSemanticsCalls: 1,
            requestedModel: EXPECTED_VISUAL_MODEL,
            actualModel: EXPECTED_VISUAL_MODEL,
            route: EXPECTED_VISUAL_ROUTE,
          }),
        ]);
        return { blind, semantics };
      })();
      const { blind, semantics } = directionQa;
      assertVisualProvenance(blind.modelProvenance, "blind QA");
      semantics.forEach((item) => assertVisualProvenance(item.modelProvenance, `direction ${item.direction}`));
      if (!blind.ok) throw new Error(`blind direction QA failed: ${blind.failures.join("; ")}`);
      const semanticFailures = semantics.filter((item) => item.verdict === "fail");
      if (semanticFailures.length) {
        throw new Error(`labeled direction QA failed: ${semanticFailures.map((item) => `${item.direction}:${item.reason}`).join("; ")}`);
      }
      const finalQa = await runCodexPetVisualQa({
        images: [
          { buffer: canonical, mime: canonicalArtifact.mime },
          { buffer: standardContact, mime: "image/png" },
          { buffer: contactSheet, mime: "image/png" },
          { buffer: directionSheet, mime: "image/png" },
          ...motionPreviews.map((preview) => ({ buffer: preview.image, mime: preview.mime })),
        ],
        prompt: buildVisualQaPrompt(
          "final",
          `R7 zero-image recovery. All nine standard rows and the complete labeled 16-direction loop are built from previously approved real-provider outputs; deterministic validation passed. `
          + `The first image is the canonical identity, followed by standard/final/direction sheets and nine animated WebP previews in row order. Inspect playback for cadence, vertical travel, inert loops, wrong facing, reversal, size popping and baseline jumps. `
          + `If any action group is defective, list its complete row name in repairRows. Continuity metrics are review evidence only: ${continuity.warnings.map((item) => item.message).slice(0, 20).join(" | ") || "none"}.`,
          identityGuide,
        ),
        env: qaEnv,
      });
      assertVisualProvenance(finalQa.modelProvenance, "final visual QA");
      await writeJson(resolve(OUTPUT_DIR, "final-visual-qa.json"), finalQa);
      if (!codexPetVisualQaVerdictPasses(finalQa)) {
        throw new Error(`final visual QA failed: ${finalQa.failures.join("; ") || finalQa.repairPrompt}`);
      }
      qa = { blind, semantics, finalQa };
      await writeJson(qaCachePath, {
        schemaVersion: "codex-pet-r7-recovery-qa-v1",
        sourceRunId: SOURCE_RUN_ID,
        atlasChecksum,
        modelCallCount: 5,
        blind,
        semantics,
        finalQa,
      });
    }

    const manifest = record(registration.manifest);
    const qaEvidence: CodexPetRecoveryQaEvidence = {
      cardinalAnchor: {
        passed: true,
        sourceJobId: cardinalJob!.id,
        sourceArtifactId: cardinalArtifact.id,
        sourceQa: record(cardinalJob!.output).qa,
      },
      directionRegistration: {
        ok: true,
        schemaVersion: manifest.schemaVersion,
        row9RegisteredChecksum: lookAApproval.registeredBoardChecksum,
        row10RegisteredChecksum: lookBApproval.registeredBoardChecksum,
        row9ImmutableDuringRow10Registration: lookBApproval.sourceRegisteredLookAChecksum === lookAApproval.registeredBoardChecksum,
      },
      row9PreGenerationGate: { passed: true, approval: lookAApproval, deterministic: lookAResult.deterministic },
      row10PreGenerationGate: { passed: true, approval: lookBApproval, deterministic: lookBResult.deterministic },
      blindDirectionValidation: qa.blind,
      directionSemantics: qa.semantics,
      finalVisualQa: qa.finalQa,
      finalRepairHistory: [],
    };
    const provider: CodexPetRecoveryBuildInput["provider"] = {
      imageGeneration: {
        requestedModel: source.requestedModel,
        actualModels: ["gpt-image-2-codex"],
        usage: {
          imageGenerationCalls: EXPECTED_IMAGE_CALLS,
          sourceImageGenerationCalls: source.imageGenerationCallCount,
          standaloneLookPocCalls: 2,
          recoveryImageGenerationCalls: 0,
        },
      },
      visualQa: {
        requestedModel: source.visualQaModel,
        actualModels: [EXPECTED_VISUAL_MODEL],
        routes: [EXPECTED_VISUAL_ROUTE],
      },
    };
    const buildInput: CodexPetRecoveryBuildInput = {
      petId,
      displayName: source.project.name,
      description: source.project.description,
      chromaKey: source.colorKey,
      qualityInspectionEnabled: source.qualityInspectionEnabled,
      standardFrames,
      neutralFrame: neutral,
      registeredLookAFrames: rowA,
      registeredLookBFrames: rowB,
      registrationManifest: manifest,
      provider,
      qa: qaEvidence,
      inputArtifactIds: sourceArtifactIds,
    };
    const preDatabaseBuild = await buildCodexPetRecoverySeed(buildInput);
    await writeJson(resolve(OUTPUT_DIR, "recovery-validation-report-pre-db.json"), preDatabaseBuild.report);

    const initialized = await initializeCodexPetRecoveryRun({
      ...buildInput,
      prisma,
      sourceRunId: SOURCE_RUN_ID,
      projectId: PROJECT_ID,
      userId: source.userId,
      workerId: WORKER_ID,
    });
    let recovery = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: initialized.runId } });
    if (recovery.status !== "ready") {
      const [rowABoard, rowBBoard, registrationBytes, lookAApprovalBytes, lookBApprovalBytes, correctionBytes] = await Promise.all([
        readFile(resolve(LOOK_A_DIR, "look-a-registered.png")),
        readFile(resolve(LOOK_B_DIR, "look-b-registered.png")),
        readFile(resolve(LOOK_A_DIR, "look-a-registration.json")),
        readFile(resolve(LOOK_A_DIR, "look-a-semantic-approval.json")),
        readFile(resolve(LOOK_B_DIR, "look-b-semantic-approval.json")),
        readFile(resolve(OUTPUT_DIR, "jumping-registration-correction.json")),
      ]);
      const recoveryInputArtifactIds = await Promise.all([
        persistInputArtifact({ artifacts, runId: recovery.id, userId: source.userId, kind: "registered_direction_row", name: "approved-look-row-9.png", buffer: rowABoard, mime: "image/png" }),
        persistInputArtifact({ artifacts, runId: recovery.id, userId: source.userId, kind: "registered_direction_row", name: "approved-look-row-10.png", buffer: rowBBoard, mime: "image/png" }),
        persistInputArtifact({ artifacts, runId: recovery.id, userId: source.userId, kind: "direction_registration_manifest", name: "direction-registration.json", buffer: registrationBytes, mime: "application/json" }),
        persistInputArtifact({ artifacts, runId: recovery.id, userId: source.userId, kind: "qa_report", name: "look-row-9-semantic-approval.json", buffer: lookAApprovalBytes, mime: "application/json" }),
        persistInputArtifact({ artifacts, runId: recovery.id, userId: source.userId, kind: "qa_report", name: "look-row-10-semantic-approval.json", buffer: lookBApprovalBytes, mime: "application/json" }),
        persistInputArtifact({ artifacts, runId: recovery.id, userId: source.userId, kind: "recovery_standard_atlas", name: "standard-atlas-corrected.webp", buffer: correctedStandardAtlas, mime: "image/webp" }),
        persistInputArtifact({ artifacts, runId: recovery.id, userId: source.userId, kind: "qa_report", name: "jumping-registration-correction.json", buffer: correctionBytes, mime: "application/json" }),
      ]);
      const finalized = await finalizeCodexPetRecovery({
        ...buildInput,
        inputArtifactIds: [...sourceArtifactIds, ...recoveryInputArtifactIds],
        prisma,
        artifacts,
        runId: recovery.id,
        projectId: PROJECT_ID,
        userId: source.userId,
        workerId: WORKER_ID,
      });
      if (sha256(finalized.finalAtlas) !== atlasChecksum) {
        throw new Error("recovery finalizer changed the checksum-bound approved atlas");
      }
      await Promise.all([
        writeFile(resolve(OUTPUT_DIR, "pet-v2.zip"), finalized.seed.zip),
        writeJson(resolve(OUTPUT_DIR, "recovery-validation-report.json"), finalized.report),
      ]);
      recovery = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: initialized.runId } });
    }

    const [sourceAfter, projectAfter] = await Promise.all([
      prisma.codexPetRun.findUniqueOrThrow({ where: { id: SOURCE_RUN_ID } }),
      prisma.codexPetProject.findUniqueOrThrow({ where: { id: PROJECT_ID } }),
    ]);
    expect(sourceAfter.status).toBe("failed");
    expect(sourceAfter.imageGenerationCallCount).toBe(24);
    expect(recovery.status).toBe("ready");
    expect(recovery.imageGenerationCallCount).toBe(EXPECTED_IMAGE_CALLS);
    // 这里原先断言 knowledgeDocumentId 非空。P1.2 之后交付根本不写知识库，这条断言
    // 从那时就该错了，只因为 RUN_CODEX_PET_R7_RECOVERY 这道开关默认关着才一直没跑到。
    // P5.4 顺手改成正确且更强的判据：这个用户名下一条文档都不该有。
    expect(await prisma.document.count({ where: { kb: { userId: recovery.userId } } })).toBe(0);
    expect(projectAfter.latestRunId).toBe(recovery.id);
    expect(projectAfter.status).toBe("ready");

    const finalArtifacts = await prisma.codexPetArtifact.findMany({
      where: { runId: recovery.id, id: { in: [recovery.spritesheetArtifactId!, recovery.packageArtifactId!, recovery.previewArtifactId!] } },
    });
    const finalArtifact = (id: string | null) => finalArtifacts.find((artifact) => artifact.id === id);
    const spritesheetArtifact = finalArtifact(recovery.spritesheetArtifactId);
    const packageArtifact = finalArtifact(recovery.packageArtifactId);
    if (!spritesheetArtifact || !packageArtifact) throw new Error("recovery package artifacts are incomplete");
    const [storedSpritesheet, storedZip] = await Promise.all([
      artifacts.load(spritesheetArtifact),
      artifacts.load(packageArtifact),
    ]);
    const [storedValidation, inspectedZip, storedMetadata] = await Promise.all([
      validatePetAtlas(storedSpritesheet, source.colorKey),
      inspectCodexPetZip(storedZip),
      sharp(storedSpritesheet).metadata(),
    ]);
    expect(storedValidation.ok, storedValidation.errors.join("; ")).toBe(true);
    expect(storedMetadata.width).toBe(1536);
    expect(storedMetadata.height).toBe(2288);
    expect(inspectedZip.manifest.spriteVersionNumber).toBe(2);
    expect(inspectedZip.manifest.spritesheetPath).toBe("spritesheet.webp");
    await Promise.all([
      writeFile(resolve(OUTPUT_DIR, "stored-spritesheet.webp"), storedSpritesheet),
      writeFile(resolve(OUTPUT_DIR, "stored-pet-v2.zip"), storedZip),
      writeJson(resolve(OUTPUT_DIR, "recovery-result.json"), {
        ok: true,
        sourceRunId: SOURCE_RUN_ID,
        recoveryRunId: recovery.id,
        projectId: PROJECT_ID,
        spritesheetArtifactId: recovery.spritesheetArtifactId,
        packageArtifactId: recovery.packageArtifactId,
        previewArtifactId: recovery.previewArtifactId,
        imageGenerationCalls: recovery.imageGenerationCallCount,
        recoveryImageGenerationCalls: 0,
        acceptedEvidenceCalls: ACCEPTED_QA_EVIDENCE_CALLS,
        // Includes discarded live QA attempts made while diagnosing and
        // correcting the recovery atlas, not only the final evidence set.
        observedRecoveryVisualQaCalls: OBSERVED_RECOVERY_VISUAL_QA_CALLS,
        requestedImageModel: recovery.requestedModel,
        actualImageModels: recovery.actualModels,
        requestedVisualModel: recovery.visualQaModel,
        visualRoute: EXPECTED_VISUAL_ROUTE,
        atlasChecksum,
        storedSpritesheetChecksum: sha256(storedSpritesheet),
        packageChecksum: sha256(storedZip),
        dimensions: `${storedMetadata.width}x${storedMetadata.height}`,
        spriteVersionNumber: inspectedZip.manifest.spriteVersionNumber,
      }),
    ]);
  }, 900_000);
});
