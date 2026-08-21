import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type CodexPetArtifact, type CodexPetJob, type CodexPetProject, type PrismaClient } from "@prisma/client";
import {
  LOOK_DIRECTIONS,
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  PET_ROW_SPECS,
  assemblePetAtlas,
  composeCardinalAnchorStrip,
  composeLookBScreenLeftTrajectoryReference,
  composeLookSourceBoardReference,
  chooseChromaKey,
  createAnimatedWebpPreview,
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  createLayoutGuide,
  createLookAnchorStoryboard,
  despillChromaEdges,
  inspectCodexPetZip,
  measureDirectionContinuity,
  measureDirectionRowContinuity,
  parseNeutralDirectionRegistrationManifest,
  petRowSpec,
  registerFirstDirectionRowToNeutral,
  registerSecondDirectionRowWithManifest,
  splitRegisteredDirectionRow,
  validatePetAtlas,
  validateNeutralLockedDirectionFrames,
  type DirectionRegistrationCellDiagnostics,
  type NeutralDirectionGeometryValidation,
  type NeutralDirectionRegistrationManifest,
  type PetFramesByState,
} from "@ai-assistant/codex-pet-pipeline";
import {
  DOUBAO_IMAGE_MODEL,
  GPT_IMAGE_MODEL,
  type ImageBinaryInput,
} from "./image-service.js";
import {
  CODEX_PET_MODEL_CONTRACT_VERSION,
  isAllowedCodexPetImageModel,
  isAllowedCodexPetImageProvenance,
  isAllowedCodexPetVisualModel,
} from "./codex-pet-model-contract.js";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CodexPetImageCallAlreadySentError,
  CodexPetImageCallApprovalRequiredError,
  CodexPetImageCallLimitError,
} from "./codex-pet-call-ledger.js";
import {
  codexPetGateFailureSnapshotValue,
} from "./codex-pet-gate-failure.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import {
  buildCardinalPrompt,
  CODEX_PET_CARDINAL_APPEARANCE_CONTRACT,
  buildLookMechanicsPrompt,
  buildLookRowPrompt,
  buildVisualQaPrompt,
  normalizeCodexPetActionPrompts,
  sanitizeCodexPetDirectionRepairPrompt,
} from "./codex-pet-prompts.js";
import {
  generateCodexPetIdentityGuide,
  generateCodexPetLookMechanics,
  generateCodexPetVisual,
  createSeedreamPoseBoardScaffold,
  codexPetVisualQaConsensusPasses,
  codexPetVisualQaVerdictPasses,
  resolveCodexPetVisualQaModel,
  runBlindDirectionQa,
  runCodexPetVisualQa,
  runCodexPetVisualQaConsensus,
  runLabeledDirectionSemantics,
  type BlindDirectionValidation,
  type CodexPetVisualModelProvenance,
  type DirectionSemanticVerdict,
  type PetVisualQaConsensus,
  type PetVisualQaVerdict,
} from "./codex-pet-visual.js";
import {
  CodexPetPackagingDeferredError,
  persistOrResumeCodexPetFinalPackage,
  type CodexPetDurablePackagingResult,
} from "./codex-pet-packaging.js";

// === 拆分模块导入（脚本维护，勿手改顺序） ===
import { deriveRunningLeft, runStandardRow, storeStandardAtlas } from "./codex-pet-runner/runner-standard-rows.js";
import {
  ensurePersistedBaseSelection,
  generateBaseCandidate,
  getIdentityGuide,
  selectBaseAutomatically,
} from "./codex-pet-runner/runner-base.js";
import { codexPetJumpingTargetHeight, runBoardJob } from "./codex-pet-runner/runner-board-job.js";
import {
  assertCodexPetVisualQaProvenance,
  atlasValidationErrorsWithoutCellScope,
  codexPetCoupledStandardRepairRows,
  repairRowsFromAtlasValidation,
  repairRowsFromDirectionContinuity,
  repairRowsFromFinalQa,
  summarizeProviderUsage,
  summarizeRequiredVisualJobProvenance,
} from "./codex-pet-runner/runner-provenance.js";
import {
  codexPetMaxBoardAttempts,
  ensureJob,
  putJsonArtifact,
  startJob,
} from "./codex-pet-runner/runner-jobs.js";
import {
  pauseForImageApproval,
  recordPerImageSettlementFailure,
  refundRun,
  settlePerImageBilling,
  settlePerImageBillingOnFailure,
  settlePerImageRunBilling,
} from "./codex-pet-runner/runner-billing.js";
import {
  checkCancelled,
  claimRunLease,
  currentRun,
  emit,
  resumeStageIfRepairing,
  stage,
} from "./codex-pet-runner/runner-lease.js";
import {
  asRecord,
  codexPetShouldMirrorRunningLeft,
  configuredArchiveMaxAttempts,
  configuredVisualConcurrency,
  customizedStandardActionStates,
  frozenPerImageCallPoints,
  imageFailureMetadata,
  imageInput,
  isCodexPetRecoverySnapshot,
  mapWithConcurrency,
  safeError,
  sameOrderedStrings,
  staleRunMs,
  standardActionSpecificationSummary,
} from "./codex-pet-runner/runner-util.js";
import {
  type BoardJobResult,
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetArchiveDeferredError,
  CodexPetCancelledError,
  type CodexPetExecutionResult,
  CodexPetGateFailureError,
  CodexPetImageApprovalRequiredError,
  CodexPetLeaseLostError,
  type CodexPetRunnerDeps,
  CodexPetStandardAtlasStructureError,
  type FinalRepairRow,
  INTERMEDIATE_TTL_MS,
  type RegisteredDirectionRowResult,
  type RunnerContext,
  type StandardRepairRow,
} from "./codex-pet-runner/runner-types.js";

// === 门面 re-export（拆分前这些符号定义在本文件，外部调用方继续从这里导入） ===
export {
  type PoseBoardSalvage,
  codexPetBoardInputRevision,
  codexPetJumpingTargetHeight,
  codexPetRepairGenerationReferences,
  codexPetShouldAttachFailedBoardForRepair,
  loadPoseBoardSalvage,
  poseBoardSalvageMetadata,
  poseBoardSalvageSlots,
  poseBoardSlotHealth,
  preferPoseBoardSalvage,
} from "./codex-pet-runner/runner-board-job.js";
export {
  assertCodexPetVisualQaProvenance,
  atlasValidationErrorsWithoutCellScope,
  codexPetCoupledStandardRepairRows,
  repairRowsFromAtlasValidation,
  repairRowsFromDirectionContinuity,
} from "./codex-pet-runner/runner-provenance.js";
export { codexPetMaxBoardAttempts } from "./codex-pet-runner/runner-jobs.js";
export { codexPetShouldMirrorRunningLeft } from "./codex-pet-runner/runner-util.js";
export {
  CODEX_PET_ACTIVE_STATUSES,
  CODEX_PET_IDLE_BOARD_PROMPT_VERSION,
  CODEX_PET_RESOURCE_KEY,
  type CodexPetArtifactPutInput,
  type CodexPetArtifactStore,
  type CodexPetEventInput,
  type CodexPetExecutionResult,
  type CodexPetExecutionStatus,
  CodexPetLeaseLostError,
  type CodexPetRunnerDeps,
  codexPetStandardRowPromptVersion,
} from "./codex-pet-runner/runner-types.js";


const WORKER_ID = `codex-pet-${process.pid}-${randomUUID().slice(0, 8)}`;
export { CODEX_PET_BOARD_PROMPT_VERSION } from "./codex-pet-board-version.js";


















































































/** Build a deterministic reference from the four QA-approved cardinal cells.
 * The original 2×2 model board remains provenance; direction generation uses
 * this extracted strip so labels/layout noise can never become part of the
 * visual reference. */
async function createApprovedCardinalAnchor(ctx: RunnerContext, cardinals: BoardJobResult, force = false): Promise<{ artifact: CodexPetArtifact; buffer: Buffer }> {
  const job = await ensureJob(ctx, "cardinal-anchor-strip", "deterministic_assembly", ["look-cardinals"], {
    directions: ["000", "090", "180", "270"],
    sourceBoardArtifactId: cardinals.boardArtifact.id,
  });
  const output = asRecord(job.output);
  if (!force && job.status === "completed" && typeof output.artifactId === "string") {
    const artifact = await ctx.prisma.codexPetArtifact.findFirst({
      where: {
        id: output.artifactId,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
    });
    if (artifact) return { artifact, buffer: await ctx.artifacts.load(artifact) };
  }
  const buffer = await composeCardinalAnchorStrip(cardinals.frames);
  const artifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "cardinal_anchor_strip",
    name: "已批准四方向锚点参考",
    buffer,
    mime: "image/png",
    metadata: {
      directions: ["000", "090", "180", "270"],
      sourceBoardArtifactId: cardinals.boardArtifact.id,
      sourceFrameArtifactIds: cardinals.frameArtifacts.map((item) => item.id),
      cardinalEvidence: cardinals.frameArtifacts.map((item, index) => ({
        direction: (["000", "090", "180", "270"] as const)[index],
        frameArtifactId: item.id,
        extractionDiagnostics: asRecord(item.metadata).diagnostics,
        semanticQa: {
          score: cardinals.qa.score,
          pass: cardinals.qa.pass,
          warnings: cardinals.qa.warnings,
          failures: cardinals.qa.failures,
        },
      })),
      approved: true,
      width: 384,
      height: 416,
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    inputArtifactIds: [cardinals.boardArtifact.id, ...cardinals.frameArtifacts.map((item) => item.id)],
    outputArtifactIds: [artifact.id],
    output: { artifactId: artifact.id, sourceBoardArtifactId: cardinals.boardArtifact.id } as Prisma.InputJsonValue,
    attempt: Math.max(1, job.attempt),
    completedAt: new Date(),
    workerId: null,
  } });
  await emit(ctx, "preview.ready", "direction_generating", 70, "四个批准方向锚点参考已生成", { artifactId: artifact.id }, job.key);
  return { artifact, buffer };
}




/**
 * GPT Image edits preserves only the first two direction references as
 * independent multipart images and compacts the remaining guidance into one
 * contact sheet. Direction edits keep a deterministic 4×2 direction scaffold
 * first as the primary edit target and canonical identity second. The complete
 * cardinal basis remains in supporting guidance. Standard motion, layout, the
 * registered first row and failed-board diagnostics are useful continuity
 * evidence, but none may outrank the cardinal semantics.
 */
function lookRowReferences(input: {
  readonly row: "look-a" | "look-b";
  readonly anchorStoryboard: Buffer;
  readonly directionArcGuide?: Buffer;
  readonly canonical: { readonly buffer: Buffer; readonly mime: string };
  readonly cardinalAnchor: { readonly buffer: Buffer; readonly mime: string };
  readonly standardContact: Buffer;
  readonly layout: Buffer;
  readonly registeredLookA?: Buffer;
  readonly diagnosticBoard?: Buffer;
}): readonly ImageBinaryInput[] {
  if (input.row === "look-b" && !input.directionArcGuide) {
    throw new Error("look-b requires the deterministic screen-left trajectory scaffold");
  }
  const authoritative = [
    imageInput(
      input.row === "look-b" ? input.directionArcGuide! : input.anchorStoryboard,
      "image/png",
      input.row === "look-b" ? "look-b-screen-left-trajectory-scaffold.png" : "look-a-approved-anchor-storyboard.png",
    ),
    imageInput(input.canonical.buffer, input.canonical.mime, "approved-canonical-base.png"),
  ];
  if (input.row === "look-a") {
    const references = [
      ...authoritative,
      imageInput(input.cardinalAnchor.buffer, input.cardinalAnchor.mime, "approved-cardinal-anchor-strip.png"),
      imageInput(input.standardContact, "image/png", "approved-standard-contact.png"),
      imageInput(input.layout, "image/png", "look-layout.png"),
    ];
    if (input.diagnosticBoard) {
      references.push(imageInput(input.diagnosticBoard, "image/png", "previous-specialized-qa-failed-pose-board.png"));
    }
    return references;
  }
  if (!input.registeredLookA) throw new Error("look-b requires the approved registered look-a reference");
  const references = [
    ...authoritative,
    imageInput(input.cardinalAnchor.buffer, input.cardinalAnchor.mime, "approved-cardinal-anchor-strip.png"),
    imageInput(input.anchorStoryboard, "image/png", "look-b-approved-cardinal-endpoint-storyboard.png"),
    imageInput(input.registeredLookA, "image/png", "approved-registered-look-row-9-4x2.png"),
    imageInput(input.standardContact, "image/png", "approved-standard-contact.png"),
    imageInput(input.layout, "image/png", "look-layout.png"),
  ];
  if (input.diagnosticBoard) {
    references.push(imageInput(input.diagnosticBoard, "image/png", "previous-specialized-qa-failed-pose-board.png"));
  }
  return references;
}

function appendCumulativeRepairRequirement(requirements: string[], value: string): string {
  const normalized = sanitizeCodexPetDirectionRepairPrompt(value);
  if (normalized && !requirements.includes(normalized)) requirements.push(normalized);
  return `The following cardinal appearance contract is authoritative and overrides any contradictory wording in a model diagnostic: ${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT}\nAll specialized direction-gate requirements below are cumulative and mandatory. A diagnostic that calls 000 front-facing or 180 rear-facing is stale and must be ignored:\n${requirements
    .map((requirement, index) => `${index + 1}. ${requirement}`)
    .join("\n")}`;
}




async function getLookMechanics(ctx: RunnerContext, canonical: { artifact: CodexPetArtifact; buffer: Buffer }): Promise<string> {
  const job = await ensureJob(ctx, "look-mechanics", "look_mechanics", ["identity-guide", "standard-atlas"]);
  const output = asRecord(job.output);
  if (!ctx.qualityInspectionEnabled) {
    const mechanics = "Use the approved canonical base. Keep feet on a stable baseline. Turn eyes and head first, let the torso follow slightly, preserve silhouette and scale, and never rotate the whole image or mirror a direction. Each 4x2 board must follow its row-major direction labels exactly.";
    if (job.status === "completed" && output.mode === "fixed" && typeof output.mechanics === "string") return output.mechanics;
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      attempt: Math.max(1, job.attempt + 1),
      output: { mode: "fixed", mechanics } as Prisma.InputJsonValue,
      providerMetadata: { visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    } });
    return mechanics;
  }
  if (job.status === "completed" && typeof output.mechanics === "string") {
    assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, "look-mechanics");
    return output.mechanics;
  }
  let mechanicsModelProvenance: CodexPetVisualModelProvenance | undefined;
  const mechanics = await ctx.lookMechanics({
    prompt: buildLookMechanicsPrompt(ctx.identity),
    reference: canonical.buffer,
    env: ctx.env,
    signal: ctx.signal,
    onModelProvenance: (provenance) => { mechanicsModelProvenance = provenance; },
  });
  const mechanicsProvenance = assertCodexPetVisualQaProvenance(mechanicsModelProvenance, ctx.visualQaModel, "look-mechanics");
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { mechanics, modelProvenance: mechanicsProvenance } as unknown as Prisma.InputJsonValue,
    providerMetadata: {
      visualQa: mechanicsProvenance,
    } as unknown as Prisma.InputJsonValue,
    completedAt: new Date(),
  } });
  return mechanics;
}

function recoveredRegistrationDiagnostics(
  validation: NeutralDirectionGeometryValidation,
): readonly DirectionRegistrationCellDiagnostics[] {
  return validation.frames.map((frame) => ({
    index: frame.index,
    sourceBounds: null,
    sourceGeometry: null,
    normalizedBounds: frame.geometry?.bounds ?? null,
    normalizedGeometry: frame.geometry,
    chromaCoverage: 0,
    edgePixels: frame.edgePixels,
    errors: frame.errors,
    warnings: [...frame.warnings, "recovered-from-registered-artifact"],
  }));
}

function registeredSourceBoardSize(output: Record<string, unknown>, manifest: NeutralDirectionRegistrationManifest): { width: number; height: number } {
  const source = asRecord(output.sourceBoardSize);
  return {
    width: typeof source.width === "number" && Number.isFinite(source.width) ? source.width : manifest.row9Source.width,
    height: typeof source.height === "number" && Number.isFinite(source.height) ? source.height : manifest.row9Source.height,
  };
}

async function completedRegisteredDirectionRow(
  ctx: RunnerContext,
  job: CodexPetJob,
  source: BoardJobResult,
  neutral: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer },
  expectedInputArtifactIds: readonly string[],
  lockedManifestArtifactId?: string,
): Promise<RegisteredDirectionRowResult | null> {
  if (job.status !== "completed" || !sameOrderedStrings(job.inputArtifactIds, expectedInputArtifactIds)) return null;
  const output = asRecord(job.output);
  if (output.sourceBoardArtifactId !== source.boardArtifact.id || output.neutralFrameArtifactId !== neutral.artifact.id
    || typeof output.registeredRowArtifactId !== "string" || typeof output.manifestArtifactId !== "string") return null;
  if (lockedManifestArtifactId && output.manifestArtifactId !== lockedManifestArtifactId) return null;
  const [registeredRowArtifact, manifestArtifact] = await Promise.all([
    ctx.prisma.codexPetArtifact.findFirst({ where: {
      id: output.registeredRowArtifactId,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: "ready",
    } }),
    ctx.prisma.codexPetArtifact.findFirst({ where: {
      id: output.manifestArtifactId,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: "ready",
    } }),
  ]);
  if (!registeredRowArtifact || !manifestArtifact) return null;
  try {
    const [registeredRow, manifestBytes] = await Promise.all([
      ctx.artifacts.load(registeredRowArtifact),
      ctx.artifacts.load(manifestArtifact),
    ]);
    const manifest = parseNeutralDirectionRegistrationManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    const frames = await splitRegisteredDirectionRow(registeredRow);
    const validation = await validateNeutralLockedDirectionFrames(neutral.buffer, frames, manifest.thresholds);
    if (!validation.ok) return null;
    return {
      registrationJob: job,
      source,
      frames,
      registeredRow,
      registeredRowArtifact,
      manifest,
      manifestArtifact,
      validation,
      diagnostics: recoveredRegistrationDiagnostics(validation),
      sourceBoardSize: registeredSourceBoardSize(output, manifest),
      ok: true,
      errors: [],
      warnings: validation.warnings,
    };
  } catch {
    // A missing/corrupt deterministic artifact is cache corruption, not a
    // reason to invoke the image provider. Rebuild it from the durable source
    // board below and preserve the provider attempt budget.
    return null;
  }
}

/**
 * Persist the exact direction cells that QA and final assembly consume.
 * Row 9 creates the immutable neutral registration manifest. Row 10 reuses it
 * verbatim and can never trigger a second fit of the already-approved row 9.
 */
async function registerDirectionRow(
  ctx: RunnerContext,
  input: {
    readonly row: "look-a" | "look-b";
    readonly source: BoardJobResult;
    readonly neutral: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly lockedRow9?: RegisteredDirectionRowResult;
    readonly progress: number;
  },
): Promise<RegisteredDirectionRowResult> {
  if (input.row === "look-b" && (!input.lockedRow9?.registeredRowArtifact || !input.lockedRow9.manifestArtifact)) {
    throw new Error("第二组观察方向缺少已批准的 row-9 注册产物");
  }
  const expectedInputArtifactIds = input.row === "look-a"
    ? [input.source.boardArtifact.id, input.neutral.artifact.id]
    : [
        input.source.boardArtifact.id,
        input.neutral.artifact.id,
        input.lockedRow9!.registeredRowArtifact!.id,
        input.lockedRow9!.manifestArtifact!.id,
      ];
  let job = await ensureJob(
    ctx,
    `${input.row}-registration`,
    "look_direction_registration",
    input.row === "look-a" ? ["look-a", "row-idle"] : ["look-b", "look-a-registration"],
    { row: input.row, schemaVersion: "codex-pet-neutral-direction-registration-v1" },
  );
  const cached = await completedRegisteredDirectionRow(
    ctx,
    job,
    input.source,
    input.neutral,
    expectedInputArtifactIds,
    input.lockedRow9?.manifestArtifact?.id,
  );
  if (cached) return cached;

  await checkCancelled(ctx);
  const obsoleteArtifactIds = [...job.outputArtifactIds];
  if (obsoleteArtifactIds.length > 0) {
    await ctx.prisma.codexPetArtifact.updateMany({
      where: {
        id: { in: obsoleteArtifactIds },
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
      data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
    });
  }
  job = await startJob(
    ctx,
    job,
    Math.max(1, input.source.job.attempt),
    input.progress,
    input.row === "look-a" ? "按已批准 idle 中立帧注册第一组观察方向" : "复用 row-9 固定变换注册第二组观察方向",
  );
  const result = input.row === "look-a"
    ? await registerFirstDirectionRowToNeutral(input.source.board, input.neutral.buffer, {
        chromaKey: ctx.identity.chromaKey,
        frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
      })
    : await registerSecondDirectionRowWithManifest(
        input.source.board,
        input.neutral.buffer,
        input.lockedRow9!.manifest,
        { chromaKey: ctx.identity.chromaKey, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT },
      );
  const reportArtifact = await putJsonArtifact(ctx, {
    jobId: job.id,
    kind: "direction_registration_report",
    name: `${input.row === "look-a" ? "row 9" : "row 10"} 中立帧锁定注册报告 · 第 ${input.source.job.attempt} 次`,
    value: {
      schemaVersion: result.manifest.schemaVersion,
      sourceBoardArtifactId: input.source.boardArtifact.id,
      neutralFrameArtifactId: input.neutral.artifact.id,
      sourceBoardSize: result.sourceBoardSize,
      transform: result.manifest.transform,
      validation: result.validation,
      diagnostics: result.diagnostics,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  if (!result.ok) {
    const rejected = await ctx.prisma.codexPetJob.updateMany({
      where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId },
      data: {
        status: "queued",
        inputArtifactIds: [...expectedInputArtifactIds],
        outputArtifactIds: [reportArtifact.id],
        output: {
          sourceBoardArtifactId: input.source.boardArtifact.id,
          neutralFrameArtifactId: input.neutral.artifact.id,
          reportArtifactId: reportArtifact.id,
          sourceBoardSize: result.sourceBoardSize,
          ok: false,
          errors: result.errors,
        } as Prisma.InputJsonValue,
        error: result.errors.join("；") || "中立帧锁定注册未通过",
        workerId: null,
        completedAt: null,
      },
    });
    if (rejected.count !== 1) throw new CodexPetLeaseLostError();
    return {
      registrationJob: job,
      source: input.source,
      frames: result.frames,
      registeredRow: result.registeredRow,
      registeredRowArtifact: null,
      manifest: result.manifest,
      manifestArtifact: input.lockedRow9?.manifestArtifact ?? null,
      validation: result.validation,
      diagnostics: result.diagnostics,
      sourceBoardSize: result.sourceBoardSize,
      ok: false,
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  const manifestArtifact = input.row === "look-a"
    ? await putJsonArtifact(ctx, {
        jobId: job.id,
        kind: "direction_registration_manifest",
        name: "row 9 中立帧锁定注册 Manifest",
        value: result.manifest,
        expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
      })
    : input.lockedRow9!.manifestArtifact!;
  const registeredRowArtifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "registered_direction_row",
    name: input.row === "look-a" ? "已批准注册 row 9 · 000–157.5" : "固定 row-9 变换注册 row 10 · 180–337.5",
    buffer: result.registeredRow,
    mime: "image/png",
    width: 1536,
    height: 208,
    metadata: {
      row: input.row === "look-a" ? 9 : 10,
      sourceBoardArtifactId: input.source.boardArtifact.id,
      neutralFrameArtifactId: input.neutral.artifact.id,
      manifestArtifactId: manifestArtifact.id,
      schemaVersion: result.manifest.schemaVersion,
      lockedScale: result.manifest.transform.scale,
      target: result.manifest.transform.target,
      validation: {
        medianHeightRatio: result.validation.medianHeightRatio,
        medianWidthRatio: result.validation.medianWidthRatio,
      },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const outputArtifactIds = input.row === "look-a"
    ? [registeredRowArtifact.id, manifestArtifact.id, reportArtifact.id]
    : [registeredRowArtifact.id, reportArtifact.id];
  const completed = await ctx.prisma.codexPetJob.updateMany({
    where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId },
    data: {
      status: "completed",
      inputArtifactIds: [...expectedInputArtifactIds],
      outputArtifactIds,
      output: {
        sourceBoardArtifactId: input.source.boardArtifact.id,
        neutralFrameArtifactId: input.neutral.artifact.id,
        registeredRowArtifactId: registeredRowArtifact.id,
        manifestArtifactId: manifestArtifact.id,
        reportArtifactId: reportArtifact.id,
        sourceBoardSize: result.sourceBoardSize,
        ok: true,
      } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    },
  });
  if (completed.count !== 1) throw new CodexPetLeaseLostError();
  await emit(ctx, "preview.ready", "direction_generating", input.progress,
    input.row === "look-a" ? "第一组观察方向已按中立帧完成固定注册" : "第二组观察方向已复用 row-9 固定注册",
    {
      artifactId: registeredRowArtifact.id,
      manifestArtifactId: manifestArtifact.id,
      lockedScale: result.manifest.transform.scale,
      medianHeightRatio: result.validation.medianHeightRatio,
    }, job.key);
  return {
    registrationJob: { ...job, status: "completed", workerId: null, outputArtifactIds },
    source: input.source,
    frames: result.frames,
    registeredRow: result.registeredRow,
    registeredRowArtifact,
    manifest: result.manifest,
    manifestArtifact,
    validation: result.validation,
    diagnostics: result.diagnostics,
    sourceBoardSize: result.sourceBoardSize,
    ok: true,
    errors: [],
    warnings: result.warnings,
  };
}

function requireApprovedRegisteredRow(result: RegisteredDirectionRowResult, label: string): asserts result is RegisteredDirectionRowResult & {
  readonly registeredRowArtifact: CodexPetArtifact;
  readonly manifestArtifact: CodexPetArtifact;
} {
  if (!result.ok || !result.registeredRowArtifact || !result.manifestArtifact) {
    throw new Error(`${label} 未形成可恢复的注册产物`);
  }
}

async function reviewFirstLookRow(
  ctx: RunnerContext,
  input: {
    readonly look: RegisteredDirectionRowResult;
    readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly standardContact: Buffer;
    readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  },
) {
  const directions = LOOK_DIRECTIONS.slice(0, 8);
  const continuity = await measureDirectionRowContinuity(input.look.frames, directions);
  if (!input.look.ok || !continuity.ok) {
    const failures = [...input.look.errors, ...continuity.errors];
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 000–157.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
      value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, failures },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return {
      pass: false,
      continuity,
      visual: null,
      failures,
      repairPrompt: failures.join("; ") || "repair direction scale, lower-body anchor, baseline, edge clearance or structural cells",
    };
  }
  if (!ctx.qualityInspectionEnabled) {
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 000–157.5 本地注册与连续性检查 · 第 ${input.look.source.job.attempt} 次`,
      value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return { pass: true, continuity, visual: null, failures: [], repairPrompt: "" };
  }
  const preview = await createAnimatedWebpPreview(input.look.frames, petRowSpec("look-a").durations);
  const qa = await ctx.qaConsensus({
    images: [
      { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
      { buffer: input.standardContact, mime: "image/png" },
      { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
      // Keep the complete registered row as a static, inspectable artifact in
      // addition to the animated preview. Some multimodal reviewers inspect
      // only the first animation frame and otherwise cannot verify all eight
      // direction cells or a local reversal.
      { buffer: input.look.registeredRow, mime: "image/png" },
      { buffer: preview.image, mime: preview.mime },
    ],
    prompt: buildVisualQaPrompt(
      "directions",
      `Pre-row-10 gate for the registered row-9 sequence 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5. `
      + `Confirm 000 unmistakably up, 090 unmistakably screen-right, every intermediate stays in its labeled quadrant, and the animated sequence advances clockwise without reversal, registration snap, scale pop or identity drift. `
      + `Image 3 is the authoritative 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. Row-9 cell 1 must match Image 3 top-left's visible front/back appearance, cell 5 must match its top-right, and cell 8 must visibly approach its bottom-left without entering the opposite side. `
      + `Image 4 is the complete static eight-frame registered row in chronological left-to-right order; inspect every cell. Image 5 is its animation preview. `
      + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
      ctx.identity.canonicalGuide,
    ),
    env: ctx.env,
    signal: ctx.signal,
    repetitions: 1,
  });
  assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row9-pre-generation-gate");
  await putJsonArtifact(ctx, {
    jobId: input.look.registrationJob.id,
    kind: "qa_report",
    name: `方向 000–157.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
    value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, visual: qa },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const passed = codexPetVisualQaConsensusPasses(qa);
  return {
    pass: passed,
    continuity,
    visual: qa,
    failures: qa.failures,
    repairPrompt: qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt
      || qa.failures.join("; ")
      || "strengthen labeled direction semantics and adjacent continuity for the complete row",
  };
}

/**
 * Independent row-10 (180–337.5°) gate.  Row 10 is checked before final
 * assembly, rather than relying solely on the full-atlas blind test.  The
 * previous row is supplied to the multimodal reviewer to expose both seam
 * continuity (157.5→180 and 337.5→000) and registration/scale changes.
 */
async function reviewSecondLookRow(
  ctx: RunnerContext,
  input: {
    readonly look: RegisteredDirectionRowResult;
    readonly previousLook: RegisteredDirectionRowResult;
    readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly standardContact: Buffer;
    readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  },
) {
  const directions = LOOK_DIRECTIONS.slice(8);
  const continuity = await measureDirectionRowContinuity(input.look.frames, directions);
  const preview = await createAnimatedWebpPreview(input.look.frames, petRowSpec("look-b").durations);
  let qa: PetVisualQaConsensus = {
    pass: false,
    verdicts: [],
    score: 0,
    mirrorSafe: false,
    warnings: [],
    failures: [],
  };
  if (!ctx.qualityInspectionEnabled && input.look.ok && continuity.ok) {
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 180–337.5 本地注册与连续性检查 · 第 ${input.look.source.job.attempt} 次`,
      value: { row: 10, directions, neutralRegistration: input.look.validation, deterministicContinuity: continuity, visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return { pass: true, continuity, visual: null, failures: [], repairPrompt: "" };
  }
  if (input.look.ok && continuity.ok) {
    qa = await ctx.qaConsensus({
      images: [
        { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
        { buffer: input.standardContact, mime: "image/png" },
        { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
        { buffer: input.previousLook.registeredRow, mime: "image/png" },
        { buffer: input.look.registeredRow, mime: "image/png" },
        { buffer: preview.image, mime: preview.mime },
      ],
      prompt: buildVisualQaPrompt(
        "directions",
        `Independent pre-row-10 gate for registered directions 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5. `
        + `Confirm 180 unmistakably down, 270 unmistakably screen-left, every intermediate remains in its labeled quadrant, and the animated row advances clockwise without reversal, registration snap, scale pop or identity drift. `
        + `Image 3 is the authoritative 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. Image 4 is approved row 9; Image 5 is the complete static row 10 in chronological left-to-right order; Image 6 is its animation preview. Row-10 cell 1 must match Image 3 bottom-left and cell 5 must match Image 3 bottom-right. `
        + `Compare the preceding 157.5 frame from row 9 and the 000 anchor for both row-boundary seams. `
        + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
        ctx.identity.canonicalGuide,
      ),
      env: ctx.env,
      signal: ctx.signal,
      repetitions: 1,
    });
    assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row10-pre-generation-gate");
  }
  const failures = [...input.look.errors, ...continuity.errors, ...qa.failures];
  const repairPrompt = qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt
    || failures.join("; ")
    || "strengthen the complete 180–337.5 direction row and both row-boundary seams";
  await putJsonArtifact(ctx, {
    jobId: input.look.registrationJob.id,
    kind: "qa_report",
    name: `方向 180–337.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
    value: {
      row: 10,
      directions,
      neutralRegistration: input.look.validation,
      deterministicContinuity: continuity,
      visual: qa,
      animationPreview: { frameCount: preview.frameCount, durations: preview.durations },
      previousRowArtifactId: input.previousLook.registeredRowArtifact?.id ?? null,
      cardinalAnchorArtifactId: input.cardinalAnchor.artifact.id,
      row10PreGenerationGate: { passed: input.look.ok && continuity.ok && codexPetVisualQaConsensusPasses(qa), failures },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  return {
    pass: input.look.ok && continuity.ok && codexPetVisualQaConsensusPasses(qa),
    continuity,
    visual: qa,
    failures,
    repairPrompt,
  };
}











/**
 * Reference loading happens immediately after a lease claim, before the main
 * execution context/monitor is constructed.  If an object was deleted or
 * ownership changed in that small window, release the lease through the same
 * terminal/refund policy as a normal runner failure; otherwise a Bull failure
 * would leave the run permanently active with no worker to recover it.
 */
async function finalizeClaimedSetupFailure(input: {
  readonly prisma: PrismaClient;
  readonly appendEvent: CodexPetRunnerDeps["appendEvent"];
  readonly billing: CodexPetRunnerDeps["billing"];
  readonly project: CodexPetProject;
  readonly runId: string;
  readonly workerId: string;
  readonly error: unknown;
}): Promise<void> {
  const message = safeError(input.error);
  const now = new Date();
  const outcome = await input.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId } });
    if (!current || current.status === "ready" || current.status === "failed" || current.status === "cancelled" || current.workerId !== input.workerId || current.cancelRequested) {
      return { transitioned: false, refundPending: false, run: current };
    }
    const refundPending = current.billingChargeStatus === "charged"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
    const changed = await tx.codexPetRun.updateMany({
      where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, workerId: input.workerId, status: { in: [...CODEX_PET_ACTIVE_STATUSES] } },
      data: {
        status: "failed",
        progressStage: "failed",
        progressMessage: message,
        error: message,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: input.project.id, userId: input.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    return { transitioned: true, refundPending, run: current };
  });
  if (!outcome.transitioned) return;
  await input.appendEvent({ prisma: input.prisma, runId: input.runId, type: "run.failed", stage: "failed", progress: outcome.run?.progressPercent ?? 0, message, payload: { retryable: false } }).catch(() => undefined);
  if (outcome.run?.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
    try {
      // Same rule as settlePerImageBillingOnFailure: only a failure that spent
      // nothing may settle here, because settling closes every resume path.
      const sentPlannedCalls = await input.prisma.codexPetImageCall.count({
        where: {
          runId: input.runId,
          projectId: input.project.id,
          userId: input.project.userId,
          callKind: "planned",
          sentAt: { not: null },
        },
      });
      if (sentPlannedCalls > 0) return;
      await settlePerImageRunBilling({
        prisma: input.prisma,
        billing: input.billing,
        runId: input.runId,
        projectId: input.project.id,
        userId: input.project.userId,
      });
    } catch (billingError) {
      await input.prisma.codexPetRun.updateMany({
        where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: { not: "settled" } },
        data: { billingSettlementStatus: "settle_failed", billingChargeError: safeError(billingError) },
      }).catch(() => undefined);
    }
    return;
  }
  if (!outcome.refundPending || !outcome.run?.billingOperationId) return;
  const attemptedAt = new Date();
  try {
    const result = await input.billing.refundResource(outcome.run.billingOperationId);
    if (!result.success) throw new Error("billing refund was not accepted");
    await input.prisma.codexPetRun.updateMany({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingRefundedAt: null }, data: { billingRefundedAt: attemptedAt, billingRefundStatus: "refunded", billingRefundError: null, billingRefundLastAttemptAt: attemptedAt, billingRefundRetryCount: { increment: 1 }, billingRefundNextRetryAt: null } });
    await input.appendEvent({ prisma: input.prisma, runId: input.runId, type: "billing.refunded", stage: "failed", progress: outcome.run.progressPercent, message: "套餐积分已全额退回", payload: { reason: "setup_failure" } }).catch(() => undefined);
  } catch (error) {
    await input.prisma.codexPetRun.updateMany({ where: { id: input.runId, projectId: input.project.id, userId: input.project.userId, billingRefundedAt: null }, data: { billingRefundStatus: "pending", billingRefundError: safeError(error), billingRefundLastAttemptAt: attemptedAt, billingRefundRetryCount: { increment: 1 }, billingRefundNextRetryAt: new Date(Date.now() + 30_000) } }).catch(() => undefined);
  }
}

async function finalizeFailure(ctx: RunnerContext, error: unknown): Promise<void> {
  const message = safeError(error);
  const now = new Date();
  const gateFailure = error instanceof CodexPetGateFailureError && error.rows.length > 0 ? error : null;
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "ready" || current.status === "failed" || current.status === "cancelled") {
      return { transitioned: false, refundPending: false, run: current };
    }
    if (current.cancelRequested) return { transitioned: false, refundPending: false, run: current };
    // A stale worker may still be unwinding an upstream request after a new
    // worker has claimed the lease. It must never overwrite that worker's
    // progress (especially a committed ready state).
    if (current.workerId !== ctx.workerId) return { transitioned: false, refundPending: false, run: current };
    const refundPending = current.billingChargeStatus === "charged"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
    const changed = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: { in: [...CODEX_PET_ACTIVE_STATUSES] } },
      data: {
        status: "failed",
        progressStage: "failed",
        progressMessage: message,
        error: message,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        // A gate that named its rows leaves behind actionable work: persist that
        // scope so 失败续跑 can redo exactly those action groups. Without it the
        // rows are all `completed` at the current prompt version and admission
        // has nothing to reset, which made this failure shape non-continuable.
        ...(gateFailure
          ? {
            inputSnapshot: {
              ...asRecord(current.inputSnapshot),
              gateFailure: codexPetGateFailureSnapshotValue({
                gate: gateFailure.gate,
                rows: gateFailure.rows,
                failures: gateFailure.failures,
                recordedAt: now,
              }),
            } as Prisma.InputJsonObject,
          }
          : {}),
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "failed" } });
    const unfinishedJobs: Prisma.CodexPetJobWhereInput = {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: { in: ["queued", "running"] },
    };
    await tx.codexPetJob.updateMany({
      where: {
        ...unfinishedJobs,
        error: null,
      },
      data: {
        error: "同一运行中的其他任务失败，当前任务已停止",
      },
    });
    await tx.codexPetJob.updateMany({
      where: unfinishedJobs,
      data: {
        status: "cancelled",
        completedAt: now,
        workerId: null,
      },
    });
    return { transitioned: true, refundPending, run: { ...current, status: "failed", progressStage: "failed", progressMessage: message, progressPercent: current.progressPercent } };
  });
  if (!outcome.transitioned) {
    if (outcome.run?.cancelRequested) await finalizeCancellation(ctx);
    return;
  }
  const failure = imageFailureMetadata(error);
  await emit(ctx, "run.failed", "failed", outcome.run?.progressPercent ?? 0, message, {
    retryable: false,
    errorCategory: failure.category,
    ...(gateFailure ? { gate: gateFailure.gate, repairRows: [...gateFailure.rows] } : {}),
    ...(failure.transportCode ? { transportCode: failure.transportCode } : {}),
    ...(failure.upstreamRequestId ? { upstreamRequestId: failure.upstreamRequestId } : {}),
  }).catch(() => undefined);
  if (ctx.perImageBilling) {
    try {
      const settlementOutcome = await settlePerImageBillingOnFailure(ctx);
      if (settlementOutcome === "deferred") {
        await emit(ctx, "billing.settlement_deferred", "failed", outcome.run?.progressPercent ?? 0,
          "本次失败未结清调用额度，已付费素材仍可在续跑窗口期内复用", {
            reason: "failure_is_resumable",
          }).catch(() => undefined);
      }
    } catch (billingError) {
      await recordPerImageSettlementFailure(ctx, billingError);
    }
    return;
  }
  if (outcome.refundPending) await refundRun(ctx, "system_failure");
}

async function finalizeCancellation(ctx: RunnerContext): Promise<void> {
  const now = new Date();
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const current = await tx.codexPetRun.findFirst({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } });
    if (!current || current.status === "cancelled" || current.status === "ready" || current.status === "failed") {
      return { transitioned: false, refundPending: false, run: current };
    }
    // Permit an unclaimed run (the API can set cancelRequested before Bull
    // starts), but never let a stale worker cancel a newer worker's lease.
    if (current.workerId !== null && current.workerId !== ctx.workerId) return { transitioned: false, refundPending: false, run: current };
    const refundPending = current.billingChargeStatus === "charged"
      && !current.hasSuccessfulImage
      && current.status !== "awaiting_base_review"
      && Boolean(current.billingOperationId)
      && !current.billingRefundedAt
      && current.billingRefundStatus !== "refunded";
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        OR: [{ workerId: ctx.workerId }, { workerId: null }],
      },
      data: {
        status: "cancelled",
        progressStage: "cancelled",
        progressMessage: "用户已取消",
        error: null,
        completedAt: now,
        heartbeatAt: now,
        workerId: null,
        cancelRequested: true,
        ...(refundPending ? { billingRefundStatus: "pending", billingRefundError: null, billingRefundNextRetryAt: now } : {}),
      },
    });
    if (changed.count !== 1) return { transitioned: false, refundPending: false, run: current };
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "cancelled" } });
    await tx.codexPetJob.updateMany({ where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, status: { in: ["queued", "running"] } }, data: { status: "cancelled", error: "用户已取消", completedAt: now, workerId: null } });
    return { transitioned: true, refundPending, run: { ...current, status: "cancelled", progressPercent: current.progressPercent } };
  });
  // The API can cancel an unclaimed queued run while its Bull job is still in
  // flight. Only the process that wins the state transition owns the terminal
  // event/refund, preventing a later queue delivery from duplicating either.
  if (!outcome.transitioned) return;
  await emit(ctx, "run.cancelled", "cancelled", outcome.run?.progressPercent ?? 0, "桌宠制作已取消", { hasSuccessfulImage: outcome.run?.hasSuccessfulImage ?? false }).catch(() => undefined);
  if (ctx.perImageBilling) {
    try {
      await settlePerImageBilling(ctx, false);
    } catch (billingError) {
      await recordPerImageSettlementFailure(ctx, billingError);
    }
    return;
  }
  if (outcome.refundPending) await refundRun(ctx, "cancelled_before_first_image");
}

const TERMINAL_ARCHIVE_ERROR_CODES = new Set([
  "run_not_found",
  "invalid_stage",
  "archive_deleted",
  "package_incomplete",
  "validation_failed",
  "source_conflict",
]);

function terminalArchiveError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === "string" && TERMINAL_ARCHIVE_ERROR_CODES.has(code);
}

function archiveErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Serialize every knowledge-archive Job transition with the owning Run row.
 *
 * A Job-level workerId alone is not a lease: after a stale-run takeover the
 * old process can still finish an in-flight database call. Locking and
 * checking the Run in the same transaction prevents that process from
 * changing the Job after a newer worker owns the Run.
 */
async function withCurrentKnowledgeArchiveLease<T>(
  ctx: RunnerContext,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return ctx.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ readonly id: string }>>`
      SELECT "id"
      FROM "CodexPetRun"
      WHERE "id" = ${ctx.runId}
        AND "projectId" = ${ctx.project.id}
        AND "userId" = ${ctx.project.userId}
        AND "workerId" = ${ctx.workerId}
        AND "status" = 'archiving'
        AND "cancelRequested" = false
      FOR UPDATE
    `;
    if (locked.length !== 1) throw new CodexPetLeaseLostError();
    return operation(tx);
  });
}

async function transitionKnowledgeArchiveJob(
  ctx: RunnerContext,
  job: CodexPetJob,
  data: Prisma.CodexPetJobUpdateManyMutationInput,
): Promise<CodexPetJob> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const changed = await tx.codexPetJob.updateMany({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: job.status,
        workerId: job.workerId,
      },
      data,
    });
    if (changed.count !== 1) throw new CodexPetLeaseLostError();
    const updated = await tx.codexPetJob.findFirst({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
    });
    if (!updated) throw new CodexPetLeaseLostError();
    return updated;
  });
}

async function ensureKnowledgeArchiveJob(
  ctx: RunnerContext,
  maxAttempts: number,
): Promise<CodexPetJob> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const job = await tx.codexPetJob.upsert({
      where: { runId_key: { runId: ctx.runId, key: "knowledge-archive" } },
      create: {
        projectId: ctx.project.id,
        runId: ctx.runId,
        userId: ctx.project.userId,
        key: "knowledge-archive",
        kind: "knowledge_archive",
        dependencyKeys: ["standard-atlas", "look-a", "look-b"],
        maxAttempts,
      },
      update: { maxAttempts },
    });
    if (job.runId !== ctx.runId
      || job.projectId !== ctx.project.id
      || job.userId !== ctx.project.userId) {
      throw new Error("Codex pet knowledge archive job ownership mismatch");
    }
    return job;
  });
}

/**
 * `archiveCodexPetRun` commits the Document and Run link atomically, but the
 * process can die before it checkpoints the Job. In that case the ownership-
 * scoped Run link is the durable result. Reconcile the Job without consuming
 * another attempt or calling the archive routine again.
 */
async function reconcileKnowledgeArchiveJob(
  ctx: RunnerContext,
  job: CodexPetJob,
): Promise<string | null> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const run = await tx.codexPetRun.findFirst({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "archiving",
        cancelRequested: false,
      },
      select: { knowledgeDocumentId: true },
    });
    if (!run) throw new CodexPetLeaseLostError();
    if (!run.knowledgeDocumentId) return null;

    const document = await tx.document.findFirst({
      where: {
        id: run.knowledgeDocumentId,
        sourceModule: "codex_pet",
        sourceId: ctx.runId,
        kb: {
          ownerType: "USER",
          userId: ctx.project.userId,
          systemKey: "AI_ARTIFACTS",
        },
      },
      select: { id: true },
    });
    if (!document) return null;

    const previous = asRecord(job.output);
    if (job.status === "completed"
      && job.workerId === null
      && previous.documentId === document.id) {
      return document.id;
    }
    const changed = await tx.codexPetJob.updateMany({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: job.status,
        workerId: job.workerId,
      },
      data: {
        status: "completed",
        output: { documentId: document.id } as Prisma.InputJsonValue,
        completedAt: new Date(),
        workerId: null,
        error: null,
      },
    });
    if (changed.count !== 1) throw new CodexPetLeaseLostError();
    return document.id;
  });
}

/**
 * Knowledge archival is a durable job rather than an in-process retry loop.
 * Transient database/indexing-control-plane failures leave the run at 98% in
 * `archiving`; the worker releases its lease and the stale-run scanner queues
 * another attempt. Permanent contract failures, or exhaustion of the bounded
 * deployment-configured attempts, still follow the normal full-refund path.
 */
async function runKnowledgeArchiveAttempt(ctx: RunnerContext): Promise<string> {
  const maxAttempts = configuredArchiveMaxAttempts(ctx.env);
  let job = await ensureKnowledgeArchiveJob(ctx, maxAttempts);

  const reconciledDocumentId = await reconcileKnowledgeArchiveJob(ctx, job);
  if (reconciledDocumentId) return reconciledDocumentId;

  const previous = asRecord(job.output);
  if (job.status === "completed") {
    throw new Error(typeof previous.documentId === "string" && previous.documentId
      ? "知识库归档 checkpoint 与运行关联不一致"
      : "知识库归档 checkpoint 缺少文档 ID");
  }
  if (job.status === "failed" || job.status === "cancelled") {
    throw new Error(job.error || "AI 产物知识库归档任务已终止");
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new Error(`无法从 ${job.status} 状态恢复知识库归档任务`);
  }

  // A process crash can leave a running Job behind while the Run lease is
  // later reclaimed. Resume that exact attempt; only a durably queued retry
  // consumes the next bounded attempt.
  const recoveringRunningAttempt = job.status === "running";
  const attempt = recoveringRunningAttempt ? Math.max(1, job.attempt) : job.attempt + 1;
  if (attempt > job.maxAttempts) throw new Error("AI 产物知识库归档重试次数已耗尽");
  job = await transitionKnowledgeArchiveJob(ctx, job, {
    status: "running",
    attempt,
    workerId: ctx.workerId,
    startedAt: recoveringRunningAttempt ? job.startedAt ?? new Date() : new Date(),
    completedAt: null,
    error: null,
  });
  if (attempt === 1 && !recoveringRunningAttempt) {
    await emit(ctx, "knowledge.archive_started", "archiving", 98, "开始写入 AI 产物知识库", {
      attempt,
      maxAttempts: job.maxAttempts,
    }, job.key).catch(() => undefined);
  }
  try {
    const documentId = (await ctx.archiveRun({
      prisma: ctx.prisma,
      runId: ctx.runId,
      userId: ctx.project.userId,
      projectId: ctx.project.id,
      workerId: ctx.workerId,
    })).documentId;
    if (!documentId) throw new Error("知识库归档未返回文档 ID");
    job = await transitionKnowledgeArchiveJob(ctx, job, {
      status: "completed",
      output: { documentId } as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
      error: null,
    });
    await emit(ctx, "knowledge.archive_completed", "archiving", 98, "已归档到 AI 产物知识库", {
      knowledgeDocumentId: documentId,
      attempt,
    }, job.key).catch(() => undefined);
    return documentId;
  } catch (error) {
    if (error instanceof CodexPetLeaseLostError || archiveErrorCode(error) === "lease_lost") {
      throw new CodexPetLeaseLostError();
    }
    if (archiveErrorCode(error) === "cancelled") throw new CodexPetCancelledError();
    const terminal = terminalArchiveError(error) || attempt >= job.maxAttempts;
    job = await transitionKnowledgeArchiveJob(ctx, job, {
      status: terminal ? "failed" : "queued",
      workerId: null,
      error: safeError(error),
      completedAt: terminal ? new Date() : null,
    });
    await emit(ctx, "knowledge.archive_retrying", "archiving", 98, terminal
      ? "AI 产物知识库归档最终失败"
      : "知识库归档暂时失败，等待 Worker 重试", {
      attempt,
      maxAttempts: job.maxAttempts,
      terminal,
      error: safeError(error),
    }, job.key).catch(() => undefined);
    if (terminal) throw error;
    throw new CodexPetArchiveDeferredError(safeError(error), attempt, job.maxAttempts);
  }
}

async function completeKnowledgeArchive(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  const documentId = await runKnowledgeArchiveAttempt(ctx);
  await settlePerImageBilling(ctx);
  const now = new Date();
  const readyCommitted = await ctx.prisma.$transaction(async (tx) => {
    // Document deletion uses FK SetNull. Require the exact archive link and
    // archiving stage in the same conditional transition so a concurrent
    // knowledge-base deletion can never produce ready + null document.
    const transition = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: "archiving", knowledgeDocumentId: documentId, cancelRequested: false },
      data: { status: "ready", progressStage: "ready", progressPercent: 100, progressMessage: "桌宠已完成，可安装到 Codex", completedAt: now, heartbeatAt: now, workerId: null, error: null },
    });
    if (transition.count !== 1) return false;
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "ready" } });
    return true;
  });
  if (!readyCommitted) throw new Error("知识库归档关联已变化，桌宠不能进入 ready");
  // ready + knowledgeDocumentId is the authoritative committed outcome. A
  // final SSE/event write failure must never downgrade a deliverable run to
  // failed or trigger a package refund.
  await emit(ctx, "run.completed", "ready", 100, "桌宠已完成并归档", {
    knowledgeDocumentId: documentId,
  }).catch(() => undefined);
  return { status: "ready", runId: ctx.runId };
}

async function releaseDeferredArchiveLease(ctx: RunnerContext, error: CodexPetArchiveDeferredError): Promise<boolean> {
  const released = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: "archiving",
      cancelRequested: false,
    },
    data: {
      progressStage: "archiving",
      progressPercent: 98,
      progressMessage: `知识库归档暂时失败，等待重试（${error.attempt}/${error.maxAttempts}）`,
      error: error.message,
      workerId: null,
      heartbeatAt: null,
    },
  });
  return released.count === 1;
}

async function releaseDeferredPackagingLease(ctx: RunnerContext, error: CodexPetPackagingDeferredError): Promise<boolean> {
  const released = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: "packaging",
      cancelRequested: false,
    },
    data: {
      progressStage: "packaging",
      progressPercent: 94,
      progressMessage: `最终打包暂时失败，等待重试（${error.attempt}/${error.maxAttempts}）`,
      error: error.message,
      workerId: null,
      heartbeatAt: null,
    },
  });
  return released.count === 1;
}

async function deferRecoveryPackaging(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  const released = await ctx.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "packaging",
        billingChargeStatus: "not_required",
        billingPoints: 0,
        cancelRequested: false,
      },
      data: {
        progressStage: "packaging",
        progressPercent: 94,
        progressMessage: "恢复运行正在等待最终打包 checkpoint",
        error: null,
        workerId: null,
        heartbeatAt: null,
      },
    });
    if (changed.count !== 1) return false;
    await tx.codexPetProject.updateMany({
      where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
      data: { status: "packaging" },
    });
    return true;
  });
  if (!released) throw new CodexPetLeaseLostError();
  return { status: "packaging", runId: ctx.runId };
}

async function continueAfterDurablePackaging(
  ctx: RunnerContext,
  packaged: CodexPetDurablePackagingResult,
): Promise<CodexPetExecutionResult> {
  // The Job, all final artifact ids, validation report and archiving stage are
  // already committed atomically. Realtime events are a best-effort view of
  // that database truth and must never downgrade or refund a valid package.
  await emit(ctx, "package.ready", "packaging", 98, "Codex v2 安装包已生成", {
    spritesheetArtifactId: packaged.spritesheetArtifactId,
    packageArtifactId: packaged.packageArtifactId,
    previewArtifactId: packaged.previewArtifactId,
    recovered: packaged.recovered,
  }, "final-package").catch(() => undefined);
  await emit(ctx, "stage.started", "archiving", 98, "正在归档到 AI 产物知识库", {
    finalPackageJobId: packaged.jobId,
  }, "final-package").catch(() => undefined);
  return completeKnowledgeArchive(ctx);
}

async function resumeDurablePackaging(ctx: RunnerContext): Promise<CodexPetExecutionResult | null> {
  const provider = await summarizeProviderUsage(ctx);
  const packaged = await persistOrResumeCodexPetFinalPackage({
    prisma: ctx.prisma,
    artifacts: ctx.artifacts,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    displayName: ctx.identity.name,
    description: ctx.identity.description,
    chromaKey: ctx.identity.chromaKey,
    provider,
  });
  return packaged ? continueAfterDurablePackaging(ctx, packaged) : null;
}

async function executeRun(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  let run = await currentRun(ctx);
  if (run.status === "ready") return { status: "ready", runId: ctx.runId };
  if (run.status === "failed") return { status: "failed", runId: ctx.runId };
  if (run.status === "cancelled" || run.cancelRequested) throw new CodexPetCancelledError();
  if (run.status === "archiving") return completeKnowledgeArchive(ctx);
  if (run.status === "packaging") {
    const recoveryRun = isCodexPetRecoverySnapshot(run.inputSnapshot);
    if (recoveryRun) {
      const finalPackageJob = await ctx.prisma.codexPetJob.findUnique({
        where: { runId_key: { runId: ctx.runId, key: "final-package" } },
        select: { id: true },
      });
      if (!finalPackageJob) return deferRecoveryPackaging(ctx);
      const resumed = await resumeDurablePackaging(ctx);
      return resumed ?? deferRecoveryPackaging(ctx);
    }
    const resumed = await resumeDurablePackaging(ctx);
    if (resumed) return resumed;
    // Legacy packaging rows predate final-package checkpoints. Replay the
    // graph once to establish the new durable source/output manifest.
  }

  await stage(ctx, "base_generating", 5, "正在生成主形象候选");
  const visualConcurrency = configuredVisualConcurrency(ctx.env);
  const candidates = await mapWithConcurrency(
    [1, 2],
    visualConcurrency,
    (candidateIndex, _index, signal) => generateBaseCandidate({ ...ctx, signal }, candidateIndex),
    ctx.signal,
  );
  await checkCancelled(ctx);
  run = await currentRun(ctx);
  let selectedArtifactId = run.selectedBaseArtifactId;
  if (!selectedArtifactId && run.autoContinue && ctx.qualityInspectionEnabled) {
    selectedArtifactId = await selectBaseAutomatically(ctx, candidates);
    const selectedUpdate = await ctx.prisma.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { selectedBaseArtifactId: selectedArtifactId } });
    if (selectedUpdate.count !== 1) throw new CodexPetLeaseLostError();
  }
  if (!selectedArtifactId) {
    const reviewReleased = await ctx.prisma.$transaction(async (tx) => {
      const changed = await tx.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { status: "awaiting_base_review", progressStage: "awaiting_base_review", progressPercent: 15, progressMessage: "请选择一个主形象后继续", workerId: null, heartbeatAt: new Date() } });
      if (changed.count !== 1) return false;
      await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "awaiting_base_review" } });
      return true;
    });
    if (!reviewReleased) throw new CodexPetLeaseLostError();
    await emit(ctx, "base.review_required", "awaiting_base_review", 15, "主形象候选已就绪，请选择后继续", { candidateArtifactIds: candidates.map((candidate) => candidate.artifact.id) });
    return { status: "awaiting_base_review", runId: ctx.runId };
  }
  const selected = candidates.find((candidate) => candidate.artifact.id === selectedArtifactId);
  if (!selected) throw new Error("选中的主形象不属于当前运行候选");
  const selectedCommitted = await ctx.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { selectedBaseArtifactId: selectedArtifactId } });
    if (changed.count !== 1) return false;
    const artifactChanged = await tx.codexPetArtifact.updateMany({
      where: {
        id: selectedArtifactId,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        kind: "base_candidate",
        status: "ready",
      },
      data: {
        expiresAt: null,
        metadata: { ...asRecord(selected.artifact.metadata), selected: true } as Prisma.InputJsonValue,
      },
    });
    if (artifactChanged.count !== 1) throw new CodexPetLeaseLostError();
    return true;
  });
  if (!selectedCommitted) throw new CodexPetLeaseLostError();
  await ensurePersistedBaseSelection(ctx, selectedArtifactId);
  await emit(ctx, "stage.completed", "base_generating", 15, "主形象已确认", { selectedArtifactId });

  // Base generation and base-choice QA intentionally run without a guide:
  // the approved image does not exist yet. From this durable point onward,
  // every generation/QA prompt receives the recovered canonical guide.
  ctx.identity.canonicalGuide = await getIdentityGuide(ctx, selected);

  await stage(ctx, "standard_generating", 16, "正在制作 9 组标准动作");
  // Idle is the cheapest identity/continuity gate for the whole standard
  // stage. Keep it ahead of running-right so a bad canonical micro-loop does
  // not spend a second real image call on a sibling action that will be
  // discarded immediately. The remaining rows start only after both critical
  // gates pass.
  let idle = await runStandardRow(ctx, "idle", selected, 20);
  let jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
  await resumeStageIfRepairing(ctx, "standard_generating", 25, "正在制作 9 组标准动作");
  let runningRight = await runStandardRow(ctx, "running-right", selected, 25);
  await resumeStageIfRepairing(ctx, "standard_generating", 25, "正在制作 9 组标准动作");
  let runningLeft: BoardJobResult;
  if (!ctx.qualityInspectionEnabled) {
    runningLeft = await runStandardRow(ctx, "running-left", selected, 30);
  } else if (codexPetShouldMirrorRunningLeft(runningRight.mirrorSafe, ctx.identity.actionPrompts)) {
    try {
      runningLeft = await deriveRunningLeft(ctx, runningRight, selected);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MIRROR_NOT_SAFE") throw error;
      runningLeft = await runStandardRow(ctx, "running-left", selected, 30, true, "Do not mirror: preserve asymmetric markings, prop handedness and leftward action explicitly.");
    }
  } else {
    runningLeft = await runStandardRow(ctx, "running-left", selected, 30);
  }
  await resumeStageIfRepairing(ctx, "standard_generating", 30, "正在制作 9 组标准动作");
  const remainingStates = ["waving", "jumping", "failed", "waiting", "running", "review"] as const;
  const remaining = new Map<(typeof remainingStates)[number], BoardJobResult>();
  // Keep the rest of the standard graph ordered as well. This prevents five
  // unrelated paid calls from being in flight when one action fails QA, which
  // is especially important for a user-requested single acceptance run.
  const remainingResults: BoardJobResult[] = [];
  for (const [index, stateName] of remainingStates.entries()) {
    remainingResults.push(await runStandardRow(
      ctx,
      stateName,
      selected,
      35 + index * 5,
      false,
      "",
      "standard_generating",
      stateName === "jumping" ? jumpingTargetHeight : undefined,
    ));
  }
  await resumeStageIfRepairing(ctx, "standard_generating", 60, "9 组标准动作已通过逐组检查，正在组装中间图集");
  remainingStates.forEach((stateName, index) => remaining.set(stateName, remainingResults[index]!));
  const frames: PetFramesByState = {
    idle: idle.frames,
    "running-right": runningRight.frames,
    "running-left": runningLeft.frames,
    waving: remaining.get("waving")!.frames,
    jumping: remaining.get("jumping")!.frames,
    failed: remaining.get("failed")!.frames,
    waiting: remaining.get("waiting")!.frames,
    running: remaining.get("running")!.frames,
    review: remaining.get("review")!.frames,
  };
  // Assembling the intermediate is the first moment all nine action groups are
  // graded together. A rejection here names its cells, so regenerate only the
  // implicated groups instead of failing a run that already paid for eleven
  // boards; each repair is one extra call that the caller still has to approve
  // under per-image billing.
  const standardAtlasMaxAttempts = 2;
  let assembledStandard: Awaited<ReturnType<typeof storeStandardAtlas>> | null = null;
  for (let standardAttempt = 1; standardAttempt <= standardAtlasMaxAttempts; standardAttempt += 1) {
    try {
      assembledStandard = await storeStandardAtlas(ctx, frames, standardAttempt > 1);
      break;
    } catch (error) {
      if (!(error instanceof CodexPetStandardAtlasStructureError)) throw error;
      const rows = repairRowsFromAtlasValidation(error.validation);
      const unscoped = atlasValidationErrorsWithoutCellScope(error.validation);
      if (unscoped.length > 0 || rows.length === 0) throw error;
      if (standardAttempt >= standardAtlasMaxAttempts) {
        throw new CodexPetGateFailureError(
          error.message,
          "standard-atlas-structure",
          rows,
          [...error.validation.errors],
        );
      }
      const failures = [...error.validation.errors];
      const repairHint = `修复以下动作组的结构缺陷（单元格空白、越界或未用格位不透明）：${failures.slice(0, 20).join("；")}`;
      await emit(ctx, "run.repairing", "repairing", 62, `标准图集结构缺陷动作组修复 ${standardAttempt}/${standardAtlasMaxAttempts - 1}`, { retryKind: "visual", rows, failures });
      const standardRows = codexPetCoupledStandardRepairRows(
        rows.filter((row): row is StandardRepairRow => row !== "look-a" && row !== "look-b"),
      );
      const progressByState: Record<string, number> = { idle: 20, "running-right": 25, "running-left": 30, waving: 35, jumping: 40, failed: 45, waiting: 50, running: 55, review: 60 };
      for (const state of standardRows) {
        const result = await runStandardRow(
          ctx,
          state,
          selected,
          progressByState[state] ?? 60,
          true,
          repairHint,
          "standard_generating",
          state === "jumping" ? jumpingTargetHeight : undefined,
        );
        if (state === "idle") {
          idle = result;
          jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
        }
        else if (state === "running-right") runningRight = result;
        else if (state === "running-left") runningLeft = result;
        else remaining.set(state, result);
        frames[state] = result.frames;
      }
      await resumeStageIfRepairing(ctx, "standard_generating", 62, "标准动作结构修复完成，正在重新组装中间图集");
    }
  }
  if (!assembledStandard) throw new Error("标准 8×9 图集没有生成完整报告");
  let standard = assembledStandard;
  await emit(ctx, "stage.completed", "standard_generating", 65, "9 组标准动作已完成", { contactArtifactId: standard.contactArtifact.id });

  await stage(ctx, "direction_generating", 65, "正在制作 16 个观察方向");
  const mechanics = await getLookMechanics(ctx, selected);
  const cardinalLayout = ctx.imageModel === DOUBAO_IMAGE_MODEL
    ? await createSeedreamPoseBoardScaffold({ canonical: selected.buffer, chromaKey: ctx.identity.chromaKey, columns: 2, rows: 2, frameCount: 4 })
    : await createLayoutGuide({ columns: 2, rows: 2, frameCount: 4, title: "Four cardinal look anchors: up, right, down, left" });
  let cardinals = await runBoardJob(ctx, {
    key: "look-cardinals",
    kind: "look_cardinals",
    dependencies: ["look-mechanics", "standard-atlas"],
    inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
    prompt: buildCardinalPrompt(ctx.identity, mechanics),
    // The canonical character and deterministic 2x2 guide fully define this
    // board. Uploading the large standard contact sheet as a third image adds
    // no cardinal evidence and can push relay edits past its first-response
    // window. Keep the contact artifact in job provenance/dependencies, but
    // do not send it to the model for this request.
    references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
    columns: 2,
    rows: 2,
    frameCount: 4,
    progress: 68,
    qaKind: "cardinals",
    qaContext: "四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左",
    qaRepetitions: 3,
  });
  let cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals);
  await resumeStageIfRepairing(ctx, "direction_generating", 68, "四个观察方向锚点已通过，正在生成第一组方向");
  const lookLayout = ctx.imageModel === DOUBAO_IMAGE_MODEL
    ? await createSeedreamPoseBoardScaffold({ canonical: selected.buffer, chromaKey: ctx.identity.chromaKey, columns: 4, rows: 2, frameCount: 8 })
    : await createLayoutGuide({
        columns: 4,
        rows: 2,
        frameCount: 8,
        title: "Eight clockwise look directions · follow the row-major frame numbers",
        slotLabels: ["1", "2", "3", "4", "5", "6", "7", "8"],
      });
  let lookAAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-a", ctx.identity.chromaKey);
  let lookBAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-b", ctx.identity.chromaKey);
  let lookA = await runBoardJob(ctx, {
    key: "look-a",
    kind: "look_row",
    dependencies: ["look-cardinals"],
    inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, standard.contactArtifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics),
    references: lookRowReferences({
      row: "look-a",
      anchorStoryboard: lookAAnchorStoryboard,
      canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
      cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
      standardContact: standard.contact,
      layout: lookLayout,
    }),
    columns: 4,
    rows: 2,
    frameCount: 8,
    frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    progress: 72,
    qaKind: "directions",
    qaContext: "方向 000 到 157.5 的连续顺时针观察动作",
    animationDurations: petRowSpec("look-a").durations,
  });
  let neutralDirectionFrame = { artifact: idle.frameArtifacts[0]!, buffer: idle.frames[0]! };
  let registeredLookA = await registerDirectionRow(ctx, {
    row: "look-a",
    source: lookA,
    neutral: neutralDirectionFrame,
    progress: 73,
  });
  let firstLookGate = await reviewFirstLookRow(ctx, { look: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  const firstLookRepairRequirements: string[] = [];
  while (!firstLookGate.pass) {
    if (lookA.job.attempt >= lookA.job.maxAttempts) {
      const message = `方向 000 到 157.5 未通过 row-10 前置门禁：${firstLookGate.failures.join("；") || "方向语义或连续性失败"}`;
      if (ctx.perImageBilling || ctx.env.CODEX_PET_IMAGE_APPROVAL_GATE !== "0") {
        throw new CodexPetImageApprovalRequiredError("look-a", `${message}，需要确认后才能重新生成`);
      }
      throw new Error(message);
    }
    await emit(ctx, "run.repairing", "repairing", 74, "正在修复第一组观察方向，第二组尚未启动", {
      attempt: lookA.job.attempt,
      retryKind: "visual",
      failures: firstLookGate.failures,
    }, lookA.job.key);
    const diagnosticBoard = lookA.board;
    const cumulativeRepairHint = appendCumulativeRepairRequirement(
      firstLookRepairRequirements,
      firstLookGate.repairPrompt || firstLookGate.failures.join("；") || "Keep the complete 000 through 157.5 row on one monotonic clockwise screen-right arc.",
    );
    lookA = await runBoardJob(ctx, {
      key: "look-a",
      kind: "look_row",
      dependencies: ["look-cardinals"],
      inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, standard.contactArtifact.id],
      prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics),
      references: lookRowReferences({
        row: "look-a",
        anchorStoryboard: lookAAnchorStoryboard,
        canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
        cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
        standardContact: standard.contact,
        layout: lookLayout,
        diagnosticBoard,
      }),
      columns: 4,
      rows: 2,
      frameCount: 8,
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
      progress: 74,
      qaKind: "directions",
      qaContext: "修复方向 000 到 157.5 的完整连续动作组",
      animationDurations: petRowSpec("look-a").durations,
      force: true,
      repairHint: cumulativeRepairHint,
    });
    registeredLookA = await registerDirectionRow(ctx, {
      row: "look-a",
      source: lookA,
      neutral: neutralDirectionFrame,
      progress: 73,
    });
    firstLookGate = await reviewFirstLookRow(ctx, { look: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  }
  requireApprovedRegisteredRow(registeredLookA, "第一组观察方向");
  await resumeStageIfRepairing(ctx, "direction_generating", 74, "第一组观察方向已通过门禁，正在生成第二组方向");
  // Persist row 9 as an exact 8x1 atlas strip, but present those same approved
  // cells to GPT edits in the supported 4x2 board geometry. This is a pure
  // rearrangement with no resampling and avoids an unnecessarily extreme
  // 1536x208 reference aspect ratio.
  let registeredLookAReference = await composeLookSourceBoardReference(registeredLookA.frames, ctx.identity.chromaKey);
  let lookBScreenLeftTrajectoryReference = await composeLookBScreenLeftTrajectoryReference(
    registeredLookA.frames,
    cardinals.frames,
    ctx.identity.chromaKey,
  );
  await emit(ctx, "stage.completed", "direction_generating", 74, "第一组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 9,
    registeredRowArtifactId: registeredLookA.registeredRowArtifact.id,
    registrationManifestArtifactId: registeredLookA.manifestArtifact.id,
    neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
    continuityWarnings: firstLookGate.continuity.warnings.map((warning) => warning.message),
  }, lookA.job.key);
  let lookB = await runBoardJob(ctx, {
    key: "look-b",
    kind: "look_row",
    dependencies: ["look-a-registration"],
    inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, registeredLookA.registeredRowArtifact.id, registeredLookA.manifestArtifact.id, standard.contactArtifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics),
    references: lookRowReferences({
      row: "look-b",
      anchorStoryboard: lookBAnchorStoryboard,
      directionArcGuide: lookBScreenLeftTrajectoryReference,
      canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
      cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
      registeredLookA: registeredLookAReference,
      standardContact: standard.contact,
      layout: lookLayout,
    }),
    columns: 4,
    rows: 2,
    frameCount: 8,
    frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    progress: 76,
    qaKind: "directions",
    qaContext: "方向 180 到 337.5 连续顺时针观察动作，并与 157.5/000 边界连续",
    animationDurations: petRowSpec("look-b").durations,
  });
  let registeredLookB = await registerDirectionRow(ctx, {
    row: "look-b",
    source: lookB,
    neutral: neutralDirectionFrame,
    lockedRow9: registeredLookA,
    progress: 77,
  });
  let secondLookGate = await reviewSecondLookRow(ctx, { look: registeredLookB, previousLook: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  const secondLookRepairRequirements: string[] = [];
  while (!secondLookGate.pass) {
    if (lookB.job.attempt >= lookB.job.maxAttempts) {
      const message = `方向 180 到 337.5 未通过 row-10 前置门禁：${secondLookGate.failures.join("；") || "方向语义或连续性失败"}`;
      if (ctx.perImageBilling || ctx.env.CODEX_PET_IMAGE_APPROVAL_GATE !== "0") {
        throw new CodexPetImageApprovalRequiredError("look-b", `${message}，需要确认后才能重新生成`);
      }
      throw new Error(message);
    }
    await emit(ctx, "run.repairing", "repairing", 78, "正在修复第二组观察方向，最终组装尚未启动", {
      attempt: lookB.job.attempt,
      retryKind: "visual",
      failures: secondLookGate.failures,
    }, lookB.job.key);
    const diagnosticBoard = lookB.board;
    const cumulativeRepairHint = appendCumulativeRepairRequirement(
      secondLookRepairRequirements,
      secondLookGate.repairPrompt || secondLookGate.failures.join("；") || "Keep the complete 180 through 337.5 row on one monotonic clockwise screen-left arc.",
    );
    lookB = await runBoardJob(ctx, {
      key: "look-b", kind: "look_row", dependencies: ["look-a-registration"], inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, registeredLookA.registeredRowArtifact.id, registeredLookA.manifestArtifact.id, standard.contactArtifact.id],
      prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics),
      references: lookRowReferences({
        row: "look-b",
        anchorStoryboard: lookBAnchorStoryboard,
        directionArcGuide: lookBScreenLeftTrajectoryReference,
        canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
        cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
        registeredLookA: registeredLookAReference,
        standardContact: standard.contact,
        layout: lookLayout,
        diagnosticBoard,
      }),
      columns: 4, rows: 2, frameCount: 8, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT, progress: 78, qaKind: "directions", qaContext: "修复方向 180 到 337.5 的完整连续动作组", animationDurations: petRowSpec("look-b").durations, force: true, repairHint: cumulativeRepairHint,
    });
    registeredLookB = await registerDirectionRow(ctx, {
      row: "look-b",
      source: lookB,
      neutral: neutralDirectionFrame,
      lockedRow9: registeredLookA,
      progress: 78,
    });
    secondLookGate = await reviewSecondLookRow(ctx, { look: registeredLookB, previousLook: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
  }
  requireApprovedRegisteredRow(registeredLookB, "第二组观察方向");
  await resumeStageIfRepairing(ctx, "direction_generating", 79, "第二组观察方向已通过门禁，正在组装 16 方向");
  await emit(ctx, "stage.completed", "direction_generating", 79, "第二组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 10,
    registeredRowArtifactId: registeredLookB.registeredRowArtifact.id,
    registrationManifestArtifactId: registeredLookB.manifestArtifact.id,
    continuityWarnings: secondLookGate.continuity.warnings.map((warning) => warning.message),
  }, lookB.job.key);
  await emit(ctx, "stage.completed", "direction_generating", 80, "16 个观察方向已完成", {});

  await stage(ctx, "validating", 80, "正在组装图集并执行最终质量检查");
  let finalAtlas: Buffer = Buffer.alloc(0);
  let contactSheet: Buffer = Buffer.alloc(0);
  let directionSheet: Buffer = Buffer.alloc(0);
  let blindSheet: Buffer = Buffer.alloc(0);
  let blindValidation: BlindDirectionValidation | null = null;
  let semantics: readonly DirectionSemanticVerdict[] = [];
  let validation: Awaited<ReturnType<typeof validatePetAtlas>> | null = null;
  let despill: Awaited<ReturnType<typeof despillChromaEdges>>["report"] | null = null;
  let continuity: Awaited<ReturnType<typeof measureDirectionContinuity>> | null = null;
  let directionRegistration: {
    readonly ok: boolean;
    readonly sharedScale: number;
    readonly sourceBoardSizes: readonly { readonly width: number; readonly height: number }[];
    readonly diagnosticsByBoard: readonly (readonly DirectionRegistrationCellDiagnostics[])[];
    readonly schemaVersion: string;
    readonly neutralFrameArtifactId: string;
    readonly target: NeutralDirectionRegistrationManifest["transform"]["target"];
    readonly registeredRowArtifactIds: readonly string[];
    readonly manifestArtifactId: string;
    readonly row9ImmutableDuringRow10Registration: true;
    readonly neutralValidationByBoard: readonly NeutralDirectionGeometryValidation[];
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  } | null = null;
  let finalQa: PetVisualQaVerdict | null = null;
  const finalRepairHistory: Array<{ attempt: number; rows: readonly string[]; failures: readonly string[] }> = [];

  // Rebuild both direction rows as complete groups whenever a direction gate
  // or final visual QA requests repair.  Re-running both rows keeps the seam
  // and the 000/360 wrap coherent; no individual direction frame is patched.
  const regenerateDirectionRows = async (repairHint: string): Promise<void> => {
    const lookARequirements: string[] = [];
    let lookADiagnosticBoard = lookA.board;
    let lookAHint = appendCumulativeRepairRequirement(
      lookARequirements,
      repairHint || "Rebuild both coherent look rows while preserving the approved cardinal semantics and both row boundaries.",
    );
    for (;;) {
      lookA = await runBoardJob(ctx, {
        key: "look-a", kind: "look_row", dependencies: ["look-cardinals"], inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, standard.contactArtifact.id],
        prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics), references: lookRowReferences({
          row: "look-a",
          anchorStoryboard: lookAAnchorStoryboard,
          canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
          cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
          standardContact: standard.contact,
          layout: lookLayout,
          diagnosticBoard: lookADiagnosticBoard,
        }),
        columns: 4, rows: 2, frameCount: 8, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT, progress: 84, qaKind: "directions", qaContext: "修复方向 000 到 157.5 的完整连续动作组", workflowStage: "validating", animationDurations: petRowSpec("look-a").durations, force: true, repairHint: lookAHint,
      });
      registeredLookA = await registerDirectionRow(ctx, {
        row: "look-a",
        source: lookA,
        neutral: neutralDirectionFrame,
        progress: 84,
      });
      firstLookGate = await reviewFirstLookRow(ctx, { look: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
      if (firstLookGate.pass) break;
      if (lookA.job.attempt >= lookA.job.maxAttempts) throw new Error(`修复后的第一组观察方向未通过前置门禁：${firstLookGate.failures.join("；") || "方向语义或连续性失败"}`);
      lookADiagnosticBoard = lookA.board;
      lookAHint = appendCumulativeRepairRequirement(
        lookARequirements,
        firstLookGate.repairPrompt || firstLookGate.failures.join("；") || "Keep row A monotonic across the top-to-bottom row boundary between chronological cells 4 and 5.",
      );
    }
    requireApprovedRegisteredRow(registeredLookA, "修复后的第一组观察方向");
    registeredLookAReference = await composeLookSourceBoardReference(registeredLookA.frames, ctx.identity.chromaKey);
    lookBScreenLeftTrajectoryReference = await composeLookBScreenLeftTrajectoryReference(
      registeredLookA.frames,
      cardinals.frames,
      ctx.identity.chromaKey,
    );
    const lookBRequirements: string[] = [];
    let lookBDiagnosticBoard = lookB.board;
    let lookBHint = appendCumulativeRepairRequirement(
      lookBRequirements,
      repairHint || "Rebuild both coherent look rows while preserving the approved cardinal semantics and both row boundaries.",
    );
    for (;;) {
      lookB = await runBoardJob(ctx, {
        key: "look-b", kind: "look_row", dependencies: ["look-a-registration"], inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, registeredLookA.registeredRowArtifact.id, registeredLookA.manifestArtifact.id, standard.contactArtifact.id],
        prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics), references: lookRowReferences({
          row: "look-b",
          anchorStoryboard: lookBAnchorStoryboard,
          directionArcGuide: lookBScreenLeftTrajectoryReference,
          canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
          cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
          registeredLookA: registeredLookAReference,
          standardContact: standard.contact,
          layout: lookLayout,
          diagnosticBoard: lookBDiagnosticBoard,
        }),
        columns: 4, rows: 2, frameCount: 8, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT, progress: 84, qaKind: "directions", qaContext: "修复方向 180 到 337.5 的完整连续动作组", workflowStage: "validating", animationDurations: petRowSpec("look-b").durations, force: true, repairHint: lookBHint,
      });
      registeredLookB = await registerDirectionRow(ctx, {
        row: "look-b",
        source: lookB,
        neutral: neutralDirectionFrame,
        lockedRow9: registeredLookA,
        progress: 84,
      });
      secondLookGate = await reviewSecondLookRow(ctx, { look: registeredLookB, previousLook: registeredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor });
      if (secondLookGate.pass) break;
      if (lookB.job.attempt >= lookB.job.maxAttempts) throw new Error(`修复后的第二组观察方向未通过前置门禁：${secondLookGate.failures.join("；") || "方向语义或连续性失败"}`);
      lookBDiagnosticBoard = lookB.board;
      lookBHint = appendCumulativeRepairRequirement(
        lookBRequirements,
        secondLookGate.repairPrompt || secondLookGate.failures.join("；") || "Keep row B monotonic across the top-to-bottom row boundary between chronological cells 4 and 5 and both row seams.",
      );
    }
    requireApprovedRegisteredRow(registeredLookB, "修复后的第二组观察方向");
    await resumeStageIfRepairing(ctx, "validating", 84, "方向修复已通过，正在继续最终质量检查");
  };

  /**
   * Regenerate the complete action groups a verdict implicates, then rebuild
   * every downstream artifact that depends on them.
   *
   * Deterministic structural gates and the independent visual reviewer both
   * produce row-scoped evidence, so both must reach the same bounded repair
   * path. Throwing on a structural rejection instead would end the run holding
   * fully paid, fully approved action groups — the `老鼠猫` failure mode.
   */
  const repairScopedRows = async (input: {
    readonly rows: readonly FinalRepairRow[];
    readonly repairHint: string;
    readonly progress: number;
    readonly message: string;
    readonly failures: readonly string[];
  }): Promise<void> => {
    await emit(ctx, "run.repairing", "repairing", input.progress, input.message, { retryKind: "visual", rows: [...input.rows], failures: [...input.failures] });
    const standardRows = codexPetCoupledStandardRepairRows(
      input.rows.filter((row): row is StandardRepairRow => row !== "look-a" && row !== "look-b"),
    );
    if (standardRows.length > 0) {
      const progressByState: Record<string, number> = { idle: 20, "running-right": 25, "running-left": 30, waving: 35, jumping: 40, failed: 45, waiting: 50, running: 55, review: 60 };
      if (standardRows[0] === "idle") {
        idle = await runStandardRow(
          ctx,
          "idle",
          selected,
          progressByState.idle!,
          true,
          input.repairHint,
          "validating",
        );
        frames.idle = idle.frames;
        jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
        neutralDirectionFrame = { artifact: idle.frameArtifacts[0]!, buffer: idle.frames[0]! };
      }
      const parallelRows = standardRows.filter((state) => state !== "idle");
      const repaired = await mapWithConcurrency(parallelRows, visualConcurrency, (state, _index, signal) => (
        runStandardRow(
          { ...ctx, signal },
          state,
          selected,
          progressByState[state] ?? 64,
          true,
          input.repairHint,
          "validating",
          state === "jumping" ? jumpingTargetHeight : undefined,
        )
      ), ctx.signal);
      repaired.forEach((result, index) => {
        const state = parallelRows[index]!;
        if (state === "running-right") runningRight = result;
        else runningLeft = state === "running-left" ? result : runningLeft;
        if (state !== "running-right" && state !== "running-left") remaining.set(state, result);
        frames[state] = result.frames;
      });
      standard = await storeStandardAtlas(ctx, frames, true);

      // Direction references include the approved standard contact; refresh
      // the cardinal anchors as well whenever standard action art changes.
      cardinals = await runBoardJob(ctx, {
        key: "look-cardinals", kind: "look_cardinals", dependencies: ["look-mechanics", "standard-atlas"], inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
        prompt: buildCardinalPrompt(ctx.identity, mechanics), references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
        columns: 2, rows: 2, frameCount: 4, progress: 83, qaKind: "cardinals", qaContext: "修复后四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左", qaRepetitions: 3, workflowStage: "validating", force: true, repairHint: input.repairHint,
      });
      cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals, true);
      lookAAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-a", ctx.identity.chromaKey);
      lookBAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-b", ctx.identity.chromaKey);
    }
    await regenerateDirectionRows(input.repairHint);
  };

  const directionMaxAttempts = 3;
  for (let directionAttempt = 1; directionAttempt <= directionMaxAttempts; directionAttempt += 1) {
    requireApprovedRegisteredRow(registeredLookA, "最终组装第一组观察方向");
    requireApprovedRegisteredRow(registeredLookB, "最终组装第二组观察方向");
    const registrationErrors = [
      ...registeredLookA.errors,
      ...registeredLookB.errors,
      ...(registeredLookA.manifest.transform.scale === registeredLookB.manifest.transform.scale ? [] : ["row-10-registration-scale-changed"]),
      ...(registeredLookA.manifestArtifact.id === registeredLookB.manifestArtifact.id ? [] : ["row-10-registration-manifest-changed"]),
    ];
    directionRegistration = {
      ok: registrationErrors.length === 0 && registeredLookA.validation.ok && registeredLookB.validation.ok,
      sharedScale: registeredLookA.manifest.transform.scale,
      sourceBoardSizes: [registeredLookA.sourceBoardSize, registeredLookB.sourceBoardSize],
      diagnosticsByBoard: [registeredLookA.diagnostics, registeredLookB.diagnostics],
      schemaVersion: registeredLookA.manifest.schemaVersion,
      neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
      target: registeredLookA.manifest.transform.target,
      registeredRowArtifactIds: [registeredLookA.registeredRowArtifact.id, registeredLookB.registeredRowArtifact.id],
      manifestArtifactId: registeredLookA.manifestArtifact.id,
      row9ImmutableDuringRow10Registration: true,
      neutralValidationByBoard: [registeredLookA.validation, registeredLookB.validation],
      errors: registrationErrors,
      warnings: [...registeredLookA.warnings, ...registeredLookB.warnings],
    };
    await putJsonArtifact(ctx, {
      jobId: registeredLookB.registrationJob.id,
      kind: "qa_report",
      name: `16 方向中立帧锁定缩放与基线注册 · 第 ${directionAttempt} 次`,
      value: directionRegistration,
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    if (!directionRegistration.ok) {
      if (directionAttempt >= directionMaxAttempts) {
        throw new CodexPetGateFailureError(
          `16 个观察方向中立帧锁定注册经 ${directionMaxAttempts} 次尝试后仍未通过：${directionRegistration.errors.join("；")}`,
          "direction-registration",
          ["look-a", "look-b"],
          directionRegistration.errors,
        );
      }
      const repairHint = directionRegistration.errors.join("; ") || "keep all 16 direction poses at the approved neutral body scale, lower-body anchor and baseline";
      await emit(ctx, "run.repairing", "repairing", 82, `方向中立帧锁定注册自动修复 ${directionAttempt}/${directionMaxAttempts - 1}`, { retryKind: "visual", failures: directionRegistration.errors });
      await regenerateDirectionRows(repairHint);
      continue;
    }
    // These are loaded from the persisted registered row artifacts. Final
    // assembly never revisits either raw 4x2 board and therefore cannot let a
    // wide row-10 pose recalculate or shrink the approved row 9.
    frames["look-a"] = registeredLookA.frames;
    frames["look-b"] = registeredLookB.frames;
    const assembled = await assemblePetAtlas(frames, "png");
    const cleaned = await despillChromaEdges(assembled, ctx.identity.chromaKey);
    finalAtlas = cleaned.image;
    despill = cleaned.report;
    validation = await validatePetAtlas(finalAtlas, ctx.identity.chromaKey, {
      allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
    });
    continuity = await measureDirectionContinuity(finalAtlas);
    if (!validation.ok || !continuity.ok) {
      // Both reports name the offending cells, so a structural rejection is a
      // repair scope rather than a wall. Only unattributable atlas-wide defects
      // (dimensions, missing alpha, residue outside the cell grid) remain fatal,
      // because no action group could be regenerated to fix them.
      const structuralFailures = [...validation.errors, ...continuity.errors];
      const unscopedErrors = atlasValidationErrorsWithoutCellScope(validation);
      const structuralRows = [...new Set([
        ...repairRowsFromAtlasValidation(validation),
        ...repairRowsFromDirectionContinuity(continuity),
      ])];
      if (unscopedErrors.length > 0 || structuralRows.length === 0 || directionAttempt >= directionMaxAttempts) {
        const message = `最终图集结构检查失败：${structuralFailures.join("；")}`;
        // An unattributable defect has no row scope to hand a continuation; a
        // scoped one does, even after the in-process attempts are spent.
        throw unscopedErrors.length > 0 || structuralRows.length === 0
          ? new Error(message)
          : new CodexPetGateFailureError(message, "final-atlas-structure", structuralRows, structuralFailures);
      }
      finalRepairHistory.push({ attempt: directionAttempt, rows: structuralRows, failures: structuralFailures });
      await repairScopedRows({
        rows: structuralRows,
        repairHint: `修复以下动作组的结构缺陷（单元格空白、越界、残留色键或方向缺失）：${structuralFailures.slice(0, 20).join("；")}`,
        progress: 86,
        message: `最终图集结构缺陷动作组修复 ${directionAttempt}/${directionMaxAttempts - 1}`,
        failures: structuralFailures,
      });
      continue;
    }
    // Despill residue inside the cell grid is already attributed per row above;
    // anything left here is a defect of the despill pass itself.
    if (!despill.ok) throw new Error(`最终图集残留色键像素 ${despill.remainingOpaqueKeyPixels}`);
    contactSheet = await createAtlasContactSheet(finalAtlas);
    directionSheet = await createDirectionQaSheet(finalAtlas);
    const blind = await createDirectionBlindQaSheet(finalAtlas);
    blindSheet = blind.image;
    if (!ctx.qualityInspectionEnabled) {
      blindValidation = { ok: true, reviewers: [], consensus: [], failures: [], warnings: [] };
      semantics = [];
      finalQa = {
        pass: true,
        score: 100,
        mirrorSafe: false,
        identity: true,
        structure: true,
        semantics: true,
        continuity: true,
        warnings: [],
        failures: [],
        repairPrompt: "",
      };
      break;
    }
    [blindValidation, semantics] = await Promise.all([
      ctx.blindQa({ sheet: blind.image, answerKey: blind.answerKey, identityGuide: ctx.identity.canonicalGuide, env: ctx.env, signal: ctx.signal }),
      ctx.directionSemantics({ sheet: directionSheet, expectedDirections: LOOK_DIRECTIONS, identityGuide: ctx.identity.canonicalGuide, env: ctx.env, signal: ctx.signal }),
    ]);
    assertCodexPetVisualQaProvenance(blindValidation.modelProvenance, ctx.visualQaModel, "blind-direction-qa");
    semantics.forEach((item) => {
      assertCodexPetVisualQaProvenance(item.modelProvenance, ctx.visualQaModel, `direction-${item.direction}`);
    });
    const semanticFailures = semantics.filter((item) => item.verdict === "fail");
    if (!(blindValidation.ok && semanticFailures.length === 0)) {
      const directionFailures = [...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}:${item.reason}`)];
      if (directionAttempt >= directionMaxAttempts) {
        // Blind QA and semantics both speak in direction labels; map them back to
        // the two direction rows so a continuation redoes only those boards.
        const directionRows = [...new Set([
          ...repairRowsFromDirectionContinuity({ errors: directionFailures }),
          ...(blindValidation.failures.length > 0 ? ["look-a", "look-b"] as const : []),
        ])];
        throw new CodexPetGateFailureError(
          `方向质检经 ${directionMaxAttempts} 次尝试后仍未通过：${directionFailures.join("；")}`,
          "direction-qa",
          directionRows,
          directionFailures,
        );
      }
      const repairHint = [...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}: ${item.reason}`)].join("; ");
      await emit(ctx, "run.repairing", "repairing", 84, `方向动作自动修复 ${directionAttempt}/${directionMaxAttempts - 1}`, { retryKind: "visual", failures: repairHint });
      await regenerateDirectionRows(repairHint);
      continue;
    }

    // The final independent reviewer is part of the bounded repair loop. It
    // receives playable previews for all nine rows and returns complete row
    // scopes, allowing us to regenerate an action group before packaging.
    const continuityWarnings = continuity!.warnings.map((item) => item.message);
    const motionPreviews = await Promise.all(PET_ROW_SPECS.slice(0, 9).map((spec) => (
      createAnimatedWebpPreview(frames[spec.state]!, spec.durations)
    )));
    finalQa = await ctx.qa({
      images: [
        { buffer: selected.buffer, mime: selected.artifact.mime },
        { buffer: standard.contact, mime: "image/png" },
        { buffer: contactSheet, mime: "image/png" },
        { buffer: directionSheet, mime: "image/png" },
        ...motionPreviews.map((preview) => ({ buffer: preview.image, mime: preview.mime })),
      ],
      prompt: buildVisualQaPrompt(
        "final",
        `All nine standard rows and the complete labeled 16-direction loop; deterministic validation passed. `
        + `The first image is the canonical identity, followed by standard/final/direction sheets and nine animated WebP previews in row order. Inspect actual playback for cadence, vertical travel, inert loops, wrong facing, reversal, size popping and baseline jumps. `
        + `If any action group is defective, list its complete row name in repairRows; never request a single-frame patch. `
        + `Continuity metrics are review evidence only: ${continuityWarnings.slice(0, 20).join(" | ") || "no metric warnings"}`,
        ctx.identity.canonicalGuide,
        standardActionSpecificationSummary(ctx.identity.actionPrompts),
      ),
      env: ctx.env,
      signal: ctx.signal,
    });
    assertCodexPetVisualQaProvenance(finalQa.modelProvenance, ctx.visualQaModel, "final-visual-qa");
    if (codexPetVisualQaVerdictPasses(finalQa)) break;
    if (directionAttempt >= directionMaxAttempts) {
      throw new CodexPetGateFailureError(
        `最终独立视觉质检经 ${directionMaxAttempts} 次尝试后仍未通过：${finalQa.failures.join("；") || "角色一致性或动作连续性失败"}`,
        "final-visual-qa",
        repairRowsFromFinalQa(finalQa),
        finalQa.failures,
      );
    }
    const repairRows = repairRowsFromFinalQa(finalQa);
    finalRepairHistory.push({ attempt: directionAttempt, rows: repairRows, failures: finalQa.failures });
    await repairScopedRows({
      rows: repairRows,
      repairHint: finalQa.repairPrompt || finalQa.failures.join("；") || "修复指定动作组的身份、动作语义、节奏与连续性",
      progress: 88,
      message: `最终视觉质检动作组修复 ${directionAttempt}/${directionMaxAttempts - 1}`,
      failures: finalQa.failures,
    });
  }
  if (!validation || !despill || !blindValidation || !continuity || !directionRegistration?.ok || !finalQa || (ctx.qualityInspectionEnabled && !codexPetVisualQaVerdictPasses(finalQa))) {
    throw new Error("最终验证没有生成完整报告");
  }
  await resumeStageIfRepairing(ctx, "validating", 94, "最终结构、方向盲测与视觉质检已通过");
  const continuityWarnings = continuity.warnings.map((item) => item.message);
  await emit(ctx, "stage.completed", "validating", 94, "最终结构、方向盲测与视觉质检已通过", { warnings: [...validation.warnings, ...continuityWarnings, ...blindValidation.warnings, ...semantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`)] });

  const petId = `${ctx.identity.name}-${createHash("sha256").update(ctx.project.id).digest("hex").slice(0, 10)}`;
  const packaged = await createCodexPetPackage({ id: petId, displayName: ctx.identity.name, description: ctx.identity.description, spritesheet: finalAtlas });
  // Re-open the exact ZIP bytes that will be persisted.  This closes the
  // validation gap between the pre-package PNG checks and the WebP/ZIP bytes
  // consumed by Codex, and makes a malformed package a normal refundable run
  // failure instead of a deliverable that only fails at install time.
  const inspectedPackage = await inspectCodexPetZip(packaged.zip);
  if (inspectedPackage.manifest.spriteVersionNumber !== 2 || inspectedPackage.manifest.spritesheetPath !== "spritesheet.webp") {
    throw new Error("Codex v2 安装包结构验证失败");
  }
  const packagedValidation = await validatePetAtlas(packaged.spritesheet, ctx.identity.chromaKey, {
    allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
  });
  if (!packagedValidation.ok) {
    throw new Error(`Codex v2 WebP 图集验证失败：${packagedValidation.errors.join("；")}`);
  }
  let visualQaActualModels: string[] = [];
  let visualQaRoutes: string[] = [];
  if (ctx.qualityInspectionEnabled) {
    if (!firstLookGate.visual) throw new Error("row9 前置门禁缺少所选视觉模型证明");
    const requiredJobProvenance = await summarizeRequiredVisualJobProvenance(ctx);
    const row9GateProvenance = assertCodexPetVisualQaProvenance(firstLookGate.visual.modelProvenance, ctx.visualQaModel, "row9-pre-generation-gate");
    const row10GateProvenance = assertCodexPetVisualQaProvenance(secondLookGate.visual?.modelProvenance, ctx.visualQaModel, "row10-pre-generation-gate");
    const finalQaProvenance = assertCodexPetVisualQaProvenance(finalQa.modelProvenance, ctx.visualQaModel, "final-visual-qa");
    const blindQaProvenance = assertCodexPetVisualQaProvenance(blindValidation.modelProvenance, ctx.visualQaModel, "blind-direction-qa");
    const semanticProvenance = semantics.map((item) => (
      assertCodexPetVisualQaProvenance(item.modelProvenance, ctx.visualQaModel, `direction-${item.direction}`)
    ));
    visualQaActualModels = [...new Set([
      ...requiredJobProvenance.actualModels,
      ...row9GateProvenance.actualModels,
      ...row10GateProvenance.actualModels,
      ...finalQaProvenance.actualModels,
      ...blindQaProvenance.actualModels,
      ...semanticProvenance.flatMap((item) => item.actualModels),
    ])];
    if (visualQaActualModels.length === 0
      || visualQaActualModels.some((model) => !isAllowedCodexPetVisualModel(model))) {
      throw new Error(`最终视觉质检模型不符合 ${ctx.visualQaModel} 合同`);
    }
    visualQaRoutes = [...new Set([
      ...requiredJobProvenance.routes,
      ...row9GateProvenance.routes,
      ...row10GateProvenance.routes,
      ...finalQaProvenance.routes,
      ...blindQaProvenance.routes,
      ...semanticProvenance.flatMap((item) => item.routes),
    ])];
  }
  const provider = await summarizeProviderUsage(ctx);
  const imageModelMatches = (model: string) => model === ctx.imageModel
    || (ctx.imageModel === GPT_IMAGE_MODEL && model === "gpt-image-2-codex");
  if (provider.actualModels.length === 0
    || provider.actualModels.some((model) => !isAllowedCodexPetImageProvenance(model) || !imageModelMatches(model))) {
    throw new Error(`最终生图模型不符合 ${ctx.imageModel} 合同`);
  }
  const report = {
    ok: true,
    spriteVersionNumber: 2,
    modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
    requestedModel: ctx.imageModel,
    modelProvenance: {
      imageGeneration: {
        requestedModel: ctx.imageModel,
        actualModels: provider.actualModels,
      },
      visualQa: {
        enabled: ctx.qualityInspectionEnabled,
        requestedModel: ctx.qualityInspectionEnabled ? ctx.visualQaModel : null,
        actualModels: visualQaActualModels,
        routes: visualQaRoutes,
      },
    },
    chromaKey: ctx.identity.chromaKey,
    cardinalAnchor: {
      artifactId: cardinalAnchor.artifact.id,
      sourceBoardArtifactId: cardinals.boardArtifact.id,
      directions: ["000", "090", "180", "270"],
      evidence: asRecord(cardinalAnchor.artifact.metadata).cardinalEvidence,
    },
    deterministic: validation,
    standardAtlasValidation: standard.validation,
    packagedSpritesheet: packagedValidation,
    chromaDespill: despill,
    directionRegistration,
    directionContinuity: continuity,
    row9PreGenerationGate: {
      passed: firstLookGate.pass,
      neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
      registeredRowArtifactId: registeredLookA.registeredRowArtifact.id,
      registrationManifestArtifactId: registeredLookA.manifestArtifact.id,
      neutralGeometryValidation: registeredLookA.validation,
      deterministicContinuity: firstLookGate.continuity,
    },
    row10PreGenerationGate: {
      passed: secondLookGate.pass,
      registeredRowArtifactId: registeredLookB.registeredRowArtifact.id,
      reusedRegistrationManifestArtifactId: registeredLookB.manifestArtifact.id,
      neutralGeometryValidation: registeredLookB.validation,
      deterministicContinuity: secondLookGate.continuity,
      visual: secondLookGate.visual,
      failures: secondLookGate.failures,
    },
    finalRepairHistory,
    blindDirectionValidation: blindValidation,
    directionSemantics: semantics,
    finalVisualQa: finalQa,
    acceptableWarnings: [...validation.warnings, ...continuityWarnings, ...blindValidation.warnings, ...semantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`)],
  };
  const durablePackage = await persistOrResumeCodexPetFinalPackage({
    prisma: ctx.prisma,
    artifacts: ctx.artifacts,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    displayName: ctx.identity.name,
    description: ctx.identity.description,
    chromaKey: ctx.identity.chromaKey,
    provider,
    seed: {
      petId: packaged.petId,
      finalAtlas,
      spritesheet: packaged.spritesheet,
      zip: packaged.zip,
      contactSheet,
      directionSheet,
      blindSheet,
      report,
      inputArtifactIds: [
        standard.atlasArtifact.id,
        registeredLookA.registeredRowArtifact.id,
        registeredLookB.registeredRowArtifact.id,
      ],
    },
  });
  if (!durablePackage) throw new Error("最终打包任务未能建立持久化 checkpoint");
  return continueAfterDurablePackaging(ctx, durablePackage);
}

export async function executeCodexPetRun(input: { runId: string; deps: CodexPetRunnerDeps }): Promise<CodexPetExecutionResult> {
  const { deps } = input;
  const env = deps.env ?? process.env;
  const initialRun = await deps.prisma.codexPetRun.findUnique({ where: { id: input.runId }, include: { project: true } });
  if (!initialRun) throw new Error("Codex pet run not found");
  if (initialRun.project.id !== initialRun.projectId || initialRun.project.userId !== initialRun.userId) {
    throw new Error("Codex pet run ownership mismatch");
  }
  // BullMQ delivery is at-least-once and older retained failed jobs may be
  // observed during an upgrade. Terminal database state is authoritative: a
  // failed/refunded or API-cancelled run must never regenerate artifacts,
  // emit another terminal event, or attempt another refund.
  if (initialRun.status === "ready" || initialRun.status === "failed" || initialRun.status === "cancelled" || initialRun.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || initialRun.status === "awaiting_direction_review" || initialRun.status === "awaiting_regeneration_approval") {
    return { status: initialRun.status, runId: initialRun.id };
  }
  const initialSnapshot = asRecord(initialRun.inputSnapshot);
  const initialQualityInspectionEnabled = typeof initialSnapshot.qualityInspectionEnabled === "boolean"
    ? initialSnapshot.qualityInspectionEnabled
    : typeof initialRun.qualityInspectionEnabled === "boolean"
      ? initialRun.qualityInspectionEnabled
      : initialRun.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE ? false : true;
  const zeroChargeRecovery = ["packaging", "archiving"].includes(initialRun.status)
    && isCodexPetRecoverySnapshot(initialRun.inputSnapshot)
    && initialRun.billingChargeStatus === "not_required"
    && initialRun.billingPoints === 0;
  const initialVisualQaModel = typeof initialSnapshot.visualQaModel === "string"
    ? initialSnapshot.visualQaModel.trim()
    : "";
  const initialModelContractValid = initialSnapshot.modelContractVersion === CODEX_PET_MODEL_CONTRACT_VERSION
    && typeof initialSnapshot.requestedModel === "string"
    && isAllowedCodexPetImageModel(initialSnapshot.requestedModel)
    && initialRun.requestedModel === initialSnapshot.requestedModel
    && (!initialQualityInspectionEnabled || initialVisualQaModel === resolveCodexPetVisualQaModel(env, initialVisualQaModel));
  // Waiting for an explicit user choice is a durable pause, not runnable
  // work. A duplicate Bull delivery (for example an old retained/stalled job)
  // must not claim the run and replay base generation while the workbench is
  // showing candidates. Auto-selection and explicit selection routes first
  // move the row back to a runnable stage, so they are unaffected.
  if (initialRun.status === "awaiting_base_review"
    && !initialRun.selectedBaseArtifactId
    && !initialRun.autoContinue
    && initialModelContractValid
    && !initialRun.cancelRequested) {
    return { status: "awaiting_base_review", runId: initialRun.id };
  }
  // Queue delivery must never start visual work before the external package
  // charge is durably confirmed and the activation transaction has committed.
  const initialBillingActivated = initialRun.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE
    ? initialRun.billingSettlementStatus === "reserved"
    : initialRun.billingChargeStatus === "charged" && Boolean(initialRun.billingActivatedAt);
  if (!zeroChargeRecovery && !initialBillingActivated) {
    throw new Error("Codex pet run billing is not activated");
  }
  // A caller that does not supply a worker identity is generally a direct
  // invocation (tests, maintenance, or a one-off repair). Give each such
  // invocation a unique lease token so two concurrent calls in one process
  // still obey the same CAS rule. Queue workers supply their own unique token
  // and use it for the heartbeat below.
  const workerId = deps.workerId ?? `${WORKER_ID}:${randomUUID().slice(0, 12)}`;
  const claimed = await claimRunLease(
    deps.prisma,
    input.runId,
    workerId,
    env,
    initialRun.projectId,
    initialRun.userId,
    zeroChargeRecovery,
  );
  if (!claimed.claimed) {
    const fresh = claimed.run;
    if (!fresh) throw new Error("Codex pet run not found");
    if (fresh.status === "ready" || fresh.status === "failed" || fresh.status === "cancelled") {
      return { status: fresh.status, runId: fresh.id };
    }
    // Another live worker owns the run. Do not invoke finalizeFailure or
    // cancellation here; doing so would race the owner and could trigger a
    // duplicate refund. The queue/maintenance pass will retry after a stale
    // lease expires if necessary.
    return { status: "busy", runId: fresh.id };
  }
  const run = claimed.run;
  if (!run) throw new Error("Codex pet run disappeared after lease claim");
  const snapshot = asRecord(run.inputSnapshot);
  const snapshottedModelContractVersion = typeof snapshot.modelContractVersion === "string" ? snapshot.modelContractVersion.trim() : "";
  const snapshottedImageModel = typeof snapshot.requestedModel === "string" ? snapshot.requestedModel.trim() : "";
  const snapshottedVisualQaModel = typeof snapshot.visualQaModel === "string" ? snapshot.visualQaModel.trim() : "";
  const qualityInspectionEnabled = typeof snapshot.qualityInspectionEnabled === "boolean"
    ? snapshot.qualityInspectionEnabled
    : typeof run.qualityInspectionEnabled === "boolean"
      ? run.qualityInspectionEnabled
      : run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE ? false : true;
  const visualQaModel = qualityInspectionEnabled
    ? resolveCodexPetVisualQaModel(env, snapshottedVisualQaModel || run.visualQaModel || undefined)
    : "";
  const imageModel = snapshottedImageModel || run.requestedModel;
  const failedContinuation = asRecord(snapshot.failedContinuation);
  const snapshottedMaxBoardAttempts = failedContinuation.maxBoardAttemptsPerJob;
  const perImageBilling = run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE;
  const perImageCallPoints = perImageBilling ? frozenPerImageCallPoints(snapshot, run) : 0;
  const maxBoardAttempts = perImageBilling ? 1 : codexPetMaxBoardAttempts(env, snapshottedMaxBoardAttempts);
  // All visual calls in this run use the snapshotted project choice. Keeping
  // it in the context environment lets the existing visual helpers and their
  // injected test clients share one durable route without consulting the
  // mutable process default.
  const visualEnv = qualityInspectionEnabled ? { ...env, PET_VISUAL_QA_MODEL: visualQaModel } : env;
  // Recovery packaging is bound to already-approved bytes and never needs to
  // reload user references. Avoid making a zero-charge recovery depend on
  // reference-object availability after the original run has finished.
  const referenceAssetIds = zeroChargeRecovery ? [] : Array.isArray(snapshot.referenceAssetIds)
    ? snapshot.referenceAssetIds.filter((value): value is string => typeof value === "string")
    : [...run.project.referenceAssetIds];
  const snapshotString = (key: string, fallback: string) => typeof snapshot[key] === "string" ? snapshot[key] as string : fallback;
  const identity = {
    name: snapshotString("name", run.project.name),
    description: snapshotString("description", run.project.description),
    prompt: snapshotString("prompt", run.project.prompt),
    actionPrompts: normalizeCodexPetActionPrompts(snapshot.actionPrompts ?? run.project.actionPrompts),
    stylePreset: snapshotString("stylePreset", run.project.stylePreset),
    styleNotes: snapshotString("styleNotes", run.project.styleNotes),
  };
  let loadedReferences: Array<{ buffer: Buffer; mime: string; filename: string }> = [];
  let chromaKey = run.colorKey || "#ff00ff";
  try {
    if (snapshottedModelContractVersion !== CODEX_PET_MODEL_CONTRACT_VERSION) {
      throw new Error(`Codex pet run is missing the required ${CODEX_PET_MODEL_CONTRACT_VERSION} model contract`);
    }
    if (!isAllowedCodexPetImageModel(imageModel) || run.requestedModel !== imageModel) {
      throw new Error(`Codex pet image model contract is invalid: ${imageModel || "missing"}`);
    }
    if (qualityInspectionEnabled && snapshottedVisualQaModel !== visualQaModel) {
      throw new Error(`Codex pet visual model contract changed after start: ${snapshottedVisualQaModel} -> ${visualQaModel}`);
    }
    const referenceAssets = referenceAssetIds.length
      ? await deps.prisma.imageAsset.findMany({ where: { userId: run.userId, id: { in: referenceAssetIds } } })
      : [];
    if (referenceAssets.length !== referenceAssetIds.length) throw new Error("参考图不存在或无权使用");
    loadedReferences = await Promise.all(referenceAssetIds.map(async (id) => {
      const asset = referenceAssets.find((candidate) => candidate.id === id);
      if (!asset) throw new Error("参考图不存在或无权使用");
      const loaded = await deps.loadReferenceAsset(asset);
      return { ...loaded, filename: `${asset.id}.${loaded.mime.includes("webp") ? "webp" : "png"}` };
    }));
    chromaKey = run.colorKey || (loadedReferences.length
      ? await chooseChromaKey(loadedReferences.map((reference) => reference.buffer))
      : "#ff00ff");
    if (!run.colorKey) {
      const colorKeyClaim = await deps.prisma.codexPetRun.updateMany({ where: { id: run.id, projectId: run.project.id, userId: run.userId, workerId }, data: { colorKey: chromaKey, heartbeatAt: new Date() } });
      if (colorKeyClaim.count !== 1) throw new CodexPetLeaseLostError();
    }
  } catch (error) {
    if (!(error instanceof CodexPetLeaseLostError)) {
      await finalizeClaimedSetupFailure({ prisma: deps.prisma, appendEvent: deps.appendEvent, billing: deps.billing, project: run.project, runId: run.id, workerId, error }).catch(() => undefined);
    }
    throw error;
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) controller.abort(deps.signal.reason);
  else deps.signal?.addEventListener("abort", abortFromParent, { once: true });
  let checking = false;
  const monitor = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void deps.prisma.codexPetRun.findFirst({ where: { id: run.id, projectId: run.project.id, userId: run.userId }, select: { cancelRequested: true, status: true, workerId: true } })
      .then((fresh) => {
        if (!fresh || fresh.cancelRequested || fresh.status === "cancelled") controller.abort(new CodexPetCancelledError());
        else if (!(CODEX_PET_ACTIVE_STATUSES as readonly string[]).includes(fresh.status) || fresh.workerId !== workerId) controller.abort(new CodexPetLeaseLostError());
      })
      .finally(() => { checking = false; });
  }, 1_000);
  const configuredHeartbeat = Number(env.CODEX_PET_HEARTBEAT_MS);
  const leaseHeartbeatMs = Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0
    ? configuredHeartbeat
    : Math.min(10_000, Math.max(1_000, Math.floor(staleRunMs(env) / 3)));
  const leaseHeartbeat = setInterval(() => {
    void deps.prisma.codexPetRun.updateMany({
      where: {
        id: run.id,
        workerId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        ...(zeroChargeRecovery
          ? { billingChargeStatus: "not_required", billingPoints: 0 }
          : perImageBilling
            ? { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" }
            : { billingChargeStatus: "charged", billingActivatedAt: { not: null } }),
      },
      data: { heartbeatAt: new Date() },
    }).then((updated) => {
      if (updated.count !== 1 && !controller.signal.aborted) controller.abort(new CodexPetLeaseLostError());
    }).catch(() => undefined);
  }, leaseHeartbeatMs);
  const ctx: RunnerContext = {
    ...deps,
    env: visualEnv,
    workerId,
    signal: controller.signal,
    project: run.project,
    runId: run.id,
    imageModel,
    visualQaModel,
    qualityInspectionEnabled,
    perImageBilling,
    perImageCallPoints,
    maxBoardAttempts,
    referenceAssetIds,
    identity: {
      ...identity,
      chromaKey,
    },
    userReferences: loadedReferences.map((loaded) => imageInput(loaded.buffer, loaded.mime, loaded.filename)),
    generate: deps.visual?.generate ?? ((input) => generateCodexPetVisual({ ...input, model: imageModel })),
    qa: deps.visual?.qa ?? runCodexPetVisualQa,
    qaConsensus: deps.visual?.qaConsensus ?? runCodexPetVisualQaConsensus,
    blindQa: deps.visual?.blindQa ?? runBlindDirectionQa,
    directionSemantics: deps.visual?.directionSemantics ?? runLabeledDirectionSemantics,
    lookMechanics: deps.visual?.lookMechanics ?? generateCodexPetLookMechanics,
    identityGuide: deps.visual?.identityGuide ?? generateCodexPetIdentityGuide,
  };
  try {
    return await executeRun(ctx);
  } catch (error) {
    if (error instanceof CodexPetImageApprovalRequiredError) {
      await pauseForImageApproval(ctx, error);
      return { status: ctx.perImageBilling ? "awaiting_regeneration_approval" : "awaiting_direction_review", runId: run.id };
    }
    if (error instanceof CodexPetImageCallLimitError || error instanceof CodexPetImageCallApprovalRequiredError || error instanceof CodexPetImageCallAlreadySentError) {
      await pauseForImageApproval(ctx, new CodexPetImageApprovalRequiredError(error.jobKey, error.message));
      return { status: "awaiting_regeneration_approval", runId: run.id };
    }
    if (error instanceof CodexPetPackagingDeferredError) {
      if (await releaseDeferredPackagingLease(ctx, error)) {
        return { status: "packaging", runId: run.id };
      }
      const latest = await deps.prisma.codexPetRun.findFirst({
        where: { id: run.id, projectId: run.project.id, userId: run.userId },
        select: { status: true, cancelRequested: true },
      });
      if (latest?.cancelRequested || latest?.status === "cancelled") {
        await finalizeCancellation(ctx);
        return { status: "cancelled", runId: run.id };
      }
      if (latest?.status === "ready" || latest?.status === "failed") {
        return { status: latest.status, runId: run.id };
      }
      if (latest?.status === "archiving") return { status: "archiving", runId: run.id };
      return { status: "busy", runId: run.id };
    }
    if (error instanceof CodexPetArchiveDeferredError) {
      if (await releaseDeferredArchiveLease(ctx, error)) {
        return { status: "archiving", runId: run.id };
      }
      const latest = await deps.prisma.codexPetRun.findFirst({
        where: { id: run.id, projectId: run.project.id, userId: run.userId },
        select: { status: true, cancelRequested: true },
      });
      if (latest?.cancelRequested || latest?.status === "cancelled") {
        await finalizeCancellation(ctx);
        return { status: "cancelled", runId: run.id };
      }
      if (latest?.status === "ready" || latest?.status === "failed") {
        return { status: latest.status, runId: run.id };
      }
      return { status: "busy", runId: run.id };
    }
    if (error instanceof CodexPetLeaseLostError || controller.signal.reason instanceof CodexPetLeaseLostError) {
      const latest = await deps.prisma.codexPetRun.findFirst({ where: { id: run.id, projectId: run.project.id, userId: run.userId }, select: { status: true } });
      if (latest?.status === "ready" || latest?.status === "failed" || latest?.status === "cancelled") {
        return { status: latest.status, runId: run.id };
      }
      return { status: "busy", runId: run.id };
    }
    if (error instanceof CodexPetCancelledError || controller.signal.reason instanceof CodexPetCancelledError) {
      await finalizeCancellation(ctx);
      return { status: "cancelled", runId: run.id };
    }
    // Cancellation may be persisted just after an upstream/QA error but
    // before the monitor tick observes it. Re-read the row so that the
    // cancellation/refund policy wins that race instead of recording a
    // system failure.
    const latestBeforeFailure = await deps.prisma.codexPetRun.findFirst({ where: { id: run.id, projectId: run.project.id, userId: run.userId }, select: { cancelRequested: true, status: true } });
    if (latestBeforeFailure?.cancelRequested || latestBeforeFailure?.status === "cancelled") {
      await finalizeCancellation(ctx);
      return { status: "cancelled", runId: run.id };
    }
    await finalizeFailure(ctx, error);
    throw error;
  } finally {
    clearInterval(monitor);
    clearInterval(leaseHeartbeat);
    deps.signal?.removeEventListener("abort", abortFromParent);
  }
}
