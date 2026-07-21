import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  LOOK_DIRECTIONS,
  PET_ROW_SPECS,
  assembleStandardPetAtlas,
  createStandardAtlasContactSheet,
  extractPoseBoard,
  measureDirectionRowContinuity,
  registerFirstDirectionRowToNeutral,
  validateStandardPetAtlas,
  type PetFramesByState,
} from "../packages/codex-pet-pipeline/src/index.js";

const replayDir = resolve(".cc-tmp/r7-replay");
const outputDir = resolve(replayDir, "offline-replay");
const chromaKey = "#ff00ff";

interface ManifestArtifact {
  readonly id: string;
  readonly jobKey: string;
  readonly kind: string;
  readonly filename: string;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rgbaDistance(left: Buffer, right: Buffer): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(left).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(right).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.info.channels !== b.info.channels) {
    throw new Error("Cardinal distance inputs must have identical dimensions");
  }
  let difference = 0;
  let weight = 0;
  for (let offset = 0; offset < a.data.length; offset += a.info.channels) {
    const alphaA = a.data[offset + 3] ?? 0;
    const alphaB = b.data[offset + 3] ?? 0;
    const alphaWeight = Math.max(alphaA, alphaB) / 255;
    difference += Math.abs(alphaA - alphaB);
    weight += 255;
    for (let channel = 0; channel < 3; channel += 1) {
      difference += Math.abs((a.data[offset + channel] ?? 0) - (b.data[offset + channel] ?? 0)) * alphaWeight;
      weight += 255 * alphaWeight;
    }
  }
  return Number((difference / Math.max(1, weight)).toFixed(6));
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(replayDir, "manifest.json"), "utf8")) as {
    artifacts: ManifestArtifact[];
  };
  const find = (jobKey: string, kind: string, suffix = "") => {
    const matches = manifest.artifacts.filter((artifact) => (
      artifact.jobKey === jobKey && artifact.kind === kind && artifact.filename.includes(suffix)
    ));
    if (matches.length !== 1) throw new Error(`Expected one ${jobKey}/${kind}/${suffix}, found ${matches.length}`);
    return matches[0]!;
  };
  await mkdir(outputDir, { recursive: true });

  const framesByState: PetFramesByState = {};
  const standardRows: Array<Record<string, unknown>> = [];
  for (const spec of PET_ROW_SPECS.slice(0, 9)) {
    const jobKey = `row-${spec.state}`;
    const artifact = find(jobKey, "pose_board");
    const board = await readFile(resolve(replayDir, artifact.filename));
    const extracted = await extractPoseBoard(board, {
      columns: spec.boardColumns,
      rows: spec.boardRows,
      frameCount: spec.frameCount,
      chromaKey,
      requireUnusedSlotsEmpty: true,
      allowVerticalTravel: spec.state === "jumping",
      requireJumpingArc: spec.state === "jumping",
      maxHeightRatio: spec.state === "jumping" || spec.state === "failed" ? 1.8 : undefined,
    });
    framesByState[spec.state] = extracted.frames;
    standardRows.push({
      state: spec.state,
      artifactId: artifact.id,
      ok: extracted.ok,
      errors: extracted.errors,
      warnings: extracted.warnings,
      frameCount: extracted.frames.length,
      sourceSize: `${extracted.sourceWidth}x${extracted.sourceHeight}`,
      sharedScale: extracted.sharedScale,
      geometry: extracted.geometry,
    });
  }

  const replayAtlas = await assembleStandardPetAtlas(framesByState, "webp");
  const atlasValidation = await validateStandardPetAtlas(replayAtlas);
  const storedAtlasArtifact = find("standard-atlas", "standard_atlas");
  const storedAtlas = await readFile(resolve(replayDir, storedAtlasArtifact.filename));
  const storedAtlasValidation = await validateStandardPetAtlas(storedAtlas);
  const replayContact = await createStandardAtlasContactSheet(replayAtlas);
  await writeFile(resolve(outputDir, "standard-atlas-replayed.webp"), replayAtlas);
  await writeFile(resolve(outputDir, "standard-contact-replayed.png"), replayContact);

  const idleFrames = framesByState.idle;
  if (!idleFrames?.[0]) throw new Error("Offline replay did not produce the neutral idle frame");
  const cardinalArtifact = find("cardinal-anchor-strip", "cardinal_anchor_strip");
  const cardinalStrip = await readFile(resolve(replayDir, cardinalArtifact.filename));
  const cardinalFrames = await Promise.all(Array.from({ length: 4 }, (_, index) => sharp(cardinalStrip).extract({
    left: (index % 2) * 192,
    top: Math.floor(index / 2) * 208,
    width: 192,
    height: 208,
  }).png().toBuffer()));
  const lookAttempts = manifest.artifacts.filter((artifact) => artifact.jobKey === "look-a" && artifact.kind === "pose_board");
  const directionRows: Array<Record<string, unknown>> = [];
  for (const [index, artifact] of lookAttempts.entries()) {
    const board = await readFile(resolve(replayDir, artifact.filename));
    const registered = await registerFirstDirectionRowToNeutral(board, idleFrames[0], {
      chromaKey,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    });
    const continuity = await measureDirectionRowContinuity(registered.frames, LOOK_DIRECTIONS.slice(0, 8));
    const attemptTag = `000-157.5-${index + 1}`;
    const qaArtifact = manifest.artifacts.find((candidate) => (
      candidate.jobKey === "look-a"
      && candidate.kind === "qa_report"
      && candidate.filename.includes(attemptTag)
    ));
    const persistedQa = qaArtifact
      ? recordOf(recordOf(JSON.parse(await readFile(resolve(replayDir, qaArtifact.filename), "utf8"))).visual)
      : {};
    const cardinalDistances = {
      frame1: {
        to000: await rgbaDistance(registered.frames[0]!, cardinalFrames[0]!),
        to180: await rgbaDistance(registered.frames[0]!, cardinalFrames[2]!),
      },
      frame5: {
        to090: await rgbaDistance(registered.frames[4]!, cardinalFrames[1]!),
        to270: await rgbaDistance(registered.frames[4]!, cardinalFrames[3]!),
      },
      frame8: {
        to180: await rgbaDistance(registered.frames[7]!, cardinalFrames[2]!),
        to000: await rgbaDistance(registered.frames[7]!, cardinalFrames[0]!),
      },
    };
    const label = `look-a-attempt-${index + 1}`;
    await writeFile(resolve(outputDir, `${label}-registered.png`), registered.registeredRow);
    await writeFile(resolve(outputDir, `${label}-registration.json`), `${JSON.stringify({
      artifactId: artifact.id,
      ok: registered.ok,
      errors: registered.errors,
      warnings: registered.warnings,
      validation: registered.validation,
      diagnostics: registered.diagnostics,
      continuity,
    }, null, 2)}\n`);
    directionRows.push({
      attempt: index + 1,
      artifactId: artifact.id,
      registrationOk: registered.ok,
      registrationErrors: registered.errors,
      registrationWarnings: registered.warnings,
      medianHeightRatio: registered.validation.medianHeightRatio,
      continuityOk: continuity.ok,
      continuityWarnings: continuity.warnings.map((warning) => warning.message),
      continuityMedianAlphaDifferenceRatio: continuity.medianAlphaDifferenceRatio,
      deterministicFrameCount: registered.frames.length,
      cardinalDistances,
      persistedQa: {
        pass: persistedQa.pass ?? null,
        score: persistedQa.score ?? null,
        failures: Array.isArray(persistedQa.failures) ? persistedQa.failures : [],
        warnings: Array.isArray(persistedQa.warnings) ? persistedQa.warnings : [],
      },
    });
  }

  const closestDirectionRow = directionRows
    .filter((row) => row.registrationOk === true && row.continuityOk === true && typeof row.continuityMedianAlphaDifferenceRatio === "number")
    .sort((left, right) => Number(left.continuityMedianAlphaDifferenceRatio) - Number(right.continuityMedianAlphaDifferenceRatio))[0] ?? null;

  const report = {
    zeroModelCalls: true,
    standardRows,
    standardAtlas: {
      replayValidation: atlasValidation,
      storedValidation: storedAtlasValidation,
      replayFileHash: hash(replayAtlas),
      storedFileHash: hash(storedAtlas),
      bytesMatchStoredArtifact: hash(replayAtlas) === hash(storedAtlas),
    },
    directionRows,
    closestDirectionRow: closestDirectionRow
      ? {
          attempt: closestDirectionRow.attempt,
          artifactId: closestDirectionRow.artifactId,
          criterion: "lowest registered continuityMedianAlphaDifferenceRatio",
          continuityMedianAlphaDifferenceRatio: closestDirectionRow.continuityMedianAlphaDifferenceRatio,
          registrationOk: closestDirectionRow.registrationOk,
          continuityOk: closestDirectionRow.continuityOk,
          warnings: closestDirectionRow.continuityWarnings,
        }
      : null,
  };
  await writeFile(resolve(outputDir, "offline-replay-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    report: resolve(outputDir, "offline-replay-report.json"),
    standardRowsOk: standardRows.every((row) => row.ok === true),
    atlasOk: atlasValidation.ok && storedAtlasValidation.ok,
    directionRows,
    closestDirectionRow: report.closestDirectionRow,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
